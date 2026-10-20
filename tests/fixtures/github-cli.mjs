#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const recordPath = process.env.ASTACK_GH_FIXTURE_RECORD;

if (!recordPath) {
  throw new Error('Fixture state path is required');
}

const state =
  /** @type {{ calls: string[][]; posts: number; comment: Record<string, unknown> | null }} */ (
    JSON.parse(await readFile(recordPath, 'utf8'))
  );
const args = process.argv.slice(2);
state.calls.push(args);
const endpoint = args.at(-1);
const method = args[args.indexOf('--method') + 1];
/** @type {unknown} */
let body;
let status = 200;

if (method === 'POST') {
  const input = args[args.indexOf('--input') + 1];

  if (!input) {
    throw new Error('Fixture POST requires an input file');
  }

  const payload = /** @type {{ body: string }} */ (JSON.parse(await readFile(input, 'utf8')));
  state.posts++;
  state.comment = {
    id: 99,
    html_url: 'https://github.com/example/project/pull/12#issuecomment-99',
    body: payload.body,
    user: { login: 'fixture-actor' },
  };
  body = state.comment;

  if (process.env.ASTACK_GH_FIXTURE_FAIL_POST === '1') {
    status = 500;
    body = { message: 'Simulated response failure after accepting the write' };
  }
} else if (endpoint === 'user') {
  body = { login: 'fixture-actor' };
} else if (endpoint === 'repos/example/project/pulls/12') {
  body = {
    number: 12,
    html_url: 'https://github.com/example/project/pull/12',
    head: { sha: 'a'.repeat(40), ref: 'feature/nested', repo: { full_name: 'contributor/fork' } },
    base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'example/project' } },
    state: 'open',
    merged_at: null,
    draft: false,
    title: 'Fixture',
    body: '',
    user: { login: 'fixture-actor' },
  };
} else if (endpoint?.startsWith('repos/example/project/issues/12/comments?')) {
  body = state.comment ? [state.comment] : [];
} else {
  throw new Error('Unexpected fixture endpoint');
}

await writeFile(recordPath, JSON.stringify(state), { mode: 0o600 });
process.stdout.write(
  `HTTP/1.1 ${status} Fixture\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}\n`,
);
process.exitCode = status >= 400 ? 1 : 0;
