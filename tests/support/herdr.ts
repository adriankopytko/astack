import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  configureHerdrProject,
  createNodeWorktreeFiles,
  prepareWorktree,
  createWorktreeGit,
  nodeProcessRunner,
  submitServiceJob,
  type HerdrProvider,
  type HerdrSnapshot,
  type HerdrTarget,
  type HerdrDependencies,
  type HerdrResult,
  type HerdrSpace,
  type ServiceJob,
} from '../../src/index.js';
import { completed } from '../../src/contracts/operation-result.js';
import { fixture as serviceFixture, gitPath } from './service.js';

export function space(result: HerdrResult, outcome?: string): HerdrSpace {
  if (outcome) {
    assert.equal(result.outcome, outcome, JSON.stringify(result));
  }

  if (!('record' in result) || !result.record) {
    assert.fail(JSON.stringify(result));
  }

  return result.record;
}

export async function fixture(
  action: (context: {
    root: string;
    state: string;
    sources: string[];
    deps: HerdrDependencies;
    opened: Parameters<Parameters<typeof serviceFixture>[0]>[0]['opened'];
    fake: ReturnType<typeof fakeProvider>;
    configure: (index?: number, session?: string, label?: string) => Promise<void>;
    worker: (key?: string) => Promise<ServiceJob>;
  }) => Promise<void>,
) {
  await serviceFixture(async (context) => {
    const fake = fakeProvider();
    const files = createNodeWorktreeFiles(join(context.state, 'worktrees'));
    let sequence = 0;
    const deps: HerdrDependencies = {
      ...context.deps,
      state: context.opened.store,
      herdr: context.opened.herdr,
      provider: fake.provider,
      files,
      newId: () => `herdr-${++sequence}`,
    };
    const configure = async (index = 0, session = 'default', label = 'project') => {
      const result = await configureHerdrProject(
        {
          schemaVersion: 1,
          projectId: `project-${index}`,
          target: { session, socketPath: join(context.root, `${session}.sock`) },
          label,
        },
        deps,
      );

      assert.equal(result.outcome, 'persisted', JSON.stringify(result));
    };

    const worker = async (key = 'worker') => {
      const prepared = await prepareWorktree(
        {
          schemaVersion: 1,
          projectId: 'project-0',
          key,
          branch: `refs/heads/${key}`,
          baseCommit: context.request(0, 'base').commit,
        },
        {
          ...context.deps,
          store: context.opened.worktrees,
          files,
          managedRoot: join(context.state, 'worktrees'),
          effects: createWorktreeGit({ executable: gitPath, runner: nodeProcessRunner }),
          nextId: (kind) => `${kind}-herdr-${++sequence}`,
        },
      );

      if (
        !('record' in prepared) ||
        !prepared.record.location ||
        !['prepared', 'reused'].includes(prepared.outcome)
      ) {
        assert.fail(JSON.stringify(prepared));
      }

      const result = await submitServiceJob(
        {
          ...context.request(0, key),
          checkoutId: prepared.record.intent.checkoutId,
          branch: prepared.record.intent.branch,
        },
        context.deps,
      );

      if (result.outcome !== 'persisted') {
        assert.fail(JSON.stringify(result));
      }

      return result.value;
    };

    await action({ ...context, deps, fake, configure, worker });
  });
}

export function fakeProvider() {
  const sessions = new Map<string, HerdrSnapshot>();
  let sequence = 0;
  const calls: { operation: string; target: HerdrTarget; root: string }[] = [];
  const modes = { create: 'normal', open: 'normal', unavailable: false };
  function snapshot(target: HerdrTarget): HerdrSnapshot {
    const key = JSON.stringify(target);
    let value = sessions.get(key);

    if (!value) {
      value = {
        server: {
          ...target,
          device: '1',
          inode: String(++sequence),
          changedAtNs: '1',
          protocol: 22,
        },
        workspaces: [],
        tabs: [],
        panes: [],
        agents: [],
      };
      sessions.set(key, value);
    }

    return value;
  }

  function add(target: HerdrTarget, root: string, label: string, parent?: string) {
    const value = snapshot(target);
    const id = `w${++sequence}`;
    const handle = {
      workspaceId: id,
      tabId: `${id}:t1`,
      paneId: `${id}:p1`,
      terminalId: `terminal-${sequence}`,
    };
    value.workspaces.push({
      id,
      label,
      worktree: parent
        ? { checkoutPath: root, repositoryRoot: parent, repositoryKey: parent, linked: true }
        : null,
    });
    value.tabs.push({ id: handle.tabId, workspaceId: id });
    value.panes.push({ ...handle, cwd: root, foregroundCwd: root });

    return handle;
  }

  const provider: HerdrProvider = {
    async snapshot(target) {
      if (modes.unavailable) {
        throw new Error('fixture-private-provider-error');
      }

      return completed(structuredClone(snapshot(target)));
    },
    async createPrimary(input) {
      calls.push({ operation: 'create', target: input.target, root: input.root });

      if (modes.create === 'before') {
        throw new Error('fixture interrupt');
      }

      add(input.target, input.root, input.label);

      if (modes.create === 'after') {
        throw new Error('fixture interrupt after effect');
      }

      return completed(null);
    },
    async openWorker(input) {
      calls.push({ operation: 'open', target: input.target, root: input.root });
      const value = snapshot(input.target);
      const parent = value.workspaces.find((item) => item.id === input.parent);
      const root = value.panes.find((item) => item.workspaceId === input.parent)?.cwd;

      assert.ok(parent && root);

      parent.worktree = {
        checkoutPath: root,
        repositoryRoot: root,
        repositoryKey: root,
        linked: false,
      };
      add(input.target, input.root, input.label, root);

      if (modes.open === 'after') {
        throw new Error('fixture interrupt after opening');
      }

      return completed({ alreadyOpen: false });
    },
  };

  return { provider, snapshot, add, calls, modes };
}
