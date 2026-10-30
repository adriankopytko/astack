import {
  verificationApprovalSchema,
  type HostConfigurationPolicy,
} from '../contracts/configuration.js';
import type { ConfigurationSnapshot } from '../contracts/configuration.js';
import type { VerificationRequest } from '../contracts/verification.js';
import { configurationDigest } from './configuration.js';
export class VerificationApprovalError extends Error {
  constructor(check: string) {
    super(
      `Verification check ${check} requires an approved command and a deadline within the host limit.`,
    );
  }
}
export function verificationApproval(policy: HostConfigurationPolicy, role: string) {
  const spec = policy.execution.verification?.[role];

  if (!spec) {
    return undefined;
  }

  const checks: Record<string, { definitionDigest: string; commandDigest: string }> = {};

  for (const [name, definition] of Object.entries(spec.checks)) {
    const command = Object.hasOwn(policy.execution.commands, definition.command)
      ? policy.execution.commands[definition.command]
      : undefined;

    if (!command || definition.timeoutMs > policy.execution.maxTimeoutMs) {
      throw new VerificationApprovalError(name);
    }

    checks[name] = {
      definitionDigest: configurationDigest(definition),
      commandDigest: configurationDigest(command),
    };
  }

  return verificationApprovalSchema.parse({
    baseline: spec.baseline,
    checks,
    lanes: spec.lanes,
    maxAgeMs: spec.maxAgeMs,
  });
}

export function selectionFromApproval(
  approved: NonNullable<ConfigurationSnapshot['verification']>,
  role: string,
  request: VerificationRequest,
) {
  if (request.lane !== null && !Object.hasOwn(approved.lanes, request.lane)) {
    return null;
  }

  const kinds = new Map<string, 'baseline' | 'lane' | 'additional'>();

  for (const name of approved.baseline) {
    kinds.set(name, 'baseline');
  }

  for (const name of request.lane === null ? [] : approved.lanes[request.lane]!) {
    if (!kinds.has(name)) {
      kinds.set(name, 'lane');
    }
  }

  for (const name of request.additional) {
    if (!kinds.has(name)) {
      kinds.set(name, 'additional');
    }
  }

  if (kinds.size > 8) {
    return null;
  }

  const checks = [];

  for (const [name, kind] of kinds) {
    const definition = Object.hasOwn(approved.checks, name) ? approved.checks[name] : undefined;

    if (!definition) {
      return null;
    }

    checks.push({ name, kind, ...definition });
  }

  return {
    checks,
    maxAgeMs: approved.maxAgeMs,
    digest: configurationDigest({ role, policy: approved, checks }),
  };
}

export function verificationSelection(
  policy: HostConfigurationPolicy,
  role: string,
  request: VerificationRequest,
) {
  const approved = verificationApproval(policy, role);

  return approved ? selectionFromApproval(approved, role, request) : null;
}
