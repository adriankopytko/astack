import type { ProcessRequest, ProcessResult } from '../contracts/process.js';

/** Implementations must retain uncertain effects in their result, never report them as rejection. */
export interface ProcessRunner {
  run(request: ProcessRequest, signal?: AbortSignal): Promise<ProcessResult>;
}
