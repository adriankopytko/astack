import { z } from 'zod';
import {
  stateProjectRequestSchema,
  stateJobRequestSchema,
  stateAttemptRequestSchema,
  stateClaimRequestSchema,
  stateEffectResolutionRequestSchema,
  stateResultRequestSchema,
  stateResourceRequestSchema,
  stateResourceReleaseRequestSchema,
  stateInspectionRequestSchema,
} from '../contracts/state.js';
import { rejected, type RejectedResult } from '../contracts/operation-result.js';
import { parseOperationRequest } from '../core/parse-operation-request.js';
import type { StateStore } from '../ports/state-store.js';

function invoke<T extends z.ZodType, R>(
  schema: T,
  input: unknown,
  operation: (request: z.output<T>) => R,
  signal?: AbortSignal,
): R | RejectedResult {
  const request = parseOperationRequest(schema, input);

  if (!request.valid) {
    return request.result;
  }

  if (signal?.aborted) {
    return rejected('cancelled', 'State operation was cancelled before execution.');
  }

  return operation(request.value);
}

export function saveStateProject(input: unknown, store: StateStore, signal?: AbortSignal) {
  return invoke(stateProjectRequestSchema, input, (request) => store.saveProject(request), signal);
}

export function acceptStateJob(input: unknown, store: StateStore, signal?: AbortSignal) {
  return invoke(stateJobRequestSchema, input, (request) => store.acceptJob(request), signal);
}

export function prepareStateAttempt(input: unknown, store: StateStore, signal?: AbortSignal) {
  return invoke(
    stateAttemptRequestSchema,
    input,
    (request) => store.prepareAttempt(request),
    signal,
  );
}

export function claimStateEffect(input: unknown, store: StateStore, signal?: AbortSignal) {
  return invoke(stateClaimRequestSchema, input, (request) => store.claimEffect(request), signal);
}

export function resolveStateEffect(input: unknown, store: StateStore, signal?: AbortSignal) {
  return invoke(
    stateEffectResolutionRequestSchema,
    input,
    (request) => store.resolveEffect(request),
    signal,
  );
}

export function recordStateResult(input: unknown, store: StateStore, signal?: AbortSignal) {
  return invoke(stateResultRequestSchema, input, (request) => store.recordResult(request), signal);
}

export function retainStateResource(input: unknown, store: StateStore, signal?: AbortSignal) {
  return invoke(
    stateResourceRequestSchema,
    input,
    (request) => store.retainResource(request),
    signal,
  );
}

export function releaseStateResource(input: unknown, store: StateStore, signal?: AbortSignal) {
  return invoke(
    stateResourceReleaseRequestSchema,
    input,
    (request) => store.releaseResource(request),
    signal,
  );
}

export function inspectStateRecord(input: unknown, store: StateStore, signal?: AbortSignal) {
  return invoke(
    stateInspectionRequestSchema,
    input,
    (request) => store.inspectRecord(request),
    signal,
  );
}
