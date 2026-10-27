import type { OperationResult } from '../contracts/operation-result.js';
import type { SkillBundle } from '../contracts/skills.js';
export interface SkillBundleReader {
  read(): Promise<OperationResult<SkillBundle>>;
}
export interface SkillDirectoryObservation {
  root: string;
  exists: boolean;
  directories: { name: string; state: 'missing' | 'empty' | 'present' }[];
}
/** Host-selected roots only. No agent settings, project files, adoption or directory deletion. */
export interface SkillDirectories {
  inspect(root: string, names: string[]): Promise<OperationResult<SkillDirectoryObservation>>;
  prepare(
    root: string,
    names: string[],
    signal?: AbortSignal,
  ): Promise<OperationResult<SkillDirectoryObservation>>;
}
