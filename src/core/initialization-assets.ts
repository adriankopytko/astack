export const initializationAssetVersion = '2';

/** One project-owned starter; the registry supplies local identities when it is resolved. */
export const initializationProjectConfig = {
  schemaVersion: 1,
  defaultAgents: { implementation: 'implementer', review: 'reviewer' },
  agents: {
    implementer: {
      provider: 'codex',
      model: null,
      reasoning: null,
      permissions: { files: 'write' },
    },
    reviewer: {
      provider: 'codex',
      model: null,
      reasoning: null,
      permissions: { files: 'readonly' },
    },
  },
};

export const initializationIgnore =
  '# In-flight managed asset publications; completed records may be tracked.\n.astack-stage-*/\n.astack-managed/*.pending.json\n.astack-managed/*.json.*.tmp\n';
export const initializationJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
