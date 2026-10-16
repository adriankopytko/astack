import {
  managedFileRequestSchema,
  inspectManagedFileRequestSchema,
  type ManagedFileResult,
  type ManagedFileInspection,
} from '../contracts/managed-files.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import type { ManagedFileStore } from '../ports/managed-file-store.js';

export async function writeManagedFile(
  input: unknown,
  store: ManagedFileStore,
  signal?: AbortSignal,
): Promise<ManagedFileResult> {
  const request = parseOperationRequest(managedFileRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  return store.write(request.value, signal);
}

export async function inspectManagedFile(
  input: unknown,
  store: ManagedFileStore,
): Promise<ManagedFileInspection> {
  const request = parseOperationRequest(inspectManagedFileRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  return store.inspect(request.value);
}
