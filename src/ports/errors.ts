import type { OperationResult } from '../contracts/operation-result.js';
import type { StateWriteResult } from '../contracts/state.js';
import type { ServiceError } from '../contracts/errors.js';

export interface ErrorStore {
  append(error: Omit<ServiceError, 'id' | 'createdAt'>): StateWriteResult<ServiceError>;
  list(limit: number): OperationResult<ServiceError[]>;
  read(id: string): OperationResult<ServiceError | null>;
}
