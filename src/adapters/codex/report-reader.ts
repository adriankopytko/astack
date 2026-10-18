import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { completed, rejected } from '../../contracts/operation-result.js';
import type { RuntimeSession } from '../../contracts/runtime.js';
import type { RunReportReader } from '../../ports/runs.js';

const limit = 16 * 1024 * 1024;
/** Explicit host-selected local Codex JSONL, not terminal scraping or automatic transcript discovery. */
export function createCodexReportReader(options: {
  file: string;
  session: RuntimeSession;
}): RunReportReader {
  return {
    async read({ run, prompt }, signal) {
      const invalid = () =>
        rejected(
          'run_report_invalid',
          'Select an unchanged bounded Codex session with matching metadata, exact assignment and a final JSON response.',
        );
      const session = options.session;

      if (signal?.aborted) {
        return rejected('cancelled', 'Report collection was cancelled.');
      }

      if (
        !isAbsolute(options.file) ||
        session.phase !== 'ready' ||
        session.jobId !== run.job.job.id ||
        session.attemptId !== run.job.attempt.id ||
        session.effectId !== run.job.effect.intent.id ||
        session.space.checkoutId !== run.job.job.checkoutId ||
        !session.agent
      ) {
        return invalid();
      }

      try {
        const before = await lstat(options.file, { bigint: true });

        if (
          !before.isFile() ||
          before.isSymbolicLink() ||
          before.nlink !== 1n ||
          before.size > BigInt(limit)
        ) {
          return invalid();
        }

        const file = await open(
          options.file,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        let content: string;

        try {
          const bytes = Buffer.alloc(Number(before.size) + 1);
          let size = 0;

          while (size < bytes.length) {
            const read = await file.read(bytes, size, bytes.length - size, size);

            if (read.bytesRead === 0) {
              break;
            }

            size += read.bytesRead;
          }

          const after = await file.stat({ bigint: true });

          if (
            signal?.aborted ||
            size !== Number(before.size) ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.size !== before.size ||
            after.mtimeNs !== before.mtimeNs ||
            after.ctimeNs !== before.ctimeNs ||
            after.nlink !== 1n
          ) {
            return invalid();
          }

          content = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, size));
        } finally {
          await file.close();
        }

        if (!content.endsWith('\n')) {
          return invalid();
        }

        const lines = content.trimEnd().split('\n');
        const headerLine = lines.shift() ?? '';

        if (Buffer.byteLength(headerLine) > 1024 * 1024) {
          return invalid();
        }

        const header = JSON.parse(headerLine) as {
          type?: string;
          payload?: { id?: string; cwd?: string; timestamp?: string };
        };
        const metadata = header.payload;
        const startedAt = Date.parse(metadata?.timestamp ?? '');

        if (
          header.type !== 'session_meta' ||
          metadata?.cwd !== session.space.root ||
          !metadata.id ||
          !Number.isFinite(startedAt) ||
          startedAt < run.job.job.createdAt ||
          (session.agent.nativeSessionId !== null && metadata.id !== session.agent.nativeSessionId)
        ) {
          return invalid();
        }

        let assigned = false;
        let final: string | null = null;

        for (const line of lines) {
          if (signal?.aborted || Buffer.byteLength(line) > 1024 * 1024) {
            return invalid();
          }

          const item = JSON.parse(line) as {
            type?: string;
            payload?: {
              type?: string;
              role?: string;
              phase?: string;
              content?: { type?: string; text?: string }[];
            };
          };
          const message = item.payload;

          if (item.type !== 'response_item' || message?.type !== 'message') {
            continue;
          }

          if (message.role === 'user') {
            const exactAssignment =
              message.content?.some((part) => part.type === 'input_text' && part.text === prompt) ??
              false;

            if (assigned && exactAssignment) {
              return invalid();
            }

            assigned ||= exactAssignment;
            final = null;
          } else if (assigned && message.role === 'assistant' && message.phase === 'final_answer') {
            const output = message.content;

            if (
              !Array.isArray(output) ||
              output.length !== 1 ||
              output[0]?.type !== 'output_text' ||
              typeof output[0].text !== 'string' ||
              Buffer.byteLength(output[0].text) > 48000
            ) {
              return invalid();
            }

            final = output[0].text;
          }
        }

        return final === null ? invalid() : completed(JSON.parse(final) as unknown);
      } catch {
        return invalid();
      }
    },
  };
}
