export const initializationAssetVersion = '3';

/** One project-owned starter; the registry supplies local identities when it is resolved. */
export const initializationProjectConfig = {
  schemaVersion: 1,
  agents: {
    implementer: {
      description: 'Implements requested changes and runs relevant checks.',
      instructions:
        'Implement the requested changes, run the relevant project checks, and report what you did.',
      workspacePrefix: 'IMPL',
      provider: 'codex',
      model: null,
      reasoning: null,
      permissions: { files: 'write' },
    },
    reviewer: {
      description: 'Reviews changes and reports actionable findings.',
      instructions:
        'Review the requested changes for correctness and regressions. Report actionable findings and evidence.',
      workspacePrefix: 'CR',
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
