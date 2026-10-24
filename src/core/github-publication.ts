import { createHash } from 'node:crypto';
import type { GithubPublication } from '../contracts/github.js';
/** Preserve v1 property order: saved publication markers must survive code/restart changes. */
export function githubPublicationMarker(input: {
  projectId: string;
  jobId: string;
  attemptId: string;
  effectId: string;
  key: string;
  publication: GithubPublication;
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        projectId: input.projectId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        effectId: input.effectId,
        key: input.key,
        publication: input.publication,
      }),
    )
    .digest('hex');

  return `<!-- astack:publication:v1:${digest} -->`;
}
