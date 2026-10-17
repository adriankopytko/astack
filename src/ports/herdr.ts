import type {
  HerdrSettings,
  HerdrSpace,
  HerdrTarget,
  HerdrSnapshot,
  HerdrServer,
  HerdrAgent,
} from '../contracts/herdr.js';
import type { OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { WorktreeRecord } from '../contracts/worktrees.js';

export interface HerdrProvider {
  snapshot(
    target: HerdrTarget,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<OperationResult<HerdrSnapshot>>;
  createPrimary(
    input: { target: HerdrTarget; server: HerdrServer; root: string; label: string },
    signal?: AbortSignal,
  ): Promise<OperationResult<null>>;
  openWorker(
    input: {
      target: HerdrTarget;
      server: HerdrServer;
      root: string;
      parent: string;
      label: string;
    },
    signal?: AbortSignal,
  ): Promise<OperationResult<{ alreadyOpen: boolean }>>;
}
export interface HerdrEndpointReader {
  read(target: HerdrTarget): Promise<Omit<HerdrServer, 'protocol'>>;
}
export interface HerdrStore {
  settings(projectId: string): OperationResult<HerdrSettings | null>;
  configure(settings: HerdrSettings): StateWriteResult<HerdrSettings>;
  primary(projectId: string): OperationResult<HerdrSpace | null>;
  worker(attemptId: string): OperationResult<HerdrSpace | null>;
  read(id: string): OperationResult<HerdrSpace | null>;
  managedCheckout(checkoutId: string): OperationResult<WorktreeRecord | null>;
  reserve(record: HerdrSpace): StateWriteResult<HerdrSpace>;
  replacePrimary(previous: HerdrSpace, next: HerdrSpace): StateWriteResult<HerdrSpace>;
  finish(previous: HerdrSpace, next: HerdrSpace): StateWriteResult<HerdrSpace>;
  bindAgent(previous: HerdrSpace, agent: HerdrAgent): StateWriteResult<HerdrSpace>;
}
