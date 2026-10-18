/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    { name: 'no-unresolved', severity: 'error', from: {}, to: { couldNotResolve: true } },
    {
      name: 'no-source-to-development-files',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^(tests|dist|tools|\\.planning)/' },
    },
    ...[
      ['contracts', ['contracts']],
      ['core', ['core', 'contracts']],
      ['ports', ['ports', 'contracts', 'core']],
      ['application', ['application', 'core', 'contracts', 'ports']],
      ['adapters', ['adapters', 'core', 'contracts', 'ports']],
      ['cli', ['cli', 'application', 'core', 'contracts', 'ports', 'adapters', 'host']],
      ['service', ['service', 'application', 'core', 'contracts', 'ports', 'adapters']],
      ['host', ['host', 'service', 'application', 'core', 'contracts', 'ports', 'adapters']],
    ].map(([layer, allowed]) => ({
      name: `${layer}-dependency-direction`,
      severity: /** @type {const} */ ('error'),
      from: { path: `^src/${layer}/` },
      to: { path: '^src/', pathNot: `^src/(${/** @type {string[]} */ (allowed).join('|')})/` },
    })),
    {
      name: 'cli-host-wiring-only',
      severity: 'error',
      from: { path: '^src/cli/', pathNot: '^src/cli/(service|runs)\\.ts$' },
      to: { path: '^src/host/' },
    },
    {
      name: 'cli-host-entry-only',
      severity: 'error',
      from: { path: '^src/cli/' },
      to: { path: '^src/host/', pathNot: '^src/host/(local-service|reconcile-run)\\.ts$' },
    },
    {
      name: 'run-cli-host-entry-only',
      severity: 'error',
      from: { path: '^src/cli/runs\\.ts$' },
      to: { path: '^src/host/', pathNot: '^src/host/reconcile-run\\.ts$' },
    },
    {
      name: 'service-cli-host-entry-only',
      severity: 'error',
      from: { path: '^src/cli/service\\.ts$' },
      to: { path: '^src/host/', pathNot: '^src/host/local-service\\.ts$' },
    },
    {
      name: 'ports-core-types-only',
      severity: 'error',
      from: { path: '^src/ports/' },
      to: { path: '^src/core/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'adapters-do-not-import-other-adapters',
      severity: 'error',
      from: { path: '^src/adapters/([^/]+)/' },
      to: { path: '^src/adapters/', pathNot: '^src/adapters/$1/' },
    },
    {
      name: 'commander-in-cli-only',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/cli/' },
      to: { path: '(^|/)node_modules/commander(/|$)' },
    },
    {
      name: 'hono-in-service-only',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/service/' },
      to: { path: '(^|/)node_modules/(hono|@hono/node-server)(/|$)' },
    },
    {
      name: 'sqlite-in-state-adapter-only',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/adapters/state/' },
      to: { path: '^node:sqlite$' },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      conditionNames: ['import', 'node', 'default'],
      exportsFields: ['exports'],
    },
  },
};
