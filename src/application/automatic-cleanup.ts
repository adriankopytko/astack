import { completed } from '../contracts/operation-result.js';
import { executeCleanup, type CleanupDependencies } from './cleanup.js';
import type { CleanupStore } from '../ports/cleanup.js';

/** Starting without execution authority suspends backlog. Re-enabling never resumes it implicitly. */
export function suspendCleanupExecutor(store: CleanupStore, now: () => number) {
  let after = '';

  do {
    const page = store.list({ after, limit: 32 });

    if (page.outcome === 'rejected') {
      return page;
    }

    for (const plan of page.value.items) {
      if (!plan.request.automatic || !['requested', 'blocked'].includes(plan.phase)) {
        continue;
      }

      const saved = store.transition({
        jobId: plan.request.jobId,
        expectedRevision: plan.revision,
        phase: 'suspended',
        reason: 'executor_disabled',
        now: now(),
      });

      if (saved.outcome !== 'persisted') {
        return saved;
      }
    }

    after = page.value.nextCursor ?? '';
  } while (after);

  return completed(null);
}

/** Local wakes plus retention timers only: no GitHub polling and no inferred shutdown. */
export function createCleanupExecutor(deps: CleanupDependencies, onFailure: () => void) {
  const controller = new AbortController();
  let stopped = false;
  let requested = false;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function wake() {
    if (stopped) {
      return;
    }

    requested = true;

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    if (running) {
      return;
    }

    running = (async () => {
      do {
        requested = false;
        let after = '';
        let nextAt = Number.POSITIVE_INFINITY;

        do {
          const page = deps.cleanups.list({ after, limit: 32 });

          if (page.outcome === 'rejected') {
            throw new Error('cleanup_state_unavailable');
          }

          for (const plan of page.value.items) {
            if (stopped || controller.signal.aborted) {
              return;
            }

            if (!plan.request.automatic || !['requested', 'blocked'].includes(plan.phase)) {
              continue;
            }

            if (plan.request.notBefore > deps.now()) {
              nextAt = Math.min(nextAt, plan.request.notBefore);

              continue;
            }

            const result = await executeCleanup(
              { schemaVersion: 1, jobId: plan.request.jobId, expectedRevision: plan.revision },
              deps,
              controller.signal,
            );

            if (
              result.outcome === 'uncertain' ||
              (result.outcome === 'rejected' &&
                !['cancelled', 'state_conflict', 'state_reconciliation_required'].includes(
                  result.error.code,
                ))
            ) {
              throw new Error('cleanup_state_unavailable');
            }
          }

          after = page.value.nextCursor ?? '';
        } while (after && !stopped);

        if (!requested && !stopped && Number.isFinite(nextAt)) {
          timer = setTimeout(wake, Math.min(2147483647, Math.max(1, nextAt - deps.now())));
          timer.unref();
        }
      } while (requested && !stopped);
    })()
      .catch(() => {
        if (!stopped) {
          stopped = true;
          onFailure();
        }
      })
      .finally(() => {
        running = null;
      });
  }

  return {
    wake,
    start: wake,
    async stop() {
      stopped = true;
      controller.abort();

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      await running;
    },
  };
}
