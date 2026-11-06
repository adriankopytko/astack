import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { delimiter, join } from 'node:path';
import { hostConfigurationPolicySchema } from '../contracts/configuration.js';
import { completed, rejected, type OperationResult } from '../contracts/operation-result.js';
import type { ServiceJob } from '../contracts/service.js';
import type { StateStore } from '../ports/state-store.js';
import type { ConfigurationReader } from '../ports/configuration.js';
import { selectProjectContext } from '../application/select-project-context.js';
import type { ProjectDependencies } from '../application/project-facts.js';
import type { createAgentPorts } from '../application/agent-ports.js';

type Phase = 'before' | 'after';
export function agentHookId(attemptId: string, phase: Phase): string {
  return `agent-hook-${createHash('sha256').update(`${attemptId}:${phase}`).digest('hex')}`;
}

async function shell(
  script: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  environment: Record<string, string>,
): Promise<'succeeded' | 'failed' | 'unknown'> {
  if (signal.aborted) {
    return 'unknown';
  }

  return new Promise((resolve) => {
    let settled = false;
    let stopped = false;
    const child = spawn('/bin/sh', ['-c', script], {
      cwd,
      env: {
        ...process.env,
        ...environment,
        PATH: [join(cwd, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
      },
      detached: true,
      stdio: 'ignore',
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopped = true;

      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          stopped = true;
        }
      }

      killTimer = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            stopped = true;
          }
        }

        finish('unknown');
      }, 1000);
    };

    const timer = setTimeout(stop, timeoutMs);
    const finish = (result: 'succeeded' | 'failed' | 'unknown') => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', stop);
      resolve(result);
    };

    signal.addEventListener('abort', stop, { once: true });

    if (signal.aborted) {
      stop();
    }

    child.once('error', () => finish('failed'));
    child.once('exit', (code) => finish(stopped ? 'unknown' : code === 0 ? 'succeeded' : 'failed'));
  });
}

export function createAgentHooks(
  deps: ProjectDependencies & {
    state: StateStore;
    configuration: ConfigurationReader;
    ports?: ReturnType<typeof createAgentPorts>;
  },
) {
  return {
    async run(job: ServiceJob, phase: Phase, signal: AbortSignal): Promise<OperationResult<null>> {
      try {
        const parsed = hostConfigurationPolicySchema.safeParse(
          await deps.configuration.readJobPolicy?.(job.job.id, signal),
        );

        if (!parsed.success) {
          return rejected(
            'configuration_blocked',
            'The accepted job configuration is unavailable.',
          );
        }

        const script = parsed.data.execution.agentSettings?.[job.entry.role]?.hooks?.[phase];
        const configuredPorts = parsed.data.execution.agentSettings?.[job.entry.role]?.ports;

        if (configuredPorts && Object.keys(configuredPorts).length && !deps.ports) {
          return rejected(
            'resource_blocked',
            'This service cannot allocate configured agent ports.',
          );
        }

        const releasePorts = () =>
          deps.ports?.release(job.job.id, job.attempt.id, job.entry.role, signal) ??
          Promise.resolve(completed(null));
        const ports = deps.ports
          ? await deps.ports.environment(
              job.job.id,
              job.attempt.id,
              job.entry.role,
              signal,
              phase === 'before',
            )
          : completed({});

        if (ports.outcome === 'rejected') {
          return ports;
        }

        if (!script) {
          return phase === 'after' ? releasePorts() : completed(null);
        }

        if (phase === 'after' && job.entry.control?.phase === 'cancelled' && !job.entry.claim) {
          const before = deps.state.inspectRecord({
            schemaVersion: 1,
            entity: 'resource',
            id: agentHookId(job.attempt.id, 'before'),
          });

          if (before.outcome === 'rejected') {
            return before;
          }

          if (!before.value) {
            return releasePorts();
          }
        }

        const id = agentHookId(job.attempt.id, phase);
        const read = deps.state.inspectRecord({ schemaVersion: 1, entity: 'resource', id });

        if (read.outcome === 'rejected') {
          return read;
        }

        if (read.value) {
          const record = read.value.entity === 'resource' ? read.value.record : null;

          return record?.releaseEvidence?.outcome === 'succeeded'
            ? phase === 'after'
              ? releasePorts()
              : completed(null)
            : rejected(
                'hook_blocked',
                `The ${phase} hook failed or has an uncertain outcome; inspect its saved record.`,
              );
        }

        const selected = await selectProjectContext(
          { schemaVersion: 1, projectId: job.job.projectId, checkoutId: job.job.checkoutId },
          deps,
          signal,
        );

        if (selected.outcome === 'rejected' || !selected.value.checkout) {
          return rejected('hook_blocked', `The ${phase} hook checkout is unavailable.`);
        }

        const recorded = deps.state.retainResource({
          schemaVersion: 1,
          resource: {
            id,
            attemptId: job.attempt.id,
            kind: `agent-hook-${phase}`,
            key: phase,
            createdAt: job.job.createdAt,
            handle: { phase, scriptDigest: createHash('sha256').update(script).digest('hex') },
          },
        });

        if (recorded.outcome !== 'persisted' || recorded.disposition !== 'created') {
          return rejected(
            'hook_blocked',
            `The ${phase} hook intent is uncertain; inspect before retrying.`,
          );
        }

        const timeoutMs =
          parsed.data.execution.agentSettings?.[job.entry.role]?.hookTimeouts?.[phase] ??
          (phase === 'before' ? 600_000 : 60_000);
        const outcome = await shell(
          script,
          selected.value.checkout.checkout.rootPath,
          timeoutMs,
          signal,
          ports.value,
        );

        if (outcome === 'unknown') {
          return rejected(
            'hook_blocked',
            `The ${phase} hook outcome is unknown; inspect before retrying.`,
          );
        }

        const saved = deps.state.releaseResource({
          schemaVersion: 1,
          resourceId: id,
          attemptId: job.attempt.id,
          evidence: { outcome },
        });

        if (saved.outcome !== 'persisted' || outcome !== 'succeeded') {
          return rejected('hook_blocked', `The ${phase} hook failed or could not be recorded.`);
        }

        return phase === 'after' ? releasePorts() : completed(null);
      } catch {
        return rejected('hook_unavailable', `The ${phase} hook could not be executed.`);
      }
    },
  };
}
