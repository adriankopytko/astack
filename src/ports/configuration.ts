import type {
  ConfigurationDiagnostic,
  HostConfigurationPolicy,
} from '../contracts/configuration.js';

/** Host implementations establish trust; repository proposals are always untrusted data. */
export interface ConfigurationReader {
  readPolicy(projectId: string, signal?: AbortSignal): Promise<unknown>;
  readProposal(checkoutRoot: string, signal?: AbortSignal): Promise<unknown>;
}

export interface ConfigurationPrerequisites {
  commands: { id: string; executable: string }[];
  skills: HostConfigurationPolicy['execution']['skills'];
  environment: string[];
}

/** Inspect availability and pinned skill bytes, without launching commands or exposing secrets. */
export interface ConfigurationProbe {
  inspect(
    input: ConfigurationPrerequisites,
    signal?: AbortSignal,
  ): Promise<ConfigurationDiagnostic[]>;
}
