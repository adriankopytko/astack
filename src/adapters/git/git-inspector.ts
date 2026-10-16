import { realpath, stat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  gitRepositoryInspectionSchema,
  type GitInspectionRequest,
  type GitInspectionResult,
} from '../../contracts/git.js';
import { completed, rejected, type OperationErrorCode } from '../../contracts/operation-result.js';
import { processRequestSchema, processResultSchema } from '../../contracts/process.js';
import {
  GitInspectionError,
  gitLine,
  parseGitRefs,
  parseGitRemotes,
  parseGitStatus,
  parseGitWorktrees,
  requireGitFact,
  selectGitBase,
} from '../../core/git-output.js';
import type { GitInspector } from '../../ports/git-inspector.js';
import type { ProcessRunner } from '../../ports/process-runner.js';

export interface GitInspectorOptions {
  /** Absolute, trusted Git executable. No ambient executable lookup or environment is used. */
  executable: string;
  runner: ProcessRunner;
  /** Overall command budget; filesystem calls and process teardown may add latency. */
  timeoutMs?: number;
  /** Per-stream capture ceiling for each command; incomplete output rejects the whole read. */
  maxCaptureBytes?: number;
}

const messages: Partial<Record<OperationErrorCode, string>> = {
  cancelled: 'Git inspection was cancelled.',
  invalid_request: 'Git inspector configuration does not match the execution contract.',
  path_unavailable: 'Selected path or Git directory is missing, inaccessible, or not a directory.',
  not_git_repository: 'Selected directory is not inside a Git repository.',
  unsupported_repository:
    'Select a working checkout; bare repositories and Git metadata directories are unsupported.',
  unsupported_platform: 'Git inspection requires a supported process runner platform.',
  git_unavailable:
    'The selected Git executable could not be started; check its path and permissions.',
  git_failed:
    'Git could not complete inspection; check repository access, ownership, configuration, and Git compatibility.',
  git_timed_out: 'Git inspection exceeded its command budget.',
  git_output_incomplete:
    'Git output was incomplete or exceeded the capture limit; increase the budget and retry.',
  invalid_git_output:
    'Git returned invalid or unsupported output; complete UTF-8 machine-readable facts are required.',
  base_ref_not_found:
    'Base ref or full object ID was not found locally; select an existing explicit ref.',
  base_ref_ambiguous: 'Base ref matches multiple names; select a fully qualified ref.',
  base_ref_not_commit: 'Base ref does not resolve to a commit.',
  repository_changed:
    'Repository identity, refs, or checkout state changed during inspection; inspect again.',
};

function fail(code: OperationErrorCode): never {
  throw new GitInspectionError(code);
}

async function anchor(path: string): Promise<{ path: string; info: BigIntStats }> {
  requireGitFact(isAbsolute(path) && !path.includes('\0'));

  try {
    const canonical = await realpath(path);
    const info = await stat(canonical, { bigint: true });

    if (!info.isDirectory()) {
      return fail('path_unavailable');
    }

    return { path: canonical, info };
  } catch {
    return fail('path_unavailable');
  }
}

async function recheck(previous: Awaited<ReturnType<typeof anchor>>): Promise<void> {
  const current = await anchor(previous.path);

  if (
    current.path !== previous.path ||
    current.info.dev !== previous.info.dev ||
    current.info.ino !== previous.info.ino
  ) {
    fail('repository_changed');
  }
}

export function createGitInspector(options: GitInspectorOptions): GitInspector {
  // Capture configuration now; construction itself performs no filesystem or provider work.
  const { runner, executable, timeoutMs = 10_000, maxCaptureBytes = 1024 * 1024 } = options;

  return {
    async inspect(
      request: GitInspectionRequest,
      signal?: AbortSignal,
    ): Promise<GitInspectionResult> {
      try {
        if (signal?.aborted) {
          fail('cancelled');
        }

        if (
          !isAbsolute(executable) ||
          !Number.isInteger(timeoutMs) ||
          timeoutMs < 1 ||
          timeoutMs > 120_000
        ) {
          fail('invalid_request');
        }

        const initial = processRequestSchema.safeParse({
          schemaVersion: 1,
          executable,
          args: [],
          cwd: request.path,
          env: {
            PATH: '/usr/bin:/bin',
            LC_ALL: 'C',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_OPTIONAL_LOCKS: '0',
            GIT_TERMINAL_PROMPT: '0',
            GIT_NO_LAZY_FETCH: '1',
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_ATTR_NOSYSTEM: '1',
            GIT_ALLOW_PROTOCOL: '',
          },
          timeoutMs,
          maxCaptureBytes,
        });

        if (!initial.success) {
          fail('invalid_request');
        }

        const selected = await anchor(request.path);
        const deadline = performance.now() + timeoutMs;
        const run = async (args: string[], accepted = [0]) => {
          if (signal?.aborted) {
            fail('cancelled');
          }

          const remaining = Math.ceil(deadline - performance.now());

          if (remaining <= 0) {
            fail('git_timed_out');
          }

          const decoded = processResultSchema.safeParse(
            await runner.run(
              {
                ...initial.data,
                cwd: selected.path,
                timeoutMs: remaining,
                args: [
                  '--no-pager',
                  '--no-lazy-fetch',
                  '--no-optional-locks',
                  '-c',
                  'core.fsmonitor=false',
                  '-c',
                  'core.hooksPath=/dev/null',
                  '-c',
                  'core.untrackedCache=false',
                  ...args,
                ],
              },
              signal,
            ),
          );

          if (!decoded.success) {
            fail('invalid_git_output');
          }

          const result = decoded.data;

          if (signal?.aborted || result.outcome === 'cancelled') {
            fail('cancelled');
          }

          if (result.outcome === 'rejected') {
            fail(
              result.error.code === 'unsupported_platform' ? 'unsupported_platform' : 'git_failed',
            );
          }

          if (result.outcome === 'timed_out') {
            fail('git_timed_out');
          }

          if (result.outcome === 'spawn_failed') {
            fail('git_unavailable');
          }

          if (
            result.outcome !== 'exited' ||
            result.shutdown.root !== 'exited' ||
            result.shutdown.processGroup !== 'absent' ||
            result.signal !== null
          ) {
            fail('git_failed');
          }

          if (
            !result.stdout.complete ||
            result.stdout.truncated ||
            !result.stderr.complete ||
            result.stderr.truncated
          ) {
            fail('git_output_incomplete');
          }

          if (
            result.stdout.text.includes('\uFFFD') ||
            Buffer.byteLength(result.stdout.text) !== result.stdout.capturedBytes
          ) {
            fail('invalid_git_output');
          }

          if (result.exitCode === null || !accepted.includes(result.exitCode)) {
            fail('git_failed');
          }

          return { text: result.stdout.text, stderr: result.stderr.text, code: result.exitCode };
        };

        const probe = await run(['rev-parse', '--is-inside-work-tree'], [0, 128]);

        if (probe.code !== 0) {
          fail(
            probe.stderr.startsWith('fatal: not a git repository')
              ? 'not_git_repository'
              : 'git_failed',
          );
        }

        if (gitLine(probe.text) !== 'true') {
          fail('unsupported_repository');
        }

        const rootOutput = await run(['rev-parse', '--path-format=absolute', '--show-toplevel']);
        const gitOutput = await run(['rev-parse', '--path-format=absolute', '--git-dir']);
        const commonOutput = await run(['rev-parse', '--path-format=absolute', '--git-common-dir']);
        const root = await anchor(gitLine(rootOutput.text));
        const gitDirectory = await anchor(gitLine(gitOutput.text));
        const common = await anchor(gitLine(commonOutput.text));
        const format = gitLine((await run(['rev-parse', '--show-object-format=storage'])).text);
        const statusArgs = [
          'status',
          '--porcelain=v2',
          '--branch',
          '-z',
          '--untracked-files=all',
          '--ignore-submodules=none',
          '--find-renames=50%',
          '--no-ahead-behind',
        ];
        const refsArgs = [
          'for-each-ref',
          '--sort=refname',
          '--format=%(refname)%00%(objectname)%00%(objecttype)',
        ];
        const worktreeArgs = ['worktree', 'list', '--porcelain', '-z'];
        const statusOutput = (await run(statusArgs)).text;
        const { head, entries } = parseGitStatus(statusOutput);
        const refsOutput = (await run(refsArgs)).text;
        const refs = parseGitRefs(refsOutput);
        let base = null;

        if (request.baseRef !== undefined) {
          const selectedRef = selectGitBase(request.baseRef, refs, head);
          const namedRef = refs.find((ref) => ref.name === selectedRef);
          const object = namedRef?.objectId ?? selectedRef;
          const exists = await run(['cat-file', '-t', object], [0, 128]);

          if (exists.code !== 0) {
            fail('base_ref_not_found');
          }

          const resolved = await run(
            ['rev-parse', '--verify', '--end-of-options', `${object}^{commit}`],
            [0, 128],
          );

          if (resolved.code !== 0) {
            fail('base_ref_not_commit');
          }

          base = {
            requestedRef: request.baseRef,
            fullRef: namedRef?.name ?? null,
            commit: gitLine(resolved.text),
          };
        }

        const remoteOutput = await run(
          ['config', '--null', '--get-regexp', '^remote[.].*[.](url|pushurl)$'],
          [0, 1],
        );
        requireGitFact(remoteOutput.code === 0 || remoteOutput.text === '');
        const worktreeOutput = (await run(worktreeArgs)).text;
        const value = gitRepositoryInspectionSchema.safeParse({
          repository: { commonDirectory: common.path, objectFormat: format },
          checkout: { rootPath: root.path, gitDirectory: gitDirectory.path, head },
          refs,
          base,
          remotes: parseGitRemotes(remoteOutput.text),
          worktrees: parseGitWorktrees(worktreeOutput),
          status: { clean: entries.length === 0, entries },
        });

        if (!value.success) {
          fail('invalid_git_output');
        }

        if (
          (await run(statusArgs)).text !== statusOutput ||
          (await run(refsArgs)).text !== refsOutput ||
          (await run(worktreeArgs)).text !== worktreeOutput ||
          (await run(['rev-parse', '--path-format=absolute', '--show-toplevel'])).text !==
            rootOutput.text ||
          (await run(['rev-parse', '--path-format=absolute', '--git-dir'])).text !==
            gitOutput.text ||
          (await run(['rev-parse', '--path-format=absolute', '--git-common-dir'])).text !==
            commonOutput.text
        ) {
          fail('repository_changed');
        }

        await recheck(selected);
        await recheck(root);
        await recheck(gitDirectory);
        await recheck(common);

        if (signal?.aborted) {
          fail('cancelled');
        }

        return completed(value.data);
      } catch (error) {
        const code = signal?.aborted
          ? 'cancelled'
          : error instanceof GitInspectionError
            ? error.code
            : 'git_failed';

        return rejected(code, messages[code] ?? 'Git inspection could not be completed.');
      }
    },
  };
}
