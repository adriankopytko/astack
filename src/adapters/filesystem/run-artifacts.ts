import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { artifactReferenceSchema } from '../../contracts/runs.js';
import { completed, rejected } from '../../contracts/operation-result.js';
import type { RunArtifactReader } from '../../ports/runs.js';
/** References point into retained owned work, not a copied immutable artifact archive. */
export const nodeRunArtifactReader: RunArtifactReader = {
  async inspect(input, signal) {
    try {
      if (input.artifacts.length > 8 || (await realpath(input.root)) !== input.root) {
        throw new Error('Unsafe root');
      }

      let total = 0;

      for (const item of input.artifacts) {
        const reference = artifactReferenceSchema.parse(item);
        total += reference.size;

        if (total > 16 * 1024 * 1024 || signal?.aborted) {
          throw new Error('Read limit');
        }

        const components = reference.path.split('/');
        let parent = input.root;

        for (const component of components.slice(0, -1)) {
          parent = join(parent, component);
          const info = await lstat(parent);

          if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(parent)) !== parent) {
            throw new Error('Unsafe parent');
          }
        }

        const path = join(input.root, reference.path);
        const before = await lstat(path, { bigint: true });

        if (
          !before.isFile() ||
          before.nlink !== 1n ||
          before.size !== BigInt(reference.size) ||
          (await realpath(path)) !== path
        ) {
          throw new Error('Unsafe artifact');
        }

        const file = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );

        try {
          const hash = createHash('sha256');
          const buffer = Buffer.alloc(65536);
          let size = 0;

          while (true) {
            if (signal?.aborted) {
              throw new Error('Cancelled');
            }

            const { bytesRead } = await file.read(
              buffer,
              0,
              Math.min(buffer.length, reference.size - size + 1),
              size,
            );

            if (bytesRead === 0) {
              break;
            }

            size += bytesRead;

            if (size > reference.size) {
              throw new Error('Artifact grew');
            }

            hash.update(buffer.subarray(0, bytesRead));
          }

          const after = await file.stat({ bigint: true });
          const leaf = await lstat(path, { bigint: true });

          if (
            size !== reference.size ||
            hash.digest('hex') !== reference.digest ||
            !after.isFile() ||
            after.nlink !== 1n ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs ||
            leaf.dev !== after.dev ||
            leaf.ino !== after.ino ||
            (await realpath(path)) !== path ||
            (await realpath(input.root)) !== input.root
          ) {
            throw new Error('Artifact changed');
          }
        } finally {
          await file.close();
        }
      }

      return completed(input.artifacts);
    } catch {
      return signal?.aborted
        ? rejected('cancelled', 'Artifact inspection was cancelled.')
        : rejected(
            'run_report_invalid',
            'Artifact references must match bounded regular files in the owned checkout.',
          );
    }
  },
};
