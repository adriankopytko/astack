import { processRequestSchema, processResultSchema } from '../../contracts/process.js';
import { completed, rejected } from '../../contracts/operation-result.js';
import type { ProcessRunner } from '../../ports/process-runner.js';

/** Resolve only a GitHub-style origin; do not return raw remote URLs or credentials. */
export async function readGithubOrigin(root: string, executable: string, runner: ProcessRunner) {
  const result = processResultSchema.parse(
    await runner.run(
      processRequestSchema.parse({
        schemaVersion: 1,
        executable,
        cwd: root,
        args: ['config', '--get-all', 'remote.origin.url'],
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
        timeoutMs: 10000,
        maxCaptureBytes: 4096,
      }),
    ),
  );

  if (
    result.outcome !== 'exited' ||
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.error !== null ||
    result.shutdown.root !== 'exited' ||
    result.shutdown.processGroup !== 'absent' ||
    !result.stdout.complete ||
    result.stdout.truncated ||
    !result.stderr.complete ||
    result.stderr.truncated
  ) {
    return rejected('git_failed', 'Cannot infer the GitHub repository from origin; supply --repo.');
  }

  const remotes = result.stdout.text.trim().split('\n');

  if (remotes.length !== 1) {
    return rejected('invalid_request', 'The origin has multiple URLs; select --repo explicitly.');
  }

  const raw = remotes[0]!;
  let host: string;
  let path: string;

  try {
    if (raw.startsWith('https://') || raw.startsWith('ssh://')) {
      const url = new URL(raw);

      if (url.password || url.port || url.search || url.hash) {
        throw new Error('Invalid remote');
      }

      host = url.hostname;
      path = url.pathname.replace(/^\//, '');
    } else {
      const match = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(raw);

      if (!match) {
        throw new Error('Invalid remote');
      }

      host = match[1]!;
      path = match[2]!;
    }
  } catch {
    return rejected(
      'invalid_request',
      'Cannot infer the GitHub repository from origin; supply --repo.',
    );
  }

  const repository = path.replace(/\.git$/, '').toLowerCase();
  host = host.toLowerCase();

  if (
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ||
    host.includes('..') ||
    !/^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/.test(repository)
  ) {
    return rejected(
      'invalid_request',
      'Cannot infer the GitHub repository from origin; supply --repo.',
    );
  }

  return completed({ host, repository });
}
