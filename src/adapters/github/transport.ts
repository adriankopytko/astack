import { isAbsolute } from 'node:path';
import { processRequestSchema, processResultSchema } from '../../contracts/process.js';
import type { OperationErrorCode } from '../../contracts/operation-result.js';
import type { ProcessRunner } from '../../ports/process-runner.js';

export interface GhOptions {
  executable: string;
  runner: ProcessRunner;
  environment: Readonly<Record<string, string>>;
  now: () => number;
  timeoutMs?: number;
  maxPages?: number;
}
export class GhFailure extends Error {
  constructor(
    readonly code: OperationErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super('GitHub operation did not produce verified evidence.');
  }
}
export function ghFailure(error: unknown) {
  return {
    schemaVersion: 1 as const,
    outcome: 'rejected' as const,
    error: {
      code: error instanceof GhFailure ? error.code : ('github_invalid_output' as const),
      message:
        'GitHub operation did not produce complete, matching evidence; inspect before retrying.',
      ...(error instanceof GhFailure && error.retryAfterMs !== undefined
        ? { retryAfterMs: error.retryAfterMs }
        : {}),
    },
  };
}

/** One bounded operation budget; no sleeps, retries, global discovery or diagnostic retention. */
export function createGhSession(options: GhOptions, root: string, signal?: AbortSignal) {
  const duration = options.timeoutMs ?? 30000;
  const started = options.now();
  const maxPages = options.maxPages ?? 20;

  if (
    !isAbsolute(options.executable) ||
    !isAbsolute(root) ||
    !Number.isInteger(duration) ||
    duration < 1 ||
    duration > 300000 ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 100
  ) {
    throw new GhFailure('github_unavailable');
  }

  async function command(args: string[], codes = [0]): Promise<string> {
    const now = options.now();
    const remaining = started + duration - now;

    if (signal?.aborted) {
      throw new GhFailure('cancelled');
    }

    if (!Number.isSafeInteger(now) || now < started || remaining <= 0) {
      throw new GhFailure('github_timed_out');
    }

    const result = processResultSchema.parse(
      await options.runner.run(
        processRequestSchema.parse({
          schemaVersion: 1,
          executable: options.executable,
          args,
          cwd: root,
          env: {
            ...options.environment,
            GH_PROMPT_DISABLED: '1',
            GH_PAGER: 'cat',
            NO_COLOR: '1',
            GH_DEBUG: '',
            GH_FORCE_TTY: '',
          },
          timeoutMs: Math.min(remaining, 10000),
          maxCaptureBytes: 1024 * 1024,
        }),
        signal,
      ),
    );

    if (result.outcome === 'rejected') {
      throw new GhFailure('github_unavailable');
    }

    if (result.outcome === 'timed_out') {
      throw new GhFailure('github_timed_out');
    }

    if (result.outcome === 'cancelled') {
      throw new GhFailure('cancelled');
    }

    if (
      result.outcome !== 'exited' ||
      result.signal !== null ||
      result.shutdown.processGroup !== 'absent' ||
      result.error !== null ||
      !result.stdout.complete ||
      result.stdout.truncated ||
      !result.stderr.complete ||
      result.stderr.truncated
    ) {
      throw new GhFailure('github_failed');
    }

    if (!codes.includes(result.exitCode ?? -1)) {
      // gh api returns complete HTTP response evidence even on nonzero HTTP-error exits.
      const status = /^HTTP\/\S+ (\d{3})/.exec(result.stdout.text);

      if (!args.includes('--include') || !status || Number(status[1]) < 400) {
        throw new GhFailure(result.exitCode === 4 ? 'github_auth_required' : 'github_failed');
      }
    }

    return result.stdout.text;
  }

  async function api(
    host: string,
    path: string,
    method = 'GET',
    bodyPath?: string,
  ): Promise<unknown> {
    const text = await command([
      'api',
      '--hostname',
      host,
      '--method',
      method,
      '--include',
      '--header',
      'Accept: application/vnd.github+json',
      '--header',
      'X-GitHub-Api-Version: 2022-11-28',
      ...(bodyPath ? ['--input', bodyPath] : []),
      path,
    ]);
    const match = /^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n((?:[^\r\n]+\r?\n)*)\r?\n([\s\S]*)$/.exec(text);

    if (!match) {
      throw new GhFailure('github_invalid_output');
    }

    const status = Number(match[1]);
    const headers = new Map(
      (match[2] ?? '')
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => {
          const colon = line.indexOf(':');

          if (colon <= 0) {
            throw new GhFailure('github_invalid_output');
          }

          return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
        }),
    );
    let rateMessage = false;

    if (status === 403) {
      try {
        const failure: unknown = JSON.parse(match[3] ?? '');
        rateMessage =
          typeof failure === 'object' &&
          failure !== null &&
          'message' in failure &&
          typeof failure.message === 'string' &&
          failure.message.toLowerCase().includes('rate limit');
      } catch {
        rateMessage = false;
      }
    }

    const rateLimited =
      status === 429 ||
      (status === 403 &&
        (headers.get('x-ratelimit-remaining') === '0' ||
          headers.has('retry-after') ||
          rateMessage));

    if (status < 200 || status >= 300) {
      let retryAfterMs: number | undefined;
      const retry = headers.get('retry-after');
      const reset = headers.get('x-ratelimit-reset');

      if (retry && /^\d+$/.test(retry)) {
        retryAfterMs = Math.min(Number(retry) * 1000, 86400000);
      } else if (reset && /^\d+$/.test(reset)) {
        retryAfterMs = Math.min(Math.max(0, Number(reset) * 1000 - options.now()), 86400000);
      }

      throw new GhFailure(
        rateLimited
          ? 'github_rate_limited'
          : status === 401
            ? 'github_auth_required'
            : status === 403
              ? 'github_forbidden'
              : status === 404
                ? 'github_not_found'
                : status === 409 || status === 422
                  ? 'github_conflict'
                  : 'github_failed',
        retryAfterMs,
      );
    }

    return JSON.parse(match[3] ?? '') as unknown;
  }

  async function pages(
    host: string,
    path: string,
    select: (value: unknown) => unknown[] = (value) => {
      if (!Array.isArray(value)) {
        throw new GhFailure('github_invalid_output');
      }

      return value as unknown[];
    },
  ): Promise<unknown[]> {
    const all: unknown[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const items = select(
        await api(host, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`),
      );

      if (items.length > 100) {
        throw new GhFailure('github_invalid_output');
      }

      all.push(...items);

      if (items.length < 100) {
        return all;
      }
    }

    throw new GhFailure('github_limit_exceeded');
  }

  return { command, api, pages };
}
