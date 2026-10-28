import type { HookRecord, HookReconcile, HookExclude } from '../contracts/hooks.js';
import type { OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
export interface HookStore {
  read(id: string): OperationResult<HookRecord | null>;
  prepare(record: HookRecord): StateWriteResult<HookRecord>;
  claim(id: string, expectedRevision: number): StateWriteResult<HookRecord>;
  finish(record: HookRecord, expectedRevision: number): StateWriteResult<HookRecord>;
  excludeWriter(request: HookExclude): StateWriteResult<HookRecord>;
  reconcile(request: HookReconcile): StateWriteResult<HookRecord>;
  prerequisitesReady(jobId: string): OperationResult<boolean>;
  integrationReady(jobId: string): OperationResult<boolean>;
}
/** Supplies only approved names. Values never enter hook journals, results or prompts. */
export interface HookEnvironment {
  read(names: readonly string[]): Promise<OperationResult<Record<string, string>>>;
}
