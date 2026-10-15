import { processRequestSchema, type ProcessResult } from '../contracts/process.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import type { ProcessRunner } from '../ports/process-runner.js';

/** Execute one caller-authorized command; a process exit does not establish domain completion. */
export async function executeProcess(
  input: unknown,
  runner: ProcessRunner,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  const request = parseOperationRequest(processRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  return runner.run(request.value, signal);
}
