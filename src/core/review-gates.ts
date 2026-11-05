import type { ReviewGatePolicy, ReviewSnapshot, ReviewTarget } from '../contracts/review-task.js';
import type { HostConfigurationPolicy } from '../contracts/configuration.js';
import { configurationDigest } from './configuration.js';

export function reviewGateConfigurationDigest(policy: HostConfigurationPolicy): string {
  return configurationDigest({
    enabled: policy.execution.enabled,
    review: policy.execution.review ?? null,
  });
}

export function sameReviewTarget(a: ReviewTarget, b: ReviewTarget): boolean {
  return (
    a.host === b.host && a.repository === b.repository && a.number === b.number && a.sha === b.sha
  );
}

/** Missing/skipped/cancelled checks never pass. An empty set needs an explicit host-approved no-CI gate. */
export function reviewGateBlocker(snapshot: ReviewSnapshot, gate: ReviewGatePolicy): string | null {
  if (snapshot.state !== 'OPEN' || snapshot.draft) {
    return 'pr_not_ready';
  }

  if (gate.overrideReason !== null) {
    return null;
  }

  if (
    gate.allowNoChecks === true &&
    gate.requiredChecks.length === 0 &&
    snapshot.checks.length === 0
  ) {
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
