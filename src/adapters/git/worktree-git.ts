import { isAbsolute } from 'node:path';
import { completed, rejected, type OperationResult } from '../../contracts/operation-result.js';
import {
  processRequestSchema,
  processResultSchema,
  type ProcessResult,
} from '../../contracts/process.js';
import { GitInspectionError, gitNulRecords } from '../../core/git-output.js';
import type { WorktreeGit } from '../../ports/worktrees.js';
import type { GitInspectorOptions } from './git-inspector.js';

export function createWorktreeGit(options: GitInspectorOptions): WorktreeGit {
  const { executable, runner, timeoutMs = 30_000, maxCaptureBytes = 1024 * 1024 } = options;
  const run = async (cwd: string, args: string[], signal?: AbortSignal): Promise<ProcessResult> => {
    const request = processRequestSchema.safeParse({
      schemaVersion: 1,
      executable,
      cwd,
      args: [
        '--no-pager',
        '--no-lazy-fetch',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        '-c',
        'submodule.recurse=false',
        '-c',
        'checkout.workers=1',
        ...args,
      ],
      env: {
        PATH: '/usr/bin:/bin',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
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

    if (!isAbsolute(executable) || !request.success || timeoutMs > 120_000) {
      return rejected(
        'invalid_request',
        'Worktree Git configuration does not match the execution contract.',
      );
    }

    return processResultSchema.parse(await runner.run(request.data, signal));
  };

  const read = async (cwd: string, args: string[], signal?: AbortSignal, codes = [0]) => {
    const result = await run(cwd, args, signal);

    if (result.outcome === 'rejected') {
      throw new GitInspectionError(result.error.code);
    }

    if (
      !result.stdout.complete ||
      result.stdout.truncated ||
      !result.stderr.complete ||
      result.stderr.truncated
    ) {
      throw new GitInspectionError('git_output_incomplete');
    }

    if (
      result.stdout.text.includes('\uFFFD') ||
      Buffer.byteLength(result.stdout.text) !== result.stdout.capturedBytes
    ) {
      throw new GitInspectionError('invalid_git_output');
    }

    if (
      result.outcome !== 'exited' ||
      result.signal !== null ||
      !codes.includes(result.exitCode ?? -1) ||
      result.shutdown.processGroup !== 'absent' ||
      !result.stdout.complete ||
      result.stdout.truncated ||
      !result.stderr.complete ||
      result.stderr.truncated ||
      result.stdout.text.includes('\uFFFD') ||
      Buffer.byteLength(result.stdout.text) !== result.stdout.capturedBytes
    ) {
      throw new GitInspectionError(
        result.outcome === 'timed_out'
          ? 'git_timed_out'
          : result.outcome === 'cancelled'
            ? 'cancelled'
            : result.outcome === 'spawn_failed'
              ? 'git_unavailable'
              : 'git_failed',
      );
    }

    return result;
  };

  const readFailure = (error: unknown, signal?: AbortSignal) =>
    rejected(
      signal?.aborted
        ? 'cancelled'
        : error instanceof GitInspectionError
          ? error.code
          : 'git_failed',
      signal?.aborted
        ? 'Worktree Git read was cancelled.'
        : 'Complete worktree Git evidence could not be read.',
    );

  return {
    async preflight(intent, signal): Promise<OperationResult<null>> {
      try {
        const filters = await read(
          intent.sourceRoot,
          ['config', '--null', '--get-regexp', '^filter[.].*[.](clean|smudge|process)$'],
          signal,
          [0, 1],
        );
        const sparse = await read(
          intent.sourceRoot,
          ['config', '--bool', '--get', 'core.sparseCheckout'],
          signal,
          [0, 1],
        );

        if (
          gitNulRecords(filters.stdout.text).some(
            (record) => record.slice(record.indexOf('\n') + 1) !== '',
          ) ||
          sparse.stdout.text.trim() === 'true'
        ) {
          return rejected(
            'worktree_configuration_unsupported',
            'Configured content filters or sparse checkout require an explicit future execution profile.',
          );
        }

        const resolved = await read(
          intent.sourceRoot,
          ['rev-parse', '--verify', '--end-of-options', `${intent.baseCommit}^{commit}`],
          signal,
        );

        if (resolved.stdout.text !== `${intent.baseCommit}\n`) {
          return rejected(
            'base_ref_not_commit',
            'Supply a full local commit SHA, not an annotated tag object.',
          );
        }

        return completed(null);
      } catch (error) {
        return readFailure(error, signal);
      }
    },
    create: (intent, signal) =>
      run(
        intent.sourceRoot,
        [
          'worktree',
          'add',
          '-b',
          intent.branch.slice('refs/heads/'.length),
          '--',
          intent.checkoutPath,
          intent.baseCommit,
        ],
        signal,
      ),
    remove: (intent, signal) =>
      run(intent.sourceRoot, ['worktree', 'remove', '--', intent.checkoutPath], signal),
    async ignored(intent, signal): Promise<OperationResult<boolean>> {
      try {
        const result = await read(
          intent.checkoutPath,
          ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--'],
          signal,
        );

        return completed(gitNulRecords(result.stdout.text).length !== 0);
      } catch (error) {
        return readFailure(error, signal);
      }
    },
  };
}
