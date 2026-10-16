import type {
  GitHead,
  GitRef,
  GitRemoteEndpoint,
  GitRepositoryInspection,
  GitStatusEntry,
  GitWorktree,
} from '../contracts/git.js';
import type { OperationErrorCode } from '../contracts/operation-result.js';
import { gitHeadSchema, gitRefSchema, hasGitControlCharacters } from '../contracts/git.js';

export class GitInspectionError extends Error {
  constructor(readonly code: OperationErrorCode) {
    super(code);
  }
}

export function requireGitFact(condition: unknown): asserts condition {
  if (!condition) {
    throw new GitInspectionError('invalid_git_output');
  }
}

export function gitLine(output: string): string {
  requireGitFact(output.endsWith('\n'));

  return output.slice(0, -1);
}

export function gitNulRecords(output: string): string[] {
  if (output === '') {
    return [];
  }

  requireGitFact(output.endsWith('\0'));

  return output.slice(0, -1).split('\0');
}

export function parseGitRefs(output: string): GitRef[] {
  if (output === '') {
    return [];
  }

  return gitLine(output)
    .split('\n')
    .map((line) => {
      const fields = line.split('\0');
      requireGitFact(fields.length === 3);
      const [name, objectId, objectType] = fields;
      requireGitFact(name && objectId && objectType);
      const parsed = gitRefSchema.safeParse({ name, objectId, objectType });
      requireGitFact(parsed.success);

      return parsed.data;
    });
}

function statusFields(record: string, count: number): { fields: string[]; path: string } {
  const fields: string[] = [];
  let start = 0;

  for (let index = 0; index < count; index++) {
    const end = record.indexOf(' ', start);
    requireGitFact(end > start);
    fields.push(record.slice(start, end));
    start = end + 1;
  }

  return { fields, path: record.slice(start) };
}

export function parseGitStatus(output: string): { head: GitHead; entries: GitStatusEntry[] } {
  const records = gitNulRecords(output);
  const entries: GitStatusEntry[] = [];
  let branch: string | null | undefined;
  let commit: string | null | undefined;

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    requireGitFact(record !== undefined);

    if (record.startsWith('# branch.oid ')) {
      requireGitFact(commit === undefined);
      const value = record.slice(13);
      commit = value === '(initial)' ? null : value;
    } else if (record.startsWith('# branch.head ')) {
      requireGitFact(branch === undefined);
      const value = record.slice(14);
      branch = value === '(detached)' ? null : `refs/heads/${value}`;
    } else if (record.startsWith('# ')) {
      continue;
    } else if (record.startsWith('? ')) {
      entries.push({
        kind: 'untracked',
        path: record.slice(2),
        originalPath: null,
        indexStatus: '?',
        worktreeStatus: '?',
        submodule: null,
      });
    } else {
      const type = record[0];
      requireGitFact(type === '1' || type === '2' || type === 'u');
      const { fields, path } = statusFields(record, type === '1' ? 8 : type === '2' ? 9 : 10);
      const xy = fields[1];
      const submodule = fields[2];
      requireGitFact(xy?.length === 2 && submodule);
      const indexStatus = xy[0];
      const worktreeStatus = xy[1];
      requireGitFact(indexStatus && worktreeStatus);
      const metadata = fields.slice(3, type === '2' ? -1 : undefined);
      const modes = type === 'u' ? 4 : 3;
      requireGitFact(metadata.slice(0, modes).every((value) => /^[0-7]{6}$/.test(value)));
      requireGitFact(
        metadata.slice(modes).every((value) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)),
      );
      let originalPath: string | null = null;

      if (type === '2') {
        requireGitFact(/^[RC][0-9]{1,3}$/.test(fields[8] ?? ''));
        index++;
        const original = records[index];
        requireGitFact(original !== undefined);
        originalPath = original;
      }

      entries.push({
        kind: type === '1' ? 'ordinary' : type === '2' ? 'renamed' : 'unmerged',
        path,
        originalPath,
        indexStatus,
        worktreeStatus,
        submodule,
      });
    }
  }

  requireGitFact(branch !== undefined && commit !== undefined);
  const head = gitHeadSchema.safeParse({ branch, commit });
  requireGitFact(head.success);

  return { head: head.data, entries };
}

export function parseGitWorktrees(output: string): GitWorktree[] {
  const records = gitNulRecords(output);
  const trees: GitWorktree[] = [];
  let tree: GitWorktree | null = null;
  const seen = new Set<string>();

  for (const record of records) {
    if (record === '') {
      requireGitFact(tree && (tree.bare || seen.has('HEAD')));
      trees.push(tree);
      tree = null;
      seen.clear();

      continue;
    }

    const separator = record.indexOf(' ');
    const key = separator === -1 ? record : record.slice(0, separator);
    const value = separator === -1 ? '' : record.slice(separator + 1);
    requireGitFact(!seen.has(key));
    seen.add(key);

    if (key === 'worktree') {
      requireGitFact(tree === null && value);
      tree = {
        path: value,
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
    } else {
      requireGitFact(tree !== null);

      switch (key) {
        case 'HEAD':
          requireGitFact(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value));
          tree.head = /^0+$/.test(value) ? null : value;
          break;
        case 'branch':
          tree.branch = value;
          break;
        case 'bare':
        case 'detached':
        case 'locked':
        case 'prunable':
          tree[key] = true;
          break;
        default:
          throw new GitInspectionError('invalid_git_output');
      }
    }
  }

  requireGitFact(tree === null && trees.length > 0);

  return trees;
}

/** Return only transport and host facts: never a URL, user, repository path, query, or fragment. */
function remoteEndpoint(value: string): GitRemoteEndpoint {
  const hidden: GitRemoteEndpoint = { transport: 'other', host: null, port: null };

  if (hasGitControlCharacters(value)) {
    return hidden;
  }

  if (
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    !value.includes(':')
  ) {
    return { transport: 'file', host: null, port: null };
  }

  if (!value.includes('://')) {
    const scp = /^(?:[^/@:]+@)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):[^/].*$/.exec(value);

    return scp?.[1] ? { transport: 'ssh', host: scp[1].toLowerCase(), port: null } : hidden;
  }

  try {
    const url = new URL(value);
    const protocol = url.protocol.slice(0, -1);

    if (protocol === 'file') {
      return { transport: 'file', host: null, port: null };
    }

    if (
      !['http', 'https', 'ssh', 'git'].includes(protocol) ||
      !/^[a-z0-9.:[\]-]+$/.test(url.hostname) ||
      url.hostname === ''
    ) {
      return hidden;
    }

    return {
      transport: protocol as GitRemoteEndpoint['transport'],
      host: url.hostname,
      port: url.port === '' ? null : Number(url.port),
    };
  } catch {
    return hidden;
  }
}

export function parseGitRemotes(output: string): GitRepositoryInspection['remotes'] {
  const remotes = new Map<string, GitRepositoryInspection['remotes'][number]>();

  for (const record of gitNulRecords(output)) {
    const separator = record.indexOf('\n');
    requireGitFact(separator !== -1);
    const key = record.slice(0, separator);
    const match = /^remote\.(.+)\.(url|pushurl)$/.exec(key);
    const name = match?.[1];
    requireGitFact(name && !hasGitControlCharacters(name));
    let remote = remotes.get(name);

    if (!remote) {
      remote = { name, fetch: [], push: [] };
      remotes.set(name, remote);
    }

    const endpoints = match?.[2] === 'url' ? remote.fetch : remote.push;
    endpoints.push(remoteEndpoint(record.slice(separator + 1)));
  }

  return [...remotes.values()].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

export function selectGitBase(ref: string, refs: GitRef[], head: GitHead): string {
  if (ref === 'HEAD') {
    if (head.commit === null) {
      throw new GitInspectionError('base_ref_not_found');
    }

    return head.commit;
  }

  const candidates = ref.startsWith('refs/')
    ? [ref]
    : [
        `refs/${ref}`,
        `refs/tags/${ref}`,
        `refs/heads/${ref}`,
        `refs/remotes/${ref}`,
        `refs/remotes/${ref}/HEAD`,
      ];
  const matches = refs.filter((entry) => candidates.includes(entry.name));
  const fullId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref);

  if (matches.length > 1 || (matches.length > 0 && fullId)) {
    throw new GitInspectionError('base_ref_ambiguous');
  }

  if (matches[0]) {
    return matches[0].name;
  }

  if (fullId) {
    return ref;
  }

  throw new GitInspectionError('base_ref_not_found');
}
