export const initializationAssetVersion = '1';

/** One project-owned starter; the registry supplies local identities when it is resolved. */
export const initializationProjectConfig = {
  schemaVersion: 1,
  agents: {
    implementer: { provider: 'codex', model: null, reasoning: null },
    reviewer: { provider: 'codex', model: null, reasoning: null },
  },
};

export const initializationIgnore =
  '# In-flight managed asset publications; completed records may be tracked.\n.astack-stage-*/\n.astack-managed/*.pending.json\n.astack-managed/*.json.*.tmp\n';
export const initializationJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
