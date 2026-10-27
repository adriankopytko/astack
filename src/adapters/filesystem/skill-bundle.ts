import { fileURLToPath } from 'node:url';
import { skillCatalogSchema } from '../../contracts/skills.js';
import { completed, rejected } from '../../contracts/operation-result.js';
import { canonicalFileRoot, readRegularFile } from '../../core/file-paths.js';
import type { SkillBundleReader } from '../../ports/skills.js';

/** Resolve packaged assets from this module, independently of caller cwd. Construction performs no IO. */
export function createBundledSkillReader(
  root = fileURLToPath(new URL('../../../skills/', import.meta.url)),
): SkillBundleReader {
  return {
    async read() {
      try {
        const selected = await canonicalFileRoot(root);
        const manifest = await readRegularFile(selected, 'manifest.json', 32768);

        if (!manifest) {
          throw new Error('missing_catalog');
        }

        const decoder = new TextDecoder('utf-8', { fatal: true });
        const catalog = skillCatalogSchema.parse(JSON.parse(decoder.decode(manifest.bytes)));
        const contents = [];

        for (const asset of catalog.skills) {
          const file = await readRegularFile(selected, asset.path, 65536);

          if (!file || file.sha256 !== asset.sha256) {
            throw new Error('asset_mismatch');
          }

          contents.push({ id: asset.id, content: decoder.decode(file.bytes) });
        }

        return completed({ catalog, contents });
      } catch {
        return rejected(
          'skill_bundle_invalid',
          'The installed skill bundle is unavailable, changed or invalid.',
        );
      }
    },
  };
}
