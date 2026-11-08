import { isAbsolute } from 'node:path';
import { completed, rejected } from '../../contracts/operation-result.js';
import { processRequestSchema, processResultSchema } from '../../contracts/process.js';
import type { ReviewTarget } from '../../contracts/review-task.js';
import type { ProcessRunner } from '../../ports/process-runner.js';

/** Fetch only the explicitly targeted PR head when its commit is not already local. */
export function createReviewCommitFetcher(options: {
  executable: string;
  githubExecutable: string | null;
  runner: ProcessRunner;
  environment: Readonly<Record<string, string>>;
}) {
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

  return {
    async ensure(target: ReviewTarget, root: string, signal?: AbortSignal) {
      if (!isAbsolute(options.executable) || !isAbsolute(root)) {
        return rejected(
          'invalid_request',
          'Review commit fetch requires a trusted Git executable and project root.',
        );
      }

      const run = async (args: string[], credentials = false) =>
        processResultSchema.parse(
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
                ...(credentials && options.githubExecutable
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
              timeoutMs: 60_000,
              maxCaptureBytes: 1_048_576,
            }),
            signal,
          ),
        );
      const complete = (value: Awaited<ReturnType<typeof run>>) =>
        value.outcome === 'exited' &&
        value.signal === null &&
        value.error === null &&
        value.shutdown.root === 'exited' &&
        value.shutdown.processGroup === 'absent' &&
        value.stdout.complete &&
        !value.stdout.truncated &&
        value.stderr.complete &&
        !value.stderr.truncated;
      const local = await run(['cat-file', '-e', `${target.sha}^{commit}`]);

      if (!complete(local)) {
        return rejected('git_failed', 'The requested review commit could not be inspected.');
      }

      if (local.outcome === 'exited' && local.exitCode === 0) {
        return completed(null);
      }

      if (
        !options.githubExecutable ||
        !isAbsolute(options.githubExecutable) ||
        /[\r\n\0]/.test(options.githubExecutable)
      ) {
        return rejected(
          'github_unavailable',
          'A trusted GitHub CLI is required to fetch the review commit.',
        );
      }

      const config = await run(['config', '--null', '--list', '--includes']);

      if (
        !complete(config) ||
        config.outcome !== 'exited' ||
        config.exitCode !== 0 ||
        config.stdout.text
          .split('\0')
          .some((entry) =>
            /^(?:include\.|includeif\.|url\.|credential\.|http\.|protocol\.|core\.(?:sshcommand|gitproxy|askpass|alternaterefscommand)$)/i.test(
              entry.split('\n')[0] ?? '',
            ),
          )
      ) {
        return rejected(
          'git_failed',
          'Repository Git configuration prevents a direct review fetch.',
        );
      }

      const fetched = await run(
        [
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          '--no-recurse-submodules',
          '--',
          `https://${target.host}/${target.repository}.git`,
          `refs/pull/${target.number}/head`,
        ],
        true,
      );

      if (!complete(fetched) || fetched.outcome !== 'exited' || fetched.exitCode !== 0) {
        return rejected(
          'git_failed',
          'The review commit could not be fetched from its pull request.',
        );
      }

      const verified = await run(['cat-file', '-e', `${target.sha}^{commit}`]);

      return complete(verified) && verified.outcome === 'exited' && verified.exitCode === 0
        ? completed(null)
        : rejected(
            'review_target_changed',
            'The fetched pull request does not contain the requested review commit.',
          );
    },
  };
}
