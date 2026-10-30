import { isDeepStrictEqual } from 'node:util';
import {
  verificationRecordSchema,
  verificationReconcileSchema,
  type VerificationRecord,
} from '../../contracts/verification.js';
import { hookRecordSchema } from '../../contracts/hooks.js';
import type { VerificationStore } from '../../ports/verification.js';
import { configurationDigest } from '../../core/configuration.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';
import { appendRunEvent } from './run-events.js';
import {
  assertVerificationSource,
  assertPassedChecks,
  assertFreshVerification,
} from './verification-evidence.js';
export function createSqliteVerificationStore(
  db: StateDatabase,
  now: () => number,
): VerificationStore {
  const read = (id: string) =>
    db.get(
      verificationRecordSchema,
      'SELECT data FROM implementation_verifications WHERE id=?',
      id,
    );
  function save(input: VerificationRecord) {
    const record = verificationRecordSchema.parse(input);
    db.statement(
      'UPDATE implementation_verifications SET status=?,revision=?,data=? WHERE id=?',
    ).run(record.status, record.revision, canonicalJson(record), record.id);
    appendRunEvent(
      db,
      {
        job: { id: record.request.jobId, projectId: record.source.projectId },
        attempt: { id: record.source.attemptId },
      },
      'verification_changed',
      record.updatedAt,
      { verificationId: record.id, status: record.status, revision: record.revision },
    );

    return record;
  }

  return {
    read: (id) => db.read(() => read(id)),
    authorize: (id, source, jobId, reportId) =>
      db.read(() => assertFreshVerification(db, id, source, jobId, reportId, now())),
    prepare(input) {
      return db.write(() => {
        const record = verificationRecordSchema.parse(input);
        const old = read(record.id);

        if (old) {
          if (!isDeepStrictEqual(old.request, record.request)) {
            stateFailure('state_conflict');
          }

          return { value: old, disposition: 'existing' };
        }

        if (
          record.id !==
            `verification-${configurationDigest({ jobId: record.request.jobId, key: record.request.key })}` ||
          record.status !== 'prepared' ||
          record.revision !== 0 ||
          record.checks.some((c) => c.outcome !== 'not_run' || c.hookId !== null) ||
          record.reconciliation
        ) {
          stateFailure('state_invalid_data');
        }

        assertVerificationSource(db, record);

        for (const check of record.checks) {
          if (
            db
              .statement('SELECT id FROM hook_invocations WHERE attempt_id=? AND request_key=?')
              .get(record.source.attemptId, check.hookKey)
          ) {
            stateFailure('state_reconciliation_required');
          }
        }

        db.statement(
          'INSERT INTO implementation_verifications(id,job_id,report_id,request_key,status,revision,data) VALUES (?,?,?,?,?,?,?)',
        ).run(
          record.id,
          record.request.jobId,
          record.request.reportId,
          record.request.key,
          record.status,
          record.revision,
          canonicalJson(record),
        );
        save(record);

        return { value: record, disposition: 'created' };
      });
    },
    update(input, expectedRevision) {
      return db.write(() => {
        const next = verificationRecordSchema.parse(input);
        const old = read(next.id) ?? stateFailure('state_not_found');

        if (
          old.revision !== expectedRevision ||
          !['prepared', 'running'].includes(old.status) ||
          next.revision !== old.revision + 1 ||
          !isDeepStrictEqual(
            {
              ...next,
              status: old.status,
              revision: old.revision,
              checks: old.checks,
              updatedAt: old.updatedAt,
              verifiedAt: old.verifiedAt,
              expiresAt: old.expiresAt,
              reason: old.reason,
            },
            old,
          )
        ) {
          stateFailure('state_conflict');
        }

        const fields = (r: VerificationRecord) =>
          r.checks.map(({ name, kind, definitionDigest, commandDigest, hookKey }) => ({
            name,
            kind,
            definitionDigest,
            commandDigest,
            hookKey,
          }));

        if (!isDeepStrictEqual(fields(next), fields(old)) || next.status === 'prepared') {
          stateFailure('state_conflict');
        }

        assertVerificationSource(db, next);

        if (next.status === 'passed') {
          assertPassedChecks(db, next);
        }

        const timestamp = now();
        const value = save({
          ...next,
          updatedAt: timestamp,
          verifiedAt: next.status === 'passed' ? timestamp : null,
          expiresAt: next.status === 'passed' ? timestamp + next.maxAgeMs : null,
        });

        return { value, disposition: 'updated' };
      });
    },
    reconcile(input) {
      return db.write(() => {
        const request = verificationReconcileSchema.parse(input);
        const old = read(request.id) ?? stateFailure('state_not_found');
        const reconciliation = {
          key: request.key,
          expectedRevision: request.expectedRevision,
          writersStopped: true as const,
        };

        if (old.reconciliation) {
          if (!isDeepStrictEqual(old.reconciliation, reconciliation)) {
            stateFailure('state_conflict');
          }

          return { value: old, disposition: 'existing' };
        }

        if (
          old.revision !== request.expectedRevision ||
          !['prepared', 'running'].includes(old.status)
        ) {
          stateFailure('state_conflict');
        }

        for (const check of old.checks) {
          const hook = check.hookId
            ? db.get(hookRecordSchema, 'SELECT data FROM hook_invocations WHERE id=?', check.hookId)
            : null;

          if (hook?.status === 'executing' && !hook.writerExclusion && !hook.shutdown) {
            stateFailure('state_reconciliation_required');
          }
        }

        const value = save({
          ...old,
          status: old.status === 'prepared' ? 'cancelled' : 'unknown',
          reason: 'writer_excluded',
          reconciliation,
          revision: old.revision + 1,
          updatedAt: now(),
        });

        return { value, disposition: 'updated' };
      });
    },
  };
}
