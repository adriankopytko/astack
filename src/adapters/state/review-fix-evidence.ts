import { readAcceptedRunReport } from './run-report-codec.js';
import { implementationTaskSchema } from '../../contracts/implementation-task.js';
import type { ServiceJob } from '../../contracts/service.js';
import type { StateJob } from '../../contracts/state.js';
import { acceptedReviewResult } from '../../core/review-result.js';
import { configurationDigest } from '../../core/configuration.js';
import type { StateDatabase } from './database.js';
import { stateFailure } from './errors.js';

/** Validate immutable accepted source evidence inside implementation queue acceptance. */
export function assertReviewFix(
  db: StateDatabase,
  job: StateJob,
  readJob: (id: string) => ServiceJob,
) {
  const task = implementationTaskSchema.safeParse(job.intent.task);

  if (!task.success || !task.data.submission.fixOf) {
    return null;
  }

  const reference = task.data.submission.fixOf;
  const report = readAcceptedRunReport(
    db,
    'SELECT data FROM run_reports WHERE job_id=? AND report_key=?',
    reference.jobId,
    reference.reportKey,
  );

  if (!report) {
    return stateFailure('run_report_invalid');
  }

  const source = readJob(reference.jobId);
  const sourceJob = source.job;
  const accepted = acceptedReviewResult(source, report);

  if (
    !accepted ||
    report.id !== reference.reportId ||
    report.attemptId !== reference.attemptId ||
    configurationDigest(report) !== reference.reportDigest ||
    sourceJob.projectId !== job.projectId ||
    sourceJob.repositoryId !== job.repositoryId ||
    reference.commit !== report.evidence.commit ||
    reference.commit !== task.data.submission.commit ||
    task.data.submission.checkoutId !== job.checkoutId ||
    task.data.submission.projectId !== job.projectId ||
    reference.findingIndexes.some((index) => !accepted.proposal.findings[index])
  ) {
    stateFailure('run_report_invalid');
  }

  if (
    db.statement('SELECT 1 FROM jobs WHERE checkout_id=? AND id<>?').get(job.checkoutId, job.id)
  ) {
    stateFailure('state_conflict');
  }

  return { reviewJobId: reference.jobId, reportId: reference.reportId };
}
