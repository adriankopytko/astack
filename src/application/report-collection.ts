import { completed, rejected, type OperationResult } from '../contracts/operation-result.js';
import {
  runReadRequestSchema,
  runReportRequestSchema,
  type RunReportRequest,
} from '../contracts/runs.js';
import { stateIdSchema } from '../contracts/state.js';
import type { RunStore, RunReportReader } from '../ports/runs.js';
import { implementationTask } from './implementation.js';
import { reviewTask } from './review.js';
import { renderImplementationPrompt } from '../core/implementation-prompt.js';
import { renderReviewPrompt } from '../core/review-prompt.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';

/** Collect a proposal only. The owning coordinator must still perform report acceptance. */
export async function collectRunReport(
  input: unknown,
  deps: { runs: RunStore; reports: RunReportReader },
  signal?: AbortSignal,
): Promise<OperationResult<RunReportRequest>> {
  const parsed = parseOperationRequest(runReadRequestSchema.extend({ key: stateIdSchema }), input);

  if (!parsed.valid) {
    return parsed.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Report collection was cancelled.');
  }

  try {
    const saved = deps.runs.inspect(parsed.value.jobId);

    if (saved.outcome === 'rejected') {
      return saved;
    }

    if (!saved.value) {
      return rejected('run_not_found', 'Run not found.');
    }

    const run = saved.value;
    const review = reviewTask(run.job);
    const implementation = implementationTask(run.job);
    const prompt = review
      ? renderReviewPrompt(run.job, review)
      : implementation
        ? renderImplementationPrompt(run.job, implementation)
        : null;

    if (!prompt) {
      return rejected('run_report_invalid', 'No supported saved assignment exists.');
    }

    const candidate = await deps.reports.read({ run, prompt }, signal);

    if (candidate.outcome === 'rejected') {
      return candidate;
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'Report collection was cancelled.');
    }

    const request = runReportRequestSchema.safeParse({
      ...parsed.value,
      proposal: candidate.value,
      artifacts: [],
    });

    return request.success
      ? completed(request.data)
      : rejected(
          'run_report_invalid',
          'The final response is not a valid structured report; request a corrected response from the same worker.',
        );
  } catch {
    return rejected('run_report_invalid', 'The selected worker report could not be collected.');
  }
}
