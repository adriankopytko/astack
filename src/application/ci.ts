import type { AutomaticReviewStore } from '../ports/automatic-review.js';
import { isDeepStrictEqual } from 'node:util';
import {
  ciWatchRequestSchema,
  ciControlRequestSchema,
  ciReadRequestSchema,
  ciListRequestSchema,
  ciTickRequestSchema,
  ciPolicySchema,
  ciRecordSchema,
  type CiBinding,
  type CiRecord,
  type CiSource,
  type CiPolicy,
} from '../contracts/ci.js';
import { hostConfigurationPolicySchema } from '../contracts/configuration.js';
import { reviewSnapshotSchema, type ReviewSnapshot } from '../contracts/review-task.js';
import {
  completed,
  rejected,
  type OperationResult,
  type OperationErrorCode,
} from '../contracts/operation-result.js';
import type { CiStore, CiReader } from '../ports/ci.js';
import type { HandoffStore } from '../ports/handoff.js';
import type { RunStore } from '../ports/runs.js';
import type { ConfigurationReader } from '../ports/configuration.js';
import { selectProjectContext } from './select-project-context.js';
import type { ProjectDependencies } from './project-facts.js';
import { reviewTask } from './review.js';
import { configurationDigest } from '../core/configuration.js';
import { sameReviewTarget, reviewGateBlocker } from '../core/review-gates.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';

export interface CiDependencies extends ProjectDependencies {
  automaticCi?: Pick<AutomaticReviewStore, 'authorizeCi'>;
  ci: CiStore;
  handoffs: HandoffStore;
  runs: RunStore;
  configuration: ConfigurationReader;
  reader: CiReader;
  now: () => number;
  nextId: () => string;
  random: () => number;
}
class CiFailure extends Error {
  constructor(
    readonly code: OperationErrorCode,
    readonly phase: 'blocked' | 'cancelled' | 'completed' = 'blocked',
  ) {
    super('CI source unavailable');
  }
}
function take<T>(result: OperationResult<T>): T {
  if (result.outcome === 'rejected') {
    throw new CiFailure(result.error.code);
  }

  return result.value;
}

function failure(error: unknown) {
  return rejected(
    error instanceof CiFailure ? error.code : 'ci_blocked',
    'CI observation requires an unchanged persisted review request, trusted policy and registered project context.',
  );
}

function clock(deps: CiDependencies) {
  const time = deps.now();

  if (!Number.isSafeInteger(time) || time < 0) {
    throw new CiFailure('ci_blocked');
  }

  return time;
}

async function binding(
  source: CiSource,
  deps: CiDependencies,
  signal?: AbortSignal,
): Promise<CiBinding> {
  if (signal?.aborted) {
    throw new CiFailure('cancelled');
  }

  let projectId: string;
  let repositoryId: string;
  let sourceId: string;
  let target;
  let gate;
  let baseSha: string | null = null;
  let expectedPolicy: string | null = null;

  if (source.kind === 'handoff') {
    const handoff = take(deps.handoffs.find(source.jobId, source.key));
    const followUp = handoff?.record.followUpReview;

    if (!handoff || handoff.record.phase !== 'accepted' || !followUp) {
      throw new CiFailure('ci_blocked');
    }

    projectId = handoff.record.source.projectId;
    repositoryId = handoff.record.source.repositoryId;
    sourceId = followUp.id;
    target = followUp.target;
    gate = followUp.gate;
  } else {
    const run = take(deps.runs.inspect(source.jobId));
    const task = run ? reviewTask(run.job) : null;

    if (!run || !task) {
      throw new CiFailure('ci_blocked');
    }

    if (run.control.phase === 'cancel_requested' || run.control.phase === 'cancelled') {
      throw new CiFailure('run_closed', 'cancelled');
    }

    if (run.control.phase === 'completed') {
      throw new CiFailure('run_closed', 'completed');
    }

    if (run.control.phase !== 'active') {
      throw new CiFailure('run_closed');
    }

    projectId = run.job.job.projectId;
    repositoryId = run.job.job.repositoryId;
    sourceId = run.job.attempt.id;
    target = task.submission.target;
    gate = task.submission.gate;
    baseSha = task.initialSnapshot.baseSha;
    expectedPolicy = run.job.job.configuration?.policyDigest ?? null;

    if (!expectedPolicy) {
      throw new CiFailure('configuration_blocked');
    }
  }

  const policy = hostConfigurationPolicySchema.safeParse(
    await deps.configuration.readPolicy(projectId, signal),
  );

  if (
    !policy.success ||
    policy.data.projectId !== projectId ||
    policy.data.repositoryId !== repositoryId ||
    !policy.data.execution.enabled ||
    (expectedPolicy !== null && configurationDigest(policy.data) !== expectedPolicy) ||
    (gate.overrideReason !== null && policy.data.execution.review?.allowGateOverride !== true) ||
    (gate.allowNoChecks === true && policy.data.execution.review?.allowNoChecks !== true)
  ) {
    throw new CiFailure('configuration_blocked');
  }

  const selected = take(await selectProjectContext({ schemaVersion: 1, projectId }, deps, signal));

  if (!selected.project || !selected.checkout || selected.project.repository.id !== repositoryId) {
    throw new CiFailure('project_checkout_stale');
  }

  return {
    projectId,
    repositoryId,
    sourceId,
    root: selected.checkout.checkout.rootPath,
    checkoutId: selected.checkout.checkout.id,
    target,
    gate,
    baseSha,
    policyDigest: configurationDigest(policy.data),
  };
}

async function validate(record: CiRecord, deps: CiDependencies, signal?: AbortSignal) {
  if (record.request.automaticReviewPlanId) {
    take(
      deps.automaticCi?.authorizeCi(record.request.automaticReviewPlanId, record.id) ??
        rejected('automatic_review_blocked', 'Automatic CI is disabled in this host.'),
    );
  }

  const fresh = await binding(record.request.source, deps, signal);

  if (!isDeepStrictEqual(fresh, record.binding)) {
    throw new CiFailure('configuration_blocked');
  }
}

export async function watchCi(input: unknown, deps: CiDependencies, signal?: AbortSignal) {
  const parsed = parseOperationRequest(ciWatchRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  try {
    const request = parsed.value;
    const id = `ci-${configurationDigest({ source: request.source, key: request.key })}`;
    const existing = take(deps.ci.find(id));

    if (existing) {
      return isDeepStrictEqual(existing.record.request, request)
        ? {
            schemaVersion: 1 as const,
            outcome: 'persisted' as const,
            disposition: 'existing' as const,
            value: existing,
          }
        : rejected('state_conflict', 'CI request key already identifies different intent.');
    }

    if (request.automaticReviewPlanId) {
      take(
        deps.automaticCi?.authorizeCi(request.automaticReviewPlanId, id) ??
          rejected('automatic_review_blocked', 'Automatic CI is disabled in this host.'),
      );
    }

    const source = await binding(request.source, deps, signal);
    const now = clock(deps);

    if (signal?.aborted) {
      return rejected('cancelled', 'CI enrollment was cancelled.');
    }

    return deps.ci.reserve(
      ciRecordSchema.parse({
        schemaVersion: 1,
        id,
        request,
        binding: source,
        targetId: `ci-target-${configurationDigest(source.target)}`,
        phase: 'watching',
        reason: null,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        deadlineAt: now + request.timeoutMs,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}

export function inspectCi(input: unknown, deps: Pick<CiDependencies, 'ci'>) {
  const parsed = parseOperationRequest(ciReadRequestSchema, input);

  return parsed.valid ? deps.ci.find(parsed.value.id) : parsed.result;
}

export function listCi(input: unknown, deps: Pick<CiDependencies, 'ci'>) {
  const parsed = parseOperationRequest(ciListRequestSchema, input);

  return parsed.valid ? deps.ci.list(parsed.value) : parsed.result;
}

export async function controlCi(input: unknown, deps: CiDependencies, signal?: AbortSignal) {
  const parsed = parseOperationRequest(ciControlRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  try {
    const request = parsed.value;
    const current = take(deps.ci.find(request.id));

    if (!current) {
      return rejected('ci_not_found', 'CI request not found.');
    }

    if (current.record.revision !== request.expectedRevision) {
      return rejected('state_conflict', 'CI request revision changed.');
    }

    if (['cancelled', 'completed'].includes(current.record.phase)) {
      return rejected('ci_blocked', 'Terminal CI requests cannot resume or change.');
    }

    if (request.action === 'resume') {
      await validate(current.record, deps, signal);
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'CI control was cancelled.');
    }

    const now = clock(deps);

    return deps.ci.control({
      id: request.id,
      expectedRevision: request.expectedRevision,
      phase:
        request.action === 'resume'
          ? 'watching'
          : request.action === 'suspend'
            ? 'suspended'
            : request.action === 'cancel'
              ? 'cancelled'
              : 'completed',
      reason: request.action === 'resume' ? null : `host_${request.action}`,
      now,
      ...(request.action === 'resume'
        ? { deadlineAt: now + (request.timeoutMs ?? current.record.request.timeoutMs) }
        : {}),
    });
  } catch (error) {
    return failure(error);
  }
}

function decision(
  record: CiRecord,
  snapshot: ReviewSnapshot,
): { phase: CiRecord['phase']; reason: string | null } {
  if (record.binding.baseSha !== null && record.binding.baseSha !== snapshot.baseSha) {
    return { phase: 'blocked', reason: 'review_target_changed' };
  }

  const blocker = reviewGateBlocker(snapshot, record.binding.gate);

  if (!blocker) {
    return { phase: 'ready', reason: null };
  }

  if (blocker === 'pr_not_ready') {
    return { phase: 'blocked', reason: blocker };
  }

  const checks = record.binding.gate.requiredChecks.length
    ? record.binding.gate.requiredChecks.map((name) => snapshot.checks.find((c) => c.name === name))
    : snapshot.checks;

  if (checks.some((c) => c && ['fail', 'cancel', 'skipping'].includes(c.state))) {
    return { phase: 'blocked', reason: 'checks_not_passing' };
  }

  return { phase: 'watching', reason: blocker };
}

const transient = new Set<OperationErrorCode>([
  'github_rate_limited',
  'github_timed_out',
  'github_failed',
  'github_unavailable',
  'cancelled',
]);
export async function observeCi(
  input: unknown,
  deps: CiDependencies,
  policyInput: CiPolicy,
  signal?: AbortSignal,
) {
  const parsed = parseOperationRequest(ciTickRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  const policy = ciPolicySchema.safeParse(policyInput);

  if (!policy.success) {
    return rejected('invalid_request', 'Invalid CI scheduling policy.');
  }

  try {
    if (signal?.aborted) {
      return rejected('cancelled', 'CI observation was cancelled.');
    }

    const expired = deps.ci.expire(clock(deps));

    if (expired.outcome !== 'persisted') {
      return expired;
    }

    const targets = take(deps.ci.due(clock(deps), policy.data.maxTargetsPerTick));
    let observed = 0;
    let deferred = 0;

    for (const candidate of targets) {
      if (signal?.aborted) {
        break;
      }

      const subscribers = take(deps.ci.subscribers(candidate.id));

      for (const record of subscribers) {
        try {
          await validate(record, deps, signal);
        } catch (error) {
          if (signal?.aborted) {
            break;
          }

          const result = deps.ci.control({
            id: record.id,
            expectedRevision: record.revision,
            phase: error instanceof CiFailure ? error.phase : 'blocked',
            reason: error instanceof CiFailure ? error.code : 'ci_blocked',
            now: clock(deps),
          });

          if (
            result.outcome !== 'persisted' &&
            !(result.outcome === 'rejected' && result.error.code === 'state_conflict')
          ) {
            return result;
          }
        }
      }

      if (signal?.aborted) {
        break;
      }

      const owner = deps.nextId();
      const token = deps.nextId();
      const claimed = deps.ci.claim({
        targetId: candidate.id,
        owner,
        token,
        now: clock(deps),
        policy: policy.data,
      });

      if (claimed.outcome !== 'persisted') {
        return claimed;
      }

      if (!claimed.value) {
        deferred++;
        continue;
      }

      const observation = claimed.value;
      const claim = observation.claim;

      if (!claim) {
        throw new CiFailure('state_invalid_data');
      }

      const participants = take(deps.ci.subscribers(candidate.id)).filter((r) =>
        claim.participants.some((p) => p.id === r.id && p.revision === r.revision),
      );
      let snapshot: ReviewSnapshot | null = null;
      let error: OperationErrorCode | null = null;
      let hint = 0;

      try {
        const reader = participants[0];

        if (!reader) {
          throw new CiFailure('cancelled');
        }

        const result = await deps.reader.read(
          {
            target: observation.target,
            root: reader.binding.root,
            maxRequests: policy.data.maxRequestsPerObservation,
          },
          signal,
        );

        if (result.outcome === 'completed') {
          const value = reviewSnapshotSchema.parse(result.value);

          if (
            !sameReviewTarget(value.target, observation.target) ||
            value.observedAt < claim.startedAt ||
            value.observedAt > clock(deps)
          ) {
            throw new CiFailure('github_invalid_output');
          }

          snapshot = value;
        } else {
          error = result.error.code;
          const retry = result.error.retryAfterMs;
          hint =
            typeof retry === 'number' && Number.isFinite(retry) && retry >= 0
              ? Math.min(retry, 86400000)
              : 0;
        }
      } catch (failure) {
        error = failure instanceof CiFailure ? failure.code : 'github_failed';
      }

      let now = clock(deps);

      if (signal?.aborted) {
        snapshot = null;
        error = 'cancelled';
      }

      const decisions: {
        id: string;
        revision: number;
        phase: CiRecord['phase'];
        reason: string | null;
      }[] = [];

      for (const record of participants) {
        let state: { phase: CiRecord['phase']; reason: string | null };

        try {
          if (signal?.aborted) {
            throw new CiFailure('cancelled');
          }

          await validate(record, deps, signal);
          state =
            record.deadlineAt <= now
              ? { phase: 'blocked', reason: 'deadline_exceeded' }
              : snapshot
                ? decision(record, snapshot)
                : {
                    phase: error && transient.has(error) ? 'watching' : 'blocked',
                    reason: error ?? 'github_invalid_output',
                  };
        } catch (failure) {
          state = {
            phase: signal?.aborted
              ? 'watching'
              : failure instanceof CiFailure
                ? failure.phase
                : 'blocked',
            reason: signal?.aborted
              ? 'cancelled'
              : failure instanceof CiFailure
                ? failure.code
                : 'ci_blocked',
          };
        }

        decisions.push({ id: record.id, revision: record.revision, ...state });
      }

      now = clock(deps);

      for (const entry of decisions) {
        if (participants.find((r) => r.id === entry.id)!.deadlineAt <= now) {
          entry.phase = 'blocked';
          entry.reason = 'deadline_exceeded';
        }
      }

      const waiting = decisions.some((d) => d.phase === 'watching');
      const backoff = waiting ? Math.min(observation.backoff + 1, 32) : 0;
      const base = Math.min(
        policy.data.maxIntervalMs,
        policy.data.intervalMs * 2 ** Math.min(observation.backoff, 20),
      );
      const random = deps.random();

      if (!Number.isFinite(random) || random < 0 || random > 1) {
        throw new CiFailure('ci_blocked');
      }

      const delay = Math.max(Math.ceil(base * (1 + random * 0.25)), hint);
      const settled = deps.ci.settle({
        target: {
          ...observation,
          nextRefreshAt: now + delay,
          lastObservedAt: snapshot?.observedAt ?? observation.lastObservedAt,
          snapshot: snapshot ?? observation.snapshot,
          error,
          backoff,
          claim: null,
        },
        owner,
        token,
        now,
        retryNotBefore: error === 'github_rate_limited' ? now + delay : null,
        decisions,
      });

      if (settled.outcome === 'rejected' && settled.error.code === 'state_conflict') {
        deferred++;
        continue;
      }

      if (settled.outcome !== 'persisted') {
        return settled;
      }

      observed++;
    }

    return completed({ observed, deferred });
  } catch (error) {
    return failure(error);
  }
}

/** Serialized bounded passes. Only persisted due targets cause provider reads. */
export function createCiObserver(
  deps: CiDependencies,
  policy: CiPolicy,
  onFailure: () => void,
  onProgress?: () => void,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  let stopped = false;
  let requested = false;
  function wake() {
    if (stopped) {
      return;
    }

    requested = true;

    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }

    if (running) {
      return;
    }

    running = (async () => {
      do {
        requested = false;
        const result = await observeCi({ schemaVersion: 1 }, deps, policy, controller.signal);

        if (result.outcome === 'completed' && !controller.signal.aborted) {
          onProgress?.();
        }

        if (result.outcome !== 'completed' && !controller.signal.aborted) {
          stopped = true;
          onFailure();
        }
      } while (requested && !stopped);
    })().finally(() => {
      running = null;

      if (!stopped) {
        try {
          const next = take(deps.ci.nextWake());

          if (next !== null) {
            timer = setTimeout(wake, Math.max(250, Math.min(60000, next - clock(deps))));
            timer.unref();
          }
        } catch {
          stopped = true;
          onFailure();
        }
      }
    });
  }

  return {
    start: wake,
    wake,
    async stop() {
      stopped = true;

      if (timer) {
        clearTimeout(timer);
      }

      controller.abort();
      await running;
    },
  };
}
