import { isAbsolute } from 'node:path';
import { processRequestSchema, processResultSchema } from '../../contracts/process.js';
import { completed, rejected } from '../../contracts/operation-result.js';
import type { ProcessRunner } from '../../ports/process-runner.js';

/** Fetch origin's main branch and resolve the full local commit it just supplied. */
export function createMainBaseResolver(options: {
  executable: string;
  runner: ProcessRunner;
  environment: Readonly<Record<string, string | undefined>>;
}) {
  return {
    async resolve(root: string, signal?: AbortSignal) {
      if (!isAbsolute(root) || !isAbsolute(options.executable)) {
        return rejected('invalid_request', 'Main branch resolution requires absolute paths.');
      }

      const env: Record<string, string> = {};

      for (const key of [
        'PATH',
        'HOME',
        'USER',
        'XDG_CONFIG_HOME',
        'SSH_AUTH_SOCK',
        'SSH_AGENT_PID',
        'GIT_SSH_COMMAND',
        'GIT_ASKPASS',
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
          env[key] = value;
        }
      }

      env.GIT_TERMINAL_PROMPT = '0';
      const run = async (args: string[]) =>
        processResultSchema.parse(
          await options.runner.run(
            processRequestSchema.parse({
              schemaVersion: 1,
              executable: options.executable,
              cwd: root,
              args: ['--no-pager', ...args],
              env,
              timeoutMs: 60000,
              maxCaptureBytes: 65536,
            }),
            signal,
          ),
        );

      try {
        const fetch = await run([
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          '--',
          'origin',
          '+refs/heads/main:refs/remotes/origin/main',
        ]);

        if (
          fetch.outcome !== 'exited' ||
          fetch.exitCode !== 0 ||
          fetch.signal !== null ||
          fetch.error !== null ||
          fetch.shutdown.processGroup !== 'absent' ||
          !fetch.stdout.complete ||
          !fetch.stderr.complete
        ) {
          return rejected(
            'git_failed',
            'Could not fetch the latest origin/main. Check the origin remote and Git authentication.',
          );
        }

        const head = await run([
          'rev-parse',
          '--verify',
          '--end-of-options',
          'refs/remotes/origin/main^{commit}',
        ]);

        if (
          head.outcome !== 'exited' ||
          head.exitCode !== 0 ||
          head.signal !== null ||
          head.error !== null ||
          head.shutdown.processGroup !== 'absent' ||
          !head.stdout.complete ||
          !head.stderr.complete ||
          !/^[a-f0-9]{40}(?:[a-f0-9]{24})?\n$/.test(head.stdout.text)
        ) {
          return rejected('git_failed', 'Could not resolve the fetched origin/main commit.');
        }

        return completed(head.stdout.text.trim());
      } catch {
        return rejected(
          signal?.aborted ? 'cancelled' : 'git_failed',
          'Could not fetch and resolve the latest origin/main.',
        );
      }
    },
  };
}
