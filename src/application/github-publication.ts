import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  githubEffectRequestSchema,
  githubPublicationSchema,
  githubPublicationReceiptSchema,
  type GithubPublicationReceipt,
} from '../contracts/github.js';
import { rejected } from '../contracts/operation-result.js';
import type { StateClaimRequest, StateEffect, StateWriteResult } from '../contracts/state.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import type { StateStore } from '../ports/state-store.js';
import type { GithubProvider } from '../ports/github.js';

export interface GithubPublicationDependencies {
  store: StateStore;
  provider: GithubProvider;
  nextId: () => string;
}

/** Host-only effect execution. Intent is already accepted through prepareStateAttempt. */
export async function publishGithubEffect(
  input: unknown,
  deps: GithubPublicationDependencies,
  signal?: AbortSignal,
): Promise<StateWriteResult<StateEffect>> {
  const parsed = parseOperationRequest(githubEffectRequestSchema, input);

  if (!parsed.valid) {
    return parsed.result;
  }

  const request = parsed.value;
  const selected = deps.store.inspectRecord({
    schemaVersion: 1,
    entity: 'effect',
    id: request.effectId,
  });

  if (selected.outcome === 'rejected') {
    return selected;
  }

  if (selected.value?.entity !== 'effect') {
    return rejected('state_not_found', 'The publication effect does not exist.');
  }

  const effect = selected.value.record;
  const payload = z
    .strictObject({ publication: githubPublicationSchema })
    .safeParse(effect.intent.payload);

  if (effect.intent.kind !== 'github-publication:v1' || !payload.success) {
    return rejected(
      'invalid_request',
      'Select an accepted github-publication:v1 effect with a versioned publication payload.',
    );
  }

  const attempt = deps.store.inspectRecord({
    schemaVersion: 1,
    entity: 'attempt',
    id: effect.intent.attemptId,
  });

  if (attempt.outcome === 'rejected') {
    return attempt;
  }

  if (attempt.value?.entity !== 'attempt') {
    return rejected('state_not_found', 'The publication attempt does not exist.');
  }

  const job = deps.store.inspectRecord({
    schemaVersion: 1,
    entity: 'job',
    id: attempt.value.record.jobId,
  });

  if (job.outcome === 'rejected') {
    return job;
  }

  if (job.value?.entity !== 'job') {
    return rejected('state_not_found', 'The publication job does not exist.');
  }

  const publication = payload.data.publication;
  const sha = publication.kind === 'pull-request' ? publication.headSha : publication.target.sha;

  if (attempt.value.record.commit !== sha) {
    return rejected('github_conflict', 'Publication must name the accepted attempt commit.');
  }

  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        projectId: job.value.record.projectId,
        jobId: job.value.record.id,
        attemptId: effect.intent.attemptId,
        effectId: effect.intent.id,
        key: effect.intent.key,
        publication,
      }),
    )
    .digest('hex');
  const marker = `<!-- astack:publication:v1:${digest} -->`;
  function validReceipt(value: unknown): GithubPublicationReceipt | null {
    const result = githubPublicationReceiptSchema.safeParse(value);

    if (!result.success) {
      return null;
    }

    const receipt = result.data;

    if (
      receipt.marker !== marker ||
      receipt.kind !== publication.kind ||
      receipt.actor.toLowerCase() !== publication.actor.toLowerCase() ||
      receipt.target.host !== publication.target.host ||
      receipt.target.repository !== publication.target.repository ||
      receipt.target.sha !== sha ||
      (publication.kind !== 'pull-request' && receipt.target.number !== publication.target.number)
    ) {
      return null;
    }

    return receipt;
  }

  if (effect.state === 'confirmed') {
    return validReceipt(effect.evidence?.receipt)
      ? { schemaVersion: 1, outcome: 'persisted', disposition: 'existing', value: effect }
      : rejected('state_invalid_data', 'Saved publication receipt does not match this effect.');
  }

  if (effect.state === 'cancelled') {
    return rejected(
      'github_conflict',
      'This publication effect was rejected before sending; do not reuse it.',
    );
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'Publication was cancelled before a new provider effect.');
  }

  if (request.mode === 'reconcile' && (!effect.claim || !request.originalWriterStopped)) {
    return rejected(
      'state_reconciliation_required',
      'Reconciliation requires a saved claim and host confirmation that the original writer and its children stopped.',
    );
  }

  if (request.mode === 'publish' && (effect.claim !== null || effect.state === 'unknown')) {
    return rejected(
      'state_reconciliation_required',
      'A previously claimed publication may have been sent; reconcile instead of retrying.',
    );
  }

  let claimRequest: StateClaimRequest | null = null;

  if (request.mode === 'publish') {
    try {
      claimRequest = {
        schemaVersion: 1,
        effectId: effect.intent.id,
        owner: deps.nextId(),
        token: deps.nextId(),
        leaseMs: 30000,
      };
    } catch {
      return rejected(
        'state_unavailable',
        'Publication controller identifiers could not be allocated; no provider effect was attempted.',
      );
    }
  }

  const claimed = claimRequest
    ? deps.store.claimEffect(claimRequest)
    : {
        schemaVersion: 1 as const,
        outcome: 'persisted' as const,
        disposition: 'existing' as const,
        value: effect,
      };

  if (claimed.outcome !== 'persisted') {
    return claimed;
  }

  if (request.mode === 'publish' && claimed.disposition === 'existing') {
    return rejected(
      'state_reconciliation_required',
      'Another controller already claimed this effect.',
    );
  }

  const claim = claimed.value.claim;

  if (!claim) {
    return rejected('state_invalid_data', 'The publication effect has no saved claim.');
  }

  let state: 'confirmed' | 'unknown' | 'cancelled' = 'unknown';
  let receipt: GithubPublicationReceipt | null = null;
  let code = 'github_write_uncertain';
  let retryAfterMs: number | null = null;
  let cause: string | null = null;

  try {
    if (request.mode === 'reconcile') {
      const result = await deps.provider.findPublication(
        { publication, marker, root: request.root },
        signal,
      );

      if (result.outcome === 'completed') {
        receipt = validReceipt(result.value);
      } else {
        code = result.error.code;
        retryAfterMs = result.error.retryAfterMs ?? null;
      }
    } else {
      const result = await deps.provider.publish(
        { publication, marker, root: request.root },
        signal,
      );

      if (result.outcome === 'completed') {
        receipt = validReceipt(result.value);
      } else if (result.outcome === 'rejected') {
        // The provider contract guarantees rejected means no POST was attempted.
        state = 'cancelled';
        code = result.error.code;
        retryAfterMs = result.error.retryAfterMs ?? null;
      } else {
        cause = result.error.cause ?? null;
        retryAfterMs = result.error.retryAfterMs ?? null;
      }
    }

    if (receipt) {
      state = 'confirmed';
    }
  } catch {
    // A thrown provider cannot establish non-delivery.
    state = 'unknown';
  }

  return deps.store.resolveEffect({
    schemaVersion: 1,
    effectId: effect.intent.id,
    owner: claim.owner,
    token: claim.token,
    state,
    evidence: {
      kind: 'github-publication:v1',
      marker,
      receipt: receipt ? { ...receipt } : null,
      code: state === 'confirmed' ? null : code,
      retryAfterMs,
      cause,
      source: request.mode === 'reconcile' ? 'host-reconciliation' : 'provider',
      originalWriterStopped: request.mode === 'reconcile' && request.originalWriterStopped,
    },
  });
}
