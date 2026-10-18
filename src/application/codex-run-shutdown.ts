import { isDeepStrictEqual } from 'node:util';
import { completed, rejected } from '../contracts/operation-result.js';
import type { RuntimeStore } from '../ports/runtime.js';
import type { HerdrProvider } from '../ports/herdr.js';
import type { RunShutdownVerifier } from '../ports/runs.js';

export function createCodexRunShutdownVerifier(deps: {
  runtime: RuntimeStore;
  provider: HerdrProvider;
  now: () => number;
}): RunShutdownVerifier {
  return {
    async verify({ run, request }, signal) {
      const saved = deps.runtime.read(request.attemptId);

      if (saved.outcome === 'rejected') {
        return saved;
      }

      const session = saved.value;

      if (
        !session ||
        session.phase !== 'ready' ||
        session.launchId !== request.launchId ||
        session.jobId !== request.jobId ||
        session.effectId !== run.job.effect.intent.id ||
        session.space.checkoutId !== run.job.job.checkoutId ||
        !session.agent ||
        !session.space.handle ||
        !isDeepStrictEqual(run.job.entry.observation?.handle, {
          runtime: session.runtime,
          launchId: session.launchId,
          spaceId: session.space.id,
        })
      ) {
        return rejected(
          'runtime_conflict',
          'The launch does not match the saved owned worker handle.',
        );
      }

      const pending = deps.runtime.pending(request.attemptId);

      if (pending.outcome === 'rejected') {
        return pending;
      }

      if (pending.value) {
        return rejected(
          'state_reconciliation_required',
          'Resolve the pending runtime action before releasing holds.',
        );
      }

      // Use the primary root: the owned worker checkout may already have been safely removed.
      const snapshot = await deps.provider.snapshot(
        session.space.target,
        session.space.primaryRoot ?? session.space.root,
        signal,
      );

      if (snapshot.outcome === 'rejected') {
        return snapshot;
      }

      const observed = snapshot.value;
      const handle = session.space.handle;

      if (
        !isDeepStrictEqual(observed.server, session.space.server) ||
        observed.workspaces.some((workspace) => workspace.id === handle.workspaceId) ||
        observed.panes.some(
          (pane) => pane.terminalId === handle.terminalId || pane.paneId === handle.paneId,
        ) ||
        observed.agents.some(
          (agent) => agent.name === session.agent?.name || agent.terminalId === handle.terminalId,
        )
      ) {
        return rejected(
          'state_reconciliation_required',
          'The same provider must confirm that the owned workspace and agent are absent.',
        );
      }

      return completed({
        request,
        source: 'host-attestation' as const,
        workerHandle: {
          runtime: session.runtime,
          launchId: session.launchId,
          spaceId: session.space.id,
        },
        resourceBindings: [
          {
            id: `worker:${request.attemptId}`,
            kind: 'worker',
            key: request.attemptId,
            handle: {
              runtime: session.runtime,
              launchId: session.launchId,
              spaceId: session.space.id,
            },
          },
          {
            id: `runtime:${session.launchId}`,
            kind: 'interactive-runtime',
            key: session.launchId,
            handle: {
              runtime: session.runtime,
              launchId: session.launchId,
              spaceId: session.space.id,
            },
          },
          {
            id: `herdr:${session.space.id}`,
            kind: 'herdr-space',
            key: session.space.id,
            handle: {
              target: session.space.target,
              server: session.space.server,
              layout: session.space.handle,
            },
          },
          {
            id: `agent:${session.space.id}`,
            kind: 'herdr-agent',
            key: session.space.id,
            handle: {
              target: session.space.target,
              server: session.space.server,
              layout: session.space.handle,
              agent: session.agent,
            },
          },
        ],
        verifiedAt: deps.now(),
        providerEvidence: {
          runtime: session.runtime,
          reason: 'owned-workspace-and-agent-absent',
          server: session.space.server,
        },
        releasedResourceIds: [],
      });
    },
  };
}
