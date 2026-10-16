import { checkoutRecordSchema } from '../../contracts/project-context.js';
import {
  worktreeRecordSchema,
  type WorktreeIntent,
  type WorktreeRecord,
} from '../../contracts/worktrees.js';
import {
  stateAttemptSchema,
  stateJobSchema,
  stateResourceIntentSchema,
} from '../../contracts/state.js';
import type { WorktreeStore } from '../../ports/worktrees.js';
import { canonicalJson, type StateDatabase } from './database.js';
import { stateFailure } from './errors.js';

function assignment(intent: WorktreeIntent): string {
  return canonicalJson({
    projectId: intent.projectId,
    repositoryId: intent.repositoryId,
    sourceCheckoutId: intent.sourceCheckoutId,
    run: intent.run,
    key: intent.key,
    branch: intent.branch,
    baseCommit: intent.baseCommit,
    managedRoot: intent.managedRoot,
  });
}

export function createSqliteWorktreeStore(db: StateDatabase, now: () => number): WorktreeStore {
  const read = (id: string) =>
    db.get(worktreeRecordSchema, 'SELECT data FROM managed_worktrees WHERE id=?', id);
  const find = (projectId: string, key: string) =>
    db.get(
      worktreeRecordSchema,
      'SELECT data FROM managed_worktrees WHERE project_id=? AND owner_key=?',
      projectId,
      key,
    );
  const current = (record: WorktreeRecord) => {
    const saved = read(record.intent.id);

    if (
      !saved ||
      saved.revision !== record.revision ||
      saved.operationId !== record.operationId ||
      saved.phase !== record.phase ||
      canonicalJson(saved.intent) !== canonicalJson(record.intent)
    ) {
      return stateFailure('worktree_conflict');
    }

    return saved;
  };

  const save = (record: WorktreeRecord) => {
    db.statement(
      'UPDATE managed_worktrees SET phase=?, revision=?, operation_id=?, data=? WHERE id=?',
    ).run(
      record.phase,
      record.revision,
      record.operationId,
      canonicalJson(record),
      record.intent.id,
    );
  };

  return {
    read: (id) => db.read(() => read(id)),
    find: (projectId, key) => db.read(() => find(projectId, key)),
    reserve(intent, operationId) {
      return db.write(() => {
        const existing = find(intent.projectId, intent.key);

        if (existing) {
          if (assignment(existing.intent) !== assignment(intent)) {
            stateFailure('worktree_conflict');
          }

          return { value: existing, disposition: 'existing' };
        }

        if (
          db
            .statement(
              "SELECT id FROM managed_worktrees WHERE json_extract(data, '$.intent.checkoutId')=? AND phase<>'ready' LIMIT 1",
            )
            .get(intent.sourceCheckoutId)
        ) {
          stateFailure('worktree_conflict');
        }

        if (intent.run) {
          const attempt = db.get(
            stateAttemptSchema,
            'SELECT data FROM attempts WHERE id=?',
            intent.run.id,
          );
          const job = attempt
            ? db.get(stateJobSchema, 'SELECT data FROM jobs WHERE id=?', attempt.jobId)
            : null;

          if (
            !attempt ||
            !job ||
            attempt.jobId !== intent.run.jobId ||
            job.projectId !== intent.projectId ||
            job.repositoryId !== intent.repositoryId ||
            job.checkoutId !== intent.sourceCheckoutId ||
            attempt.commit !== intent.baseCommit ||
            attempt.branch !== intent.branch
          ) {
            stateFailure('worktree_conflict');
          }
        }

        const record: WorktreeRecord = {
          intent,
          phase: 'preparing',
          revision: 0,
          operationId,
          location: null,
          removalCommit: null,
          reconciliation: null,
        };
        db.statement(
          'INSERT INTO managed_worktrees(id, project_id, repository_id, source_checkout_id, attempt_id, owner_key, branch, checkout_path, phase, revision, operation_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          intent.id,
          intent.projectId,
          intent.repositoryId,
          intent.sourceCheckoutId,
          intent.run?.id ?? null,
          intent.key,
          intent.branch,
          intent.checkoutPath,
          record.phase,
          record.revision,
          operationId,
          canonicalJson(record),
        );

        return { value: record, disposition: 'created' };
      });
    },
    beginRemoval(record, operationId, head) {
      return db.write(() => {
        const saved = current(record);

        if (saved.phase !== 'ready') {
          stateFailure('worktree_conflict');
        }

        if (
          db
            .statement(
              "SELECT id FROM managed_worktrees WHERE source_checkout_id=? AND phase IN ('preparing', 'ready', 'removing') LIMIT 1",
            )
            .get(saved.intent.checkoutId) ||
          db
            .statement(
              'SELECT a.id FROM attempts a JOIN jobs j ON j.id=a.job_id WHERE j.checkout_id=? AND a.resolved_at IS NULL LIMIT 1',
            )
            .get(saved.intent.checkoutId)
        ) {
          stateFailure('state_reconciliation_required');
        }

        if (saved.intent.run) {
          const attempt = db
            .statement('SELECT resolved_at FROM attempts WHERE id=?')
            .get(saved.intent.run.id);
          const retained = db
            .statement(
              'SELECT id FROM resources WHERE attempt_id=? AND released_at IS NULL AND id<>? LIMIT 1',
            )
            .get(saved.intent.run.id, saved.intent.id);

          if (!attempt || attempt.resolved_at === null || retained) {
            stateFailure('state_reconciliation_required');
          }
        }

        const value: WorktreeRecord = {
          ...saved,
          phase: 'removing',
          removalCommit: head,
          revision: saved.revision + 1,
          operationId,
        };
        save(value);

        return { value, disposition: 'updated' };
      });
    },
    finish(record, phase, location, reconciliation) {
      return db.write(() => {
        const saved = current(record);

        if (
          !(
            (saved.phase === 'preparing' && (phase === 'ready' || phase === 'abandoned')) ||
            (saved.phase === 'removing' && (phase === 'ready' || phase === 'removed'))
          )
        ) {
          stateFailure('worktree_conflict');
        }

        const value = worktreeRecordSchema.parse({
          ...saved,
          phase,
          location,
          reconciliation,
          revision: saved.revision + 1,
        });
        const intent = saved.intent;

        if (phase === 'ready' && saved.phase === 'preparing') {
          if (
            !location ||
            location.root.path !== intent.checkoutPath ||
            location.commonDirectory.path !== intent.sourceLocation.commonDirectory.path
          ) {
            stateFailure('worktree_conflict');
          }

          const checkout = checkoutRecordSchema.parse({
            id: intent.checkoutId,
            projectId: intent.projectId,
            repositoryId: intent.repositoryId,
            rootPath: intent.checkoutPath,
            gitCommonDirectory: intent.sourceLocation.commonDirectory.path,
          });
          db.statement(
            'INSERT INTO checkouts(id, project_id, repository_id, root_path, data) VALUES (?, ?, ?, ?, ?)',
          ).run(
            checkout.id,
            checkout.projectId,
            checkout.repositoryId,
            checkout.rootPath,
            canonicalJson(checkout),
          );
          db.statement(
            'INSERT INTO registered_checkouts(checkout_id, project_id, repository_id, registered_at, location) VALUES (?, ?, ?, ?, ?)',
          ).run(
            checkout.id,
            checkout.projectId,
            checkout.repositoryId,
            intent.createdAt,
            canonicalJson(location),
          );

          if (intent.run) {
            const resource = stateResourceIntentSchema.parse({
              id: intent.id,
              attemptId: intent.run.id,
              kind: 'worktree',
              key: intent.checkoutId,
              createdAt: intent.createdAt,
              handle: {
                worktreeId: intent.id,
                checkoutId: intent.checkoutId,
                rootPath: intent.checkoutPath,
              },
            });
            db.statement(
              'INSERT INTO resources(id, attempt_id, kind, resource_key, data) VALUES (?, ?, ?, ?, ?)',
            ).run(
              resource.id,
              resource.attemptId,
              resource.kind,
              resource.key,
              canonicalJson(resource),
            );
          }
        }

        if (phase === 'removed' && intent.run) {
          db.statement(
            'UPDATE resources SET released_at=?, release_evidence=? WHERE id=? AND attempt_id=? AND released_at IS NULL',
          ).run(
            now(),
            canonicalJson({ gitWorktreeRemoved: true, branchPreserved: true }),
            intent.id,
            intent.run.id,
          );
        }

        save(value);

        return { value, disposition: 'updated' };
      });
    },
  };
}
