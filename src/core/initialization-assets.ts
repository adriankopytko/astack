import {
  portableConfigurationSchema,
  hostConfigurationPolicySchema,
} from '../contracts/configuration.js';
export const initializationAssetVersion = '1';
export const initializationProposal = portableConfigurationSchema.parse({
  schemaVersion: 1,
  settings: {
    roles: {
      implementer: { runtime: null, command: null },
      reviewer: { runtime: null, command: null },
    },
    hooks: { setup: null, verify: null, teardown: null },
  },
});
export function initializationPolicy(projectId: string, repositoryId: string) {
  return hostConfigurationPolicySchema.parse({
    schemaVersion: 1,
    projectId,
    repositoryId,
    revision: 'init-v1',
    project: initializationProposal.settings,
    execution: {
      enabled: false,
      allowedRuntimes: [],
      allowedEnvironment: [],
      commands: {},
      skills: [],
    },
  });
}

export const initializationIgnore =
  '# In-flight managed asset publications; completed records may be tracked.\n.astack-stage-*/\n.astack-managed/*.pending.json\n.astack-managed/*.json.*.tmp\n';
export const initializationJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
