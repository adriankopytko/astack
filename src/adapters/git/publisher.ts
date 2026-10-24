import { isAbsolute } from 'node:path';
import { completed, rejected } from '../../contracts/operation-result.js';
import { processRequestSchema, processResultSchema } from '../../contracts/process.js';
import { pushIntentSchema, pushReceiptSchema, type PushIntent } from '../../contracts/handoff.js';
import type { ProcessRunner } from '../../ports/process-runner.js';
import type { GitPublisher } from '../../ports/handoff.js';

class PushFailure extends Error {}
/** Fixed HTTPS destination, gh credentials, no hooks/config rewrites, and one leased ref update. */
export function createGitPublisher(options: {
  executable: string;
  githubExecutable: string;
  runner: ProcessRunner;
  environment: Readonly<Record<string, string>>;
  now: () => number;
}): GitPublisher {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const environment: Record<string, string> = {};

  for (const key of [
    'HOME',
    'PATH',
    'GH_CONFIG_DIR',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    const value = options.environment[key];

    if (value !== undefined) {
      environment[key] = value;
    }
  }

  async function run(
    root: string,
    args: string[],
    signal?: AbortSignal,
    credentials = true,
    codes = [0],
  ) {
    if (
      !isAbsolute(options.executable) ||
      !isAbsolute(options.githubExecutable) ||
      /[\r\n\0]/.test(options.githubExecutable) ||
      !isAbsolute(root)
    ) {
      throw new PushFailure();
    }

    const result = processResultSchema.parse(
      await options.runner.run(
        processRequestSchema.parse({
          schemaVersion: 1,
          executable: options.executable,
          cwd: root,
          args: [
            '--no-pager',
            '--no-lazy-fetch',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'core.fsmonitor=false',
            '-c',
            'submodule.recurse=false',
            '-c',
            'push.gpgSign=false',
            ...(credentials
              ? [
                  '-c',
                  'credential.helper=',
                  '-c',
                  `credential.helper=!${quote(options.githubExecutable)} auth git-credential`,
                ]
              : []),
            ...args,
          ],
          env: {
            ...environment,
            PATH: environment.PATH ?? '/usr/bin:/bin',
            LC_ALL: 'C',
            GH_PROMPT_DISABLED: '1',
            GH_DEBUG: '',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_OPTIONAL_LOCKS: '0',
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: '/usr/bin/false',
            GIT_ALLOW_PROTOCOL: 'https',
            GIT_NO_LAZY_FETCH: '1',
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_GRAFT_FILE: '/dev/null',
          },
          timeoutMs: 30000,
          maxCaptureBytes: 131072,
        }),
        signal,
      ),
    );

    if (
      result.outcome !== 'exited' ||
      !codes.includes(result.exitCode ?? -1) ||
      result.error !== null ||
      result.signal !== null ||
      result.shutdown.processGroup !== 'absent' ||
      !result.stdout.complete ||
      result.stdout.truncated ||
      !result.stderr.complete ||
      result.stderr.truncated ||
      result.stdout.text.includes('\uFFFD')
    ) {
      throw new PushFailure();
    }

    return result;
  }

  async function configuration(root: string, signal?: AbortSignal) {
    const config = await run(
      root,
      ['config', '--includes', '--null', '--name-only', '--list'],
      signal,
      false,
    );
    const names = config.stdout.text
      .split('\0')
      .filter(Boolean)
      .map((name) => name.toLowerCase());

    if (
      names.some((name) =>
        /^(?:include\.|includeif\.|url\.|credential\.|http\.|protocol\.|push\.(?!gpgsign$)|sendpack\.|gpg\.|core\.(?:sshcommand|gitproxy|askpass|alternaterefscommand)$)/.test(
          name,
        ),
      )
    ) {
      throw new PushFailure();
    }
  }

  const url = (intent: PushIntent) =>
    `https://${intent.repository.host}/${intent.repository.repository}.git`;
  async function observe(root: string, intent: PushIntent, signal?: AbortSignal) {
    const ref = `refs/heads/${intent.branch}`;
    const result = await run(root, ['ls-remote', '--refs', url(intent), ref], signal);
    const lines = result.stdout.text.split('\n').filter(Boolean);

    if (lines.length === 0) {
      return null;
    }

    const parts = lines[0]?.split('\t');

    if (
      lines.length !== 1 ||
      parts?.length !== 2 ||
      parts[1] !== ref ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parts[0] ?? '')
    ) {
      throw new PushFailure();
    }

    return parts[0] ?? null;
  }

  function failure(signal?: AbortSignal) {
    return rejected(
      signal?.aborted ? 'cancelled' : 'handoff_blocked',
      'Git publication evidence or configuration could not be verified; inspect trusted configuration and the exact remote ref.',
    );
  }

  return {
    async inspect(input, signal) {
      try {
        const intent = pushIntentSchema.parse(input.intent);
        await configuration(input.root, signal);
        const sha = await observe(input.root, intent, signal);

        if (sha === null) {
          return completed(null);
        }

        if (sha !== intent.sha) {
          return rejected(
            'handoff_target_changed',
            'Remote branch does not identify the requested commit.',
          );
        }

        return completed(
          pushReceiptSchema.parse({
            repository: intent.repository,
            branch: intent.branch,
            sha,
            observedAt: options.now(),
          }),
        );
      } catch {
        return failure(signal);
      }
    },
    async push(input, signal) {
      let sent = false;

      try {
        const intent = pushIntentSchema.parse(input.intent);
        await configuration(input.root, signal);
        const before = await observe(input.root, intent, signal);

        if (before !== intent.sha) {
          if (before !== intent.expectedHead) {
            return rejected(
              'handoff_target_changed',
              'Remote branch differs from its explicit expected head.',
            );
          }

          if (before !== null) {
            const ancestor = await run(
              input.root,
              ['merge-base', '--is-ancestor', before, intent.sha],
              signal,
              false,
              [0, 1],
            );

            if (ancestor.exitCode !== 0) {
              return rejected(
                'handoff_blocked',
                'Only verified fast-forward publication is permitted.',
              );
            }
          }

          if (signal?.aborted) {
            return failure(signal);
          }

          const ref = `refs/heads/${intent.branch}`;
          sent = true;
          await run(
            input.root,
            [
              'push',
              '--porcelain',
              '--no-verify',
              '--no-follow-tags',
              '--recurse-submodules=no',
              `--force-with-lease=${ref}:${intent.expectedHead ?? ''}`,
              url(intent),
              `${intent.sha}:${ref}`,
            ],
            signal,
          );
        }

        const after = await observe(input.root, intent, signal);

        if (after !== intent.sha) {
          throw new PushFailure();
        }

        return completed(
          pushReceiptSchema.parse({
            repository: intent.repository,
            branch: intent.branch,
            sha: after,
            observedAt: options.now(),
          }),
        );
      } catch {
        return sent
          ? {
              schemaVersion: 1,
              outcome: 'uncertain',
              error: {
                code: 'git_write_uncertain',
                message:
                  'Git push may have occurred; inspect the same intent without repeating the write.',
              },
            }
          : failure(signal);
      }
    },
  };
}
