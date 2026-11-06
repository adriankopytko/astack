export const initializationAssetVersion = '1';

/** One project-owned starter; the registry supplies local identities when it is resolved. */
export const initializationProjectConfig = {
  schemaVersion: 1,
  project: {
    roles: {
      implementer: { runtime: null, command: null },
      reviewer: { runtime: null, command: null },
    },
    hooks: { setup: null, verify: null, teardown: null },
  },
  execution: {
    enabled: false,
    allowedRuntimes: [],
    allowedEnvironment: [],
    maxTimeoutMs: 300000,
    requiredHooks: { setup: null, verify: null, teardown: null },
    commands: {},
    skills: [],
  },
};

export const initializationIgnore =
  '# In-flight managed asset publications; completed records may be tracked.\n.astack-stage-*/\n.astack-managed/*.pending.json\n.astack-managed/*.json.*.tmp\n';
export const initializationJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
