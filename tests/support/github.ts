import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  createGhProvider,
  githubPublicationSchema,
  processRequestSchema,
  type GhProviderOptions,
  type GithubPublication,
  type ProcessExecution,
  type ProcessRequest,
} from '../../src/index.js';

export const target = {
  host: 'github.com',
  repository: 'example/project',
  number: 12,
  sha: 'a'.repeat(40),
};
export const baseSha = 'b'.repeat(40);
export const marker = `<!-- astack:publication:v1:${'c'.repeat(64)} -->`;
export function publication(kind: GithubPublication['kind']): GithubPublication {
  const common = {
    schemaVersion: 1,
    kind,
    actor: 'fixture-actor',
    body: 'First line\n\nLiteral `code`, $(not-a-command), and "quotes".',
  };

  return githubPublicationSchema.parse(
    kind === 'pull-request'
      ? {
          ...common,
          target: { host: target.host, repository: target.repository },
          sourceRepository: 'contributor/fork',
          headBranch: 'feature/nested',
          headSha: target.sha,
          baseBranch: 'main',
          baseSha,
          title: 'Fixture change',
          draft: true,
        }
      : kind === 'review'
        ? { ...common, target, event: 'REQUEST_CHANGES' }
        : { ...common, target },
  );
}

export function pull(number = target.number) {
  return {
    number,
    html_url: `https://${target.host}/${target.repository}/pull/${number}`,
    state: 'open',
    merged_at: null,
    draft: true,
    title: 'Fixture change',
    body: '',
    user: { login: 'fixture-actor' },
    head: { sha: target.sha, ref: 'feature/nested', repo: { full_name: 'contributor/fork' } },
    base: { sha: baseSha, ref: 'main', repo: { full_name: target.repository } },
  };
}

export function http(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
  code = status >= 400 ? 1 : 0,
): ProcessExecution {
  const output = (text: string) => ({
    text,
    capturedBytes: Buffer.byteLength(text),
    observedBytes: Buffer.byteLength(text),
    complete: true,
    truncated: false,
    artifact: null,
  });

  return {
    schemaVersion: 1,
    outcome: 'exited',
    pid: 123,
    exitCode: code,
    signal: null,
    error: null,
    stdout: output(
      `HTTP/2.0 ${status} Fixture\r\nContent-Type: application/json\r\n${Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join('')}\r\n${JSON.stringify(body)}`,
    ),
    stderr: output(''),
    shutdown: { root: 'exited', processGroup: 'absent', termSent: false, killSent: false },
  };
}

export function timedOut(): ProcessExecution {
  return {
    ...http(null),
    outcome: 'timed_out',
    exitCode: null,
    signal: 'SIGTERM',
    shutdown: { root: 'exited', processGroup: 'absent', termSent: true, killSent: false },
  };
}

export function fixtureProvider(
  handler: (request: ProcessRequest) => Promise<ProcessExecution> | ProcessExecution,
  options: Partial<Omit<GhProviderOptions, 'runner'>> = {},
) {
  const calls: ProcessRequest[] = [];
  const provider = createGhProvider({
    executable: '/trusted/gh',
    environment: { GH_TOKEN: 'fixture-secret', GH_DEBUG: 'api', GH_FORCE_TTY: '1' },
    now: () => 1000,
    ...options,
    runner: {
      async run(request) {
        processRequestSchema.parse(request);
        calls.push(request);

        return handler(request);
      },
    },
  });

  return { provider, calls };
}

export function queuedProvider(
  replies: ProcessExecution[],
  options: Partial<Omit<GhProviderOptions, 'runner'>> = {},
) {
  return fixtureProvider(() => {
    const reply = replies.shift();

    assert.ok(reply, 'Unexpected GitHub subprocess');

    return reply;
  }, options);
}

export function remoteFixture(p: GithubPublication, artifactParent: string) {
  let records: unknown[] = [];
  let posts = 0;
  let postResult: ProcessExecution | null = null;
  let head = target.sha;
  let actor = p.actor;
  const payloads: Record<string, unknown>[] = [];
  const state = fixtureProvider(
    async (request) => {
      const path = request.args.at(-1) ?? '';
      const method = request.args[request.args.indexOf('--method') + 1];

      if (method === 'POST') {
        posts++;
        const file = request.args[request.args.indexOf('--input') + 1];

        assert.ok(file);
        assert.equal((await lstat(file)).mode & 0o777, 0o600);
        assert.equal((await lstat(dirname(file))).mode & 0o777, 0o700);
        assert.equal(
          request.args.some((arg) => arg.includes(p.body)),
          false,
        );

        const body = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        payloads.push(body);
        const record =
          p.kind === 'pull-request'
            ? { ...pull(), body: body.body }
            : {
                id: 99,
                html_url: `https://${target.host}/${target.repository}/pull/12#${p.kind === 'comment' ? 'issuecomment-' : 'pullrequestreview-'}99`,
                body: body.body,
                user: { login: p.actor },
                ...(p.kind === 'review'
                  ? {
                      commit_id: body.commit_id,
                      state: p.event === 'COMMENT' ? 'COMMENTED' : 'CHANGES_REQUESTED',
                      pull_request_url: 'https://api.github.com/repos/example/project/pulls/12',
                    }
                  : {}),
              };
        records.push(record);

        return postResult ?? http(record, 201);
      }

      if (path === 'user') {
        return http({ login: actor });
      }

      if (path === 'repos/example/project/pulls/12') {
        return http({ ...pull(), head: { ...pull().head, sha: head } });
      }

      if (path.includes('/git/ref/heads/')) {
        const isBase = path.endsWith('/main');

        return http({
          ref: isBase ? 'refs/heads/main' : 'refs/heads/feature/nested',
          object: { type: 'commit', sha: isBase ? baseSha : head },
        });
      }

      if (path.includes('per_page=100&page=')) {
        const page = Number(new URL(`https://fixture.invalid/${path}`).searchParams.get('page'));

        return http(records.slice((page - 1) * 100, page * 100));
      }

      assert.fail(`Unexpected fixture endpoint: ${path}`);
    },
    { artifactParent },
  );

  return {
    ...state,
    payloads,
    get posts() {
      return posts;
    },
    get records() {
      return records;
    },
    set records(value: unknown[]) {
      records = value;
    },
    get postResult() {
      return postResult;
    },
    set postResult(value: ProcessExecution | null) {
      postResult = value;
    },
    get head() {
      return head;
    },
    set head(value: string) {
      head = value;
    },
    get actor() {
      return actor;
    },
    set actor(value: string) {
      actor = value;
    },
  };
}
