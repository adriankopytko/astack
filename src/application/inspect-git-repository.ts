import { gitInspectionRequestSchema, type GitInspectionResult } from '../contracts/git.js';
import { rejected } from '../contracts/operation-result.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import type { GitInspector } from '../ports/git-inspector.js';

export async function inspectGitRepository(
  input: unknown,
  inspector: GitInspector,
  signal?: AbortSignal,
): Promise<GitInspectionResult> {
  const request = parseOperationRequest(gitInspectionRequestSchema, input);

  if (!request.valid) {
    return request.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Git inspection was cancelled.');
  }

  try {
    const result = await inspector.inspect(request.value, signal);

    return signal?.aborted ? rejected('cancelled', 'Git inspection was cancelled.') : result;
  } catch {
    return signal?.aborted
      ? rejected('cancelled', 'Git inspection was cancelled.')
      : rejected('git_failed', 'Git inspection could not be completed.');
  }
}
