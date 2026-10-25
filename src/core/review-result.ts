import { isDeepStrictEqual } from 'node:util';
import { reviewTaskSchema, reviewWorkerReportSchema } from '../contracts/review-task.js';
import type { ServiceJob } from '../contracts/service.js';
import type { AcceptedRunReport } from '../contracts/runs.js';
import type { ReviewResultPublish } from '../contracts/review-results.js';

/** Accepted storage evidence is still bound to its original workflow and exact commit. */
export function acceptedReviewResult(job: ServiceJob, report: AcceptedRunReport) {
  const task = reviewTaskSchema.safeParse(job.job.intent.task);
  const proposal = reviewWorkerReportSchema.safeParse(report.request.proposal);

  if (
    !task.success ||
    !proposal.success ||
    proposal.data.outcome !== 'reviewed' ||
    job.entry.role !== 'reviewer' ||
    job.job.operation !== 'delegate:reviewer' ||
    report.jobId !== job.job.id ||
    report.request.jobId !== job.job.id ||
    report.attemptId !== job.attempt.id ||
    proposal.data.jobId !== job.job.id ||
    proposal.data.attemptId !== job.attempt.id ||
    proposal.data.projectId !== job.job.projectId ||
    proposal.data.checkoutId !== job.job.checkoutId ||
    task.data.submission.projectId !== job.job.projectId ||
    task.data.submission.checkoutId !== job.job.checkoutId ||
    task.data.submission.key !== job.job.idempotencyKey ||
    task.data.submission.branch !== job.entry.branch ||
    task.data.submission.commit !== job.entry.commit ||
    report.evidence.commit !== task.data.submission.target.sha ||
    !isDeepStrictEqual(proposal.data.target, task.data.submission.target) ||
    !isDeepStrictEqual(proposal.data.gate, task.data.submission.gate) ||
    !isDeepStrictEqual(proposal.data.acceptanceSnapshot, task.data.initialSnapshot)
  ) {
    return null;
  }

  return { assignment: task.data, proposal: proposal.data };
}

export function renderReviewResult(
  report: AcceptedRunReport,
  request: ReviewResultPublish,
): string {
  const proposal = reviewWorkerReportSchema.parse(report.request.proposal);
  const indexes = request.findingIndexes ?? proposal.findings.map((_, index) => index);

  if (indexes.some((index) => !proposal.findings[index])) {
    throw new Error('Unknown finding index');
  }

  return [
    `Review of commit ${proposal.target.sha}`,
    '',
    proposal.summary,
    '',
    `Findings included: ${indexes.length} of ${proposal.findings.length}. This report applies only to the reviewed commit.`,
    ...indexes.flatMap((index) => {
      const finding = proposal.findings[index]!;

      return [
        '',
        `Finding ${index}: ${finding.severity} — ${JSON.stringify(finding.path)}:${finding.line}`,
        finding.description,
      ];
    }),
    ...(proposal.blockers.length ? ['', 'Reported blockers:', ...proposal.blockers] : []),
  ].join('\n');
}
