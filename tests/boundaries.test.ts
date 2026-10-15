import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const checker = fileURLToPath(
  new URL('../node_modules/dependency-cruiser/bin/dependency-cruiser.mjs', import.meta.url),
);
const config = fileURLToPath(new URL('../.dependency-cruiser.cjs', import.meta.url));

interface Scenario {
  name: string;
  files: Record<string, string>;
  violation?: string;
}

const scenarios: Scenario[] = [
  {
    name: 'reject production imports of test helpers',
    files: {
      'src/core/value.ts': "export { value } from '../../tests/helper.js';",
      'tests/helper.ts': 'export const value = 1;',
    },
    violation: 'no-source-to-development-files',
  },
  {
    name: 'reject production imports of generated output',
    files: {
      'src/core/value.ts': "export { value } from '../../dist/helper.js';",
      'dist/helper.js': 'export const value = 1;',
    },
    violation: 'no-source-to-development-files',
  },
  {
    name: 'accept application dependencies on core',
    files: {
      'src/application/job.ts': "export { value } from '../core/value.js';",
      'src/core/value.ts': 'export const value = 1;',
    },
  },
  {
    name: 'reject a core re-export of an adapter',
    files: {
      'src/core/value.ts': "export { value } from '../adapters/github/value.js';",
      'src/adapters/github/value.ts': 'export const value = 1;',
    },
    violation: 'core-dependency-direction',
  },
  {
    name: 'reject type-only application imports of concrete adapters',
    files: {
      'src/application/job.ts': "export type { Provider } from '../adapters/github/provider.js';",
      'src/adapters/github/provider.ts': 'export interface Provider { id: string }',
    },
    violation: 'application-dependency-direction',
  },
  {
    name: 'allow core types in ports',
    files: {
      'src/ports/provider.ts': "export type { Identity } from '../core/identity.js';",
      'src/core/identity.ts': 'export interface Identity { id: string }',
    },
  },
  {
    name: 'reject runtime core dependencies in ports',
    files: {
      'src/ports/provider.ts': "export { value } from '../core/value.js';",
      'src/core/value.ts': 'export const value = 1;',
    },
    violation: 'ports-core-types-only',
  },
  {
    name: 'reject cross-adapter imports',
    files: {
      'src/adapters/github/provider.ts': "export { value } from '../herdr/value.js';",
      'src/adapters/herdr/value.ts': 'export const value = 1;',
    },
    violation: 'adapters-do-not-import-other-adapters',
  },
  {
    name: 'accept an adapter importing its own modules',
    files: {
      'src/adapters/github/provider.ts': "export { value } from './value.js';",
      'src/adapters/github/value.ts': 'export const value = 1;',
    },
  },
  {
    name: 'reject static dynamic imports across layer boundaries',
    files: {
      'src/core/value.ts': "export const load = () => import('../cli/program.js');",
      'src/cli/program.ts': 'export const value = 1;',
    },
    violation: 'core-dependency-direction',
  },
  {
    name: 'reject SQLite outside its state adapter',
    files: {
      'src/application/job.ts': "export { DatabaseSync } from 'node:sqlite';",
    },
    violation: 'sqlite-in-state-adapter-only',
  },
  {
    name: 'reject cycles',
    files: {
      'src/core/a.ts': "import './b.js'; export const a = 1;",
      'src/core/b.ts': "import './a.js'; export const b = 1;",
    },
    violation: 'no-cycles',
  },
  {
    name: 'reject unresolved imports',
    files: {
      'src/core/value.ts': "export { value } from './missing.js';",
    },
    violation: 'no-unresolved',
  },
];

for (const scenario of scenarios) {
  await test(`boundaries: ${scenario.name}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'astack-boundaries-'));

    try {
      await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
      await writeFile(
        join(cwd, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
          include: ['src/**/*.ts'],
        }),
      );

      for (const [path, contents] of Object.entries(scenario.files)) {
        const target = join(cwd, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, contents);
      }

      const result = spawnSync(process.execPath, [checker, '--config', config, 'src'], {
        cwd,
        encoding: 'utf8',
        timeout: 30_000,
      });

      assert.ifError(result.error);

      const output = result.stdout + result.stderr;

      if (scenario.violation) {
        assert.notEqual(result.status, 0, output);
        assert.ok(output.includes(scenario.violation), output);
      } else {
        assert.equal(result.status, 0, output);
      }

      assert.doesNotMatch(output, /missing-typescript-transpiler|0 modules/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
