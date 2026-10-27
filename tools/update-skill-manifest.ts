import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { skillCatalogSchema } from '../src/contracts/skills.js';
const root = new URL('../skills/', import.meta.url);
const catalog = skillCatalogSchema.parse(
  JSON.parse(await readFile(new URL('manifest.json', root), 'utf8')),
);

for (const asset of catalog.skills) {
  const content = await readFile(new URL(asset.path, root));
  asset.sha256 = createHash('sha256').update(content).digest('hex');
}

await writeFile(new URL('manifest.json', root), `${JSON.stringify(catalog, null, 2)}\n`);
