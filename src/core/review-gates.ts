import type { ReviewGatePolicy, ReviewSnapshot, ReviewTarget } from '../contracts/review-task.js';
export function sameReviewTarget(a: ReviewTarget, b: ReviewTarget): boolean {
  return (
    a.host === b.host && a.repository === b.repository && a.number === b.number && a.sha === b.sha
  );
}

/** No checks, missing names, skipped and cancelled checks never establish a passing gate. */
export function reviewGateBlocker(snapshot: ReviewSnapshot, gate: ReviewGatePolicy): string | null {
  if (snapshot.state !== 'OPEN' || snapshot.draft) {
    return 'pr_not_ready';
  }

  if (gate.overrideReason !== null) {
    return null;
  }

  const checks =
    gate.requiredChecks.length === 0
      ? snapshot.checks
      : gate.requiredChecks.map((name) => snapshot.checks.find((check) => check.name === name));

  if (checks.length === 0 || checks.some((check) => check === undefined)) {
    return 'checks_missing';
  }

  if (checks.some((check) => check?.state !== 'pass')) {
    return 'checks_not_passing';
  }

  return null;
}
