import { isAbsolute } from 'node:path';
import { processRequestSchema, processResultSchema } from '../../contracts/process.js';
import { completed, rejected } from '../../contracts/operation-result.js';
import type { ProcessRunner } from '../../ports/process-runner.js';

/** Ensure an explicitly selected full commit exists, fetching only from origin if needed. */
export function createBaseCommitFetcher(options: {
  executable: string;
  runner: ProcessRunner;
  environment: Readonly<Record<string, string | undefined>>;
}) {
  return {
    async ensure(root: string, sha: string, signal?: AbortSignal) {
      if (
        !isAbsolute(root) ||
        !isAbsolute(options.executable) ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)
      ) {
        return rejected('invalid_request', 'Select an absolute project root and full commit SHA.');
      }

      const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };

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

      try {
        const local = await run(['cat-file', '-e', `${sha}^{commit}`]);

        if (!complete(local)) {
          return rejected('git_failed', 'Could not inspect the selected base commit.');
        }

        if (local.outcome === 'exited' && local.exitCode === 0) {
          return completed(null);
        }

        const fetched = await run([
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          '--no-recurse-submodules',
          '--',
          'origin',
          sha,
        ]);

        if (!complete(fetched) || fetched.outcome !== 'exited' || fetched.exitCode !== 0) {
          return rejected('git_failed', 'Could not fetch the selected base commit from origin.');
        }

        const verified = await run(['cat-file', '-e', `${sha}^{commit}`]);

        return complete(verified) && verified.outcome === 'exited' && verified.exitCode === 0
          ? completed(null)
          : rejected('git_failed', 'The selected base commit remains unavailable after fetching.');
      } catch {
        return rejected(
          signal?.aborted ? 'cancelled' : 'git_failed',
          'Could not fetch the selected base commit.',
        );
      }
    },
  };
}
