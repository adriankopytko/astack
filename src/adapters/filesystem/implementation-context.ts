import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  instructionPathSchema,
  type InstructionReference,
} from '../../contracts/implementation-task.js';
import { completed, rejected } from '../../contracts/operation-result.js';
import type { ImplementationContextReader } from '../../ports/implementation.js';

/** Bounded, non-executing reads. Repository text never leaves this adapter; only exact byte digests do. */
export const nodeImplementationContextReader: ImplementationContextReader = {
  async read(input, signal) {
    try {
      if (
        !isAbsolute(input.root) ||
        (await realpath(input.root)) !== input.root ||
        input.paths.length > 8
      ) {
        return rejected(
          'implementation_context_invalid',
          'Select a canonical checkout and bounded repository instruction paths.',
        );
      }

      const references: InstructionReference[] = [];

      for (const candidate of input.paths) {
        if (signal?.aborted) {
          return rejected('cancelled', 'Instruction inspection was cancelled.');
        }

        const path = instructionPathSchema.parse(candidate);
        const components = path.split('/');
        let current = input.root;
        let missing = false;

        for (const component of components.slice(0, -1)) {
          current = join(current, component);

          try {
            const stat = await lstat(current);

            if (
              !stat.isDirectory() ||
              stat.isSymbolicLink() ||
              (await realpath(current)) !== current
            ) {
              throw new Error('unsafe instruction parent');
            }
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
              missing = true;
              break;
            }

            throw error;
          }
        }

        if (missing) {
          references.push({ path, digest: null });
          continue;
        }

        const absolute = join(input.root, path);
        let before;

        try {
          before = await lstat(absolute, { bigint: true });
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            references.push({ path, digest: null });
            continue;
          }

          throw error;
        }

        if (
          !before.isFile() ||
          before.nlink !== 1n ||
          before.size > 65_536n ||
          (await realpath(absolute)) !== absolute
        ) {
          throw new Error('unsafe instruction file');
        }

        const file = await open(
          absolute,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );

        try {
          const buffer = Buffer.alloc(65_537);
          let size = 0;

          while (size < buffer.length) {
            const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);

            if (bytesRead === 0) {
              break;
            }

            size += bytesRead;
          }

          const after = await file.stat({ bigint: true });

          if (
            size > 65_536 ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs ||
            (await realpath(absolute)) !== absolute ||
            (await realpath(input.root)) !== input.root
          ) {
            throw new Error('instruction changed');
          }

          new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
          references.push({
            path,
            digest: createHash('sha256').update(buffer.subarray(0, size)).digest('hex'),
          });
        } finally {
          await file.close();
        }
      }

      return signal?.aborted
        ? rejected('cancelled', 'Instruction inspection was cancelled.')
        : completed(references);
    } catch {
      return rejected(
        'implementation_context_invalid',
        'Repository instruction evidence is unsafe, oversized or changed; inspect the assigned checkout.',
      );
    }
  },
};
