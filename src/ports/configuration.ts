import type {
  ConfigurationDiagnostic,
  HostConfigurationPolicy,
} from '../contracts/configuration.js';

/** Read the project configuration and, where available, the private configuration accepted for a job. */
export interface ConfigurationReader {
  readPolicy(projectId: string, signal?: AbortSignal): Promise<unknown>;
  readJobPolicy?(jobId: string, signal?: AbortSignal): Promise<unknown>;
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
