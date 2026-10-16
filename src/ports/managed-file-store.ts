import type {
  ManagedFileRequest,
  ManagedFileResult,
  InspectManagedFileRequest,
  ManagedFileInspection,
} from '../contracts/managed-files.js';

export interface ManagedFileStore {
  write(request: ManagedFileRequest, signal?: AbortSignal): Promise<ManagedFileResult>;
  inspect(request: InspectManagedFileRequest): Promise<ManagedFileInspection>;
}
