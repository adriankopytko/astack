import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { processRequestSchema, processResultSchema } from '../../contracts/process.js';
import {
  herdrSnapshotSchema,
  type HerdrTarget,
  type HerdrServer,
  type HerdrSnapshot,
  type HerdrSpace,
} from '../../contracts/herdr.js';
import { completed, rejected, type OperationResult } from '../../contracts/operation-result.js';
import type { HerdrProvider, HerdrEndpointReader } from '../../ports/herdr.js';
import type { RuntimePaneProbe, InteractiveWorkerProvider } from '../../ports/runtime.js';
import type { ProcessRunner } from '../../ports/process-runner.js';
import { herdrPromptArgs } from './prompt-args.js';

const worktree = z.object({
  checkout_path: z.string(),
  repo_root: z.string(),
  repo_key: z.string(),
  is_linked_worktree: z.boolean(),
});
const workspace = z.object({
  workspace_id: z.string(),
  label: z.string(),
  worktree: worktree.nullable().optional(),
});
const pane = z.object({
  workspace_id: z.string(),
  tab_id: z.string(),
  pane_id: z.string(),
  terminal_id: z.string(),
  cwd: z.string().nullable().optional(),
  foreground_cwd: z.string().nullable().optional(),
});
const agent = pane.extend({
  name: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  agent_status: z.enum(['idle', 'working', 'blocked', 'done', 'unknown']),
  agent_session: z.object({ kind: z.string(), value: z.string() }).nullable().optional(),
});
const snapshotResponse = z.object({
  result: z.object({
    type: z.literal('session_snapshot'),
    snapshot: z.object({
      protocol: z.literal(22),
      workspaces: z.array(workspace),
      tabs: z.array(z.object({ tab_id: z.string(), workspace_id: z.string() })),
      panes: z.array(pane),
      agents: z.array(agent),
    }),
  }),
});

function handle(value: z.infer<typeof pane>) {
  return {
    workspaceId: value.workspace_id,
    tabId: value.tab_id,
    paneId: value.pane_id,
    terminalId: value.terminal_id,
  };
}

function coherent(value: HerdrSnapshot): boolean {
  const workspaces = new Map(value.workspaces.map((item) => [item.id, item]));
  const tabs = new Map(value.tabs.map((item) => [item.id, item]));
  const panes = new Map(value.panes.map((item) => [item.paneId, item]));

  return (
    workspaces.size === value.workspaces.length &&
    tabs.size === value.tabs.length &&
    panes.size === value.panes.length &&
    new Set(value.agents.map((item) => item.paneId)).size === value.agents.length &&
    value.tabs.every((item) => workspaces.has(item.workspaceId)) &&
    value.panes.every((item) => tabs.get(item.tabId)?.workspaceId === item.workspaceId) &&
    value.agents.every((item) => {
      const existing = panes.get(item.paneId);

      return (
        existing?.workspaceId === item.workspaceId &&
        existing.tabId === item.tabId &&
        existing.terminalId === item.terminalId
      );
    })
  );
}

/** Uses only explicit socket/session environment, explicit targets and bounded noninteractive CLI calls. */
export function createHerdrCliProvider(options: {
  executable: string;
  runner: ProcessRunner;
  endpoint: HerdrEndpointReader;
  environment?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}): HerdrProvider & InteractiveWorkerProvider & RuntimePaneProbe {
  async function invoke(
    target: HerdrTarget,
    cwd: string,
    args: string[],
    signal?: AbortSignal,
    expected?: HerdrServer,
    timeoutMs = options.timeoutMs ?? 10_000,
  ): Promise<OperationResult<{ body: unknown; server: HerdrServer }>> {
    if (!isAbsolute(options.executable)) {
      return rejected('herdr_unavailable', 'Select an absolute trusted Herdr executable.');
    }

    if (signal?.aborted) {
      return rejected('cancelled', 'Herdr operation was cancelled before invocation.');
    }

    try {
      const before = await options.endpoint.read(target);
      const server: HerdrServer = { ...before, protocol: 22 };

      if (expected && !isDeepStrictEqual(server, expected)) {
        return rejected(
          'herdr_conflict',
          'Herdr endpoint changed; inspect saved handles before continuing.',
        );
      }

      const env: Record<string, string> = {};

      for (const key of ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'HERDR_CONFIG_PATH']) {
        const value = options.environment?.[key];

        if (value !== undefined) {
          env[key] = value;
        }
      }

      Object.assign(env, {
        HERDR_SOCKET_PATH: target.socketPath,
        HERDR_SESSION: target.session,
        HERDR_DISABLE_SOUND: '1',
        NO_COLOR: '1',
      });
      const request = processRequestSchema.safeParse({
        schemaVersion: 1,
        executable: options.executable,
        args,
        cwd,
        env,
        timeoutMs,
        maxCaptureBytes: 4_194_304,
      });

      if (!request.success || timeoutMs > 120_000) {
        return rejected('herdr_unavailable', 'Herdr process settings exceed the supported bounds.');
      }

      const execution = processResultSchema.parse(await options.runner.run(request.data, signal));

      if (execution.outcome === 'rejected') {
        return rejected(
          'herdr_unavailable',
          'Herdr could not be invoked; no fallback runtime was selected.',
        );
      }

      if (
        execution.outcome !== 'exited' ||
        execution.exitCode !== 0 ||
        execution.signal !== null ||
        execution.error !== null ||
        !execution.stdout.complete ||
        execution.stdout.truncated ||
        execution.stdout.text.includes('\uFFFD') ||
        Buffer.byteLength(execution.stdout.text) !== execution.stdout.capturedBytes ||
        !execution.stderr.complete ||
        execution.stderr.truncated ||
        execution.shutdown.processGroup !== 'absent'
      ) {
        return rejected(
          'herdr_unavailable',
          'Herdr returned incomplete or uncertain evidence; inspect before retrying writes.',
        );
      }

      const after = await options.endpoint.read(target);

      if (!isDeepStrictEqual(before, after)) {
        return rejected(
          'herdr_conflict',
          'Herdr endpoint changed during the request; preserve pending intent.',
        );
      }

      const body: unknown = JSON.parse(execution.stdout.text);

      return completed({ body, server });
    } catch {
      return rejected(
        'herdr_unavailable',
        'Herdr is unavailable or its endpoint is unsafe; start/select the intended server explicitly.',
      );
    }
  }

  async function guard(
    space: HerdrSpace,
    launch: boolean,
    signal?: AbortSignal,
    allowWorking = false,
  ) {
    const response = await provider.snapshot(space.target, space.root, signal);

    if (response.outcome === 'rejected') {
      return response;
    }

    const snapshot = response.value;
    const handle = space.handle;
    const pane = snapshot.panes.find((item) => item.paneId === handle?.paneId);
    const occupants = snapshot.agents.filter(
      (item) =>
        item.kind !== null &&
        (item.paneId === handle?.paneId || item.name === space.expectedAgentName),
    );
    const occupant = occupants[0];

    if (
      !handle ||
      !space.expectedAgentName ||
      !isDeepStrictEqual(snapshot.server, space.server) ||
      !pane ||
      pane.workspaceId !== handle.workspaceId ||
      pane.tabId !== handle.tabId ||
      pane.terminalId !== handle.terminalId ||
      pane.cwd !== space.root ||
      pane.foregroundCwd !== space.root ||
      (launch
        ? occupants.length !== 0
        : occupants.length !== 1 ||
          !space.agent ||
          space.agent.name !== space.expectedAgentName ||
          space.agent.kind !== 'codex' ||
          !occupant ||
          occupant.paneId !== handle.paneId ||
          occupant.terminalId !== handle.terminalId ||
          occupant.workspaceId !== handle.workspaceId ||
          occupant.tabId !== handle.tabId ||
          occupant.name !== space.expectedAgentName ||
          occupant.kind !== 'codex' ||
          (space.agent.nativeSessionId !== null &&
            occupant.nativeSessionId !== space.agent.nativeSessionId) ||
          occupant.cwd !== space.root ||
          occupant.foregroundCwd !== space.root ||
          occupant.status === 'blocked' ||
          occupant.status === 'unknown' ||
          (!allowWorking && occupant.status === 'working'))
    ) {
      return rejected(
        'runtime_conflict',
        'Fresh Herdr target evidence does not match the reserved worker.',
      );
    }

    return completed(null);
  }

  async function control(
    space: HerdrSpace,
    args: string[],
    type: string,
    launch: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ) {
    const checked = await guard(space, launch, signal, type === 'ok');

    if (checked.outcome === 'rejected') {
      return checked;
    }

    const response = await invoke(space.target, space.root, args, signal, space.server, timeoutMs);

    if (response.outcome === 'rejected') {
      return response;
    }

    return z.object({ result: z.object({ type: z.literal(type) }) }).safeParse(response.value.body)
      .success
      ? completed(null)
      : rejected('herdr_invalid_output', 'Herdr did not acknowledge the requested runtime action.');
  }

  const provider: HerdrProvider & InteractiveWorkerProvider & RuntimePaneProbe = {
    async probe(input, signal) {
      const checked = await guard(input.space, true, signal);

      if (checked.outcome === 'rejected') {
        return checked;
      }

      if (
        !isAbsolute(input.executable) ||
        !input.space.handle ||
        input.timeoutMs < 1000 ||
        input.timeoutMs > 30_000
      ) {
        return rejected('runtime_capability_missing', 'Invalid pane validation bounds.');
      }

      // Only a trusted executable and a base64 program enter the shell; no raw policy/task interpolation.
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      const encoded = Buffer.from(input.program).toString('base64');
      const loader = `eval(Buffer.from('${encoded}','base64').toString())`;
      const exitMarker = `${input.marker}_EXIT`;
      const encodedExit = Buffer.from(exitMarker).toString('base64');
      const reporter = `process.stdout.write("\\n"+Buffer.from('${encodedExit}','base64').toString()+":"+process.argv[1]+"\\n")`;
      // The second process reports the first process's shell exit status; neither marker appears in command echo.
      const command = `${quote(input.executable)} -e ${quote(loader)}; ${quote(input.executable)} -e ${quote(reporter)} "$?"`;
      const started = Date.now();
      const deadline = AbortSignal.timeout(input.timeoutMs);
      const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const sent = await invoke(
        input.space.target,
        input.space.root,
        ['pane', 'run', input.space.handle.paneId, command],
        bounded,
        input.space.server,
        input.timeoutMs,
      );

      if (sent.outcome === 'rejected') {
        return sent;
      }

      while (!bounded.aborted && Date.now() - started < input.timeoutMs) {
        const response = await invoke(
          input.space.target,
          input.space.root,
          [
            'pane',
            'read',
            input.space.handle.paneId,
            '--source',
            'recent-unwrapped',
            '--format',
            'text',
          ],
          bounded,
          input.space.server,
          input.timeoutMs,
        );

        if (response.outcome === 'rejected') {
          return response;
        }

        const parsed = z
          .object({
            result: z.object({
              type: z.literal('pane_read'),
              read: z.object({
                pane_id: z.string(),
                tab_id: z.string(),
                workspace_id: z.string(),
                text: z.string().max(1_048_576),
                truncated: z.literal(false),
                source: z.literal('recent-unwrapped'),
                format: z.literal('text'),
              }),
            }),
          })
          .safeParse(response.value.body);
        const output = parsed.success ? parsed.data.result.read : null;
        const handle = input.space.handle;

        if (
          !output ||
          output.pane_id !== handle.paneId ||
          output.tab_id !== handle.tabId ||
          output.workspace_id !== handle.workspaceId
        ) {
          return rejected(
            'runtime_conflict',
            'Pane validation output does not match the owned terminal.',
          );
        }

        const exitLines = output.text
          .replaceAll('\r', '')
          .split('\n')
          .filter((line) => line.startsWith(exitMarker + ':'));

        if (exitLines.length > 0) {
          if (
            exitLines.length !== 1 ||
            exitLines[0] !== exitMarker + ':0' ||
            output.text.split(exitMarker + ':').length !== 2
          ) {
            return rejected(
              'runtime_unavailable',
              'Pane validator exit evidence is failed or duplicated.',
            );
          }

          const after = await guard(input.space, true, bounded);

          return after.outcome === 'rejected' ? after : completed(output.text);
        }

        try {
          await delay(100, undefined, { signal: bounded });
        } catch {
          break;
        }
      }

      return rejected(
        'runtime_unavailable',
        'Pane validation timed out; its saved invocation must not replay.',
      );
    },
    async launch(input, signal) {
      return control(
        input.space,
        [
          'agent',
          'start',
          input.space.expectedAgentName ?? '',
          '--kind',
          'codex',
          '--pane',
          input.space.handle?.paneId ?? '',
          '--timeout',
          String(Math.min(input.timeoutMs - 1000, 29_000)),
          '--',
          ...input.args,
          '-c',
          'check_for_update_on_startup=false',
          '--cd',
          input.space.root,
        ],
        'agent_started',
        true,
        signal,
        input.timeoutMs,
      );
    },
    async input(space, text, signal) {
      return control(
        space,
        herdrPromptArgs(space.expectedAgentName ?? '', text),
        'agent_prompted',
        false,
        signal,
      );
    },
    async interrupt(space, signal) {
      return control(
        space,
        ['agent', 'send-keys', space.expectedAgentName ?? '', 'esc'],
        'ok',
        false,
        signal,
      );
    },
    async snapshot(target, cwd, signal) {
      const response = await invoke(target, cwd, ['api', 'snapshot'], signal);

      if (response.outcome === 'rejected') {
        return response;
      }

      const raw = snapshotResponse.safeParse(response.value.body);

      if (!raw.success) {
        return rejected(
          'herdr_unsupported',
          'Herdr snapshot must match the supported protocol 22 contract.',
        );
      }

      const value = raw.data.result.snapshot;
      const parsed = herdrSnapshotSchema.safeParse({
        server: response.value.server,
        workspaces: value.workspaces.map((item) => ({
          id: item.workspace_id,
          label: item.label,
          worktree: item.worktree
            ? {
                checkoutPath: item.worktree.checkout_path,
                repositoryRoot: item.worktree.repo_root,
                repositoryKey: item.worktree.repo_key,
                linked: item.worktree.is_linked_worktree,
              }
            : null,
        })),
        tabs: value.tabs.map((item) => ({ id: item.tab_id, workspaceId: item.workspace_id })),
        panes: value.panes.map((item) => ({
          ...handle(item),
          cwd: item.cwd ?? null,
          foregroundCwd: item.foreground_cwd ?? null,
        })),
        agents: value.agents.map((item) => ({
          ...handle(item),
          name: item.name ?? null,
          kind: item.agent ?? null,
          nativeSessionId: item.agent_session?.kind === 'id' ? item.agent_session.value : null,
          cwd: item.cwd ?? null,
          foregroundCwd: item.foreground_cwd ?? null,
          status: item.agent_status,
        })),
      });

      return parsed.success && coherent(parsed.data)
        ? completed(parsed.data)
        : rejected('herdr_invalid_output', 'Herdr layout evidence is incomplete or contradictory.');
    },
    async createPrimary(input, signal) {
      const result = await invoke(
        input.target,
        input.root,
        ['workspace', 'create', '--cwd', input.root, '--label', input.label, '--no-focus'],
        signal,
        input.server,
      );

      if (result.outcome === 'rejected') {
        return result;
      }

      return z
        .object({ result: z.object({ type: z.literal('workspace_created') }) })
        .safeParse(result.value.body).success
        ? completed(null)
        : rejected('herdr_invalid_output', 'Herdr did not acknowledge workspace creation.');
    },
    async openWorker(input, signal) {
      const result = await invoke(
        input.target,
        input.root,
        [
          'worktree',
          'open',
          '--workspace',
          input.parent,
          '--path',
          input.root,
          '--label',
          input.label,
          '--no-focus',
        ],
        signal,
        input.server,
      );

      if (result.outcome === 'rejected') {
        return result;
      }

      const parsed = z
        .object({
          result: z.object({ type: z.literal('worktree_opened'), already_open: z.boolean() }),
        })
        .safeParse(result.value.body);

      return parsed.success
        ? completed({ alreadyOpen: parsed.data.result.already_open })
        : rejected(
            'herdr_invalid_output',
            'Herdr did not acknowledge the requested worktree opening.',
          );
    },
  };

  return provider;
}
