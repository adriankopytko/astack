import type { GitInspectionRequest, GitInspectionResult } from '../contracts/git.js';

/** Observations establish neither ownership nor a transactionally consistent repository snapshot. */
export interface GitInspector {
  inspect(request: GitInspectionRequest, signal?: AbortSignal): Promise<GitInspectionResult>;
}
