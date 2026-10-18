import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { writeFile, symlink, link } from 'node:fs/promises';
import { createCodexReportReader, launchRuntime } from '../src/index.js';
import { fixture } from './support/runtime.js';
const options = { timeout: 90000 };
await test(
  'Codex report reader selects only a typed final response after the exact saved assignment in an explicitly selected matching session',
  options,
  async () => {
    await fixture(async (context) => {
      const job = await context.prepare();
      const launched = await launchRuntime(
        { schemaVersion: 1, attemptId: job.attempt.id },
        context.deps,
      );
      const selected = context.context.opened.runs.inspect(job.job.id);

      assert.ok(launched.outcome === 'completed' && launched.value.session?.agent);
      assert.ok(selected.outcome === 'completed' && selected.value);

      const session = launched.value.session;
      const run = selected.value;
      const file = join(context.context.root, 'selected.jsonl');
      const prompt = '# Exact assignment including job and attempt';
      const proposal = { schemaVersion: 1, summary: 'Safe final response' };
      const header = {
        type: 'session_meta',
        payload: {
          id: session.agent?.nativeSessionId,
          cwd: session.space.root,
          timestamp: new Date(Date.now()).toISOString(),
        },
      };
      const user = {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
      };
      const final = (text: string, phase = 'final_answer') => ({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase,
          content: [{ type: 'output_text', text }],
        },
      });
      async function contents(items: unknown[], newline = true) {
        await writeFile(
          file,
          items.map((item) => JSON.stringify(item)).join('\n') + (newline ? '\n' : ''),
        );
      }

      const reader = createCodexReportReader({ file, session });

      await contents([
        header,
        final('unrelated earlier output'),
        user,
        final('private commentary', 'commentary'),
        final(JSON.stringify(proposal)),
      ]);
      const valid = await reader.read({ run, prompt });

      assert.deepEqual(valid, { schemaVersion: 1, outcome: 'completed', value: proposal });
      assert.equal(JSON.stringify(valid).includes('private commentary'), false);

      // A follow-up correction may replace the final response, but a later pending turn invalidates it.
      const followup = {
        ...user,
        payload: {
          ...user.payload,
          content: [{ type: 'input_text', text: 'Please correct the JSON shape only.' }],
        },
      };
      await contents([header, user, final('{}'), followup, final(JSON.stringify(proposal))]);

      assert.deepEqual(await reader.read({ run, prompt }), valid);

      for (const items of [
        [header, final(JSON.stringify(proposal))],
        [{ ...header, oversized: 'x'.repeat(1024 * 1024) }, user, final('{}')],
        [header, user, final(JSON.stringify(proposal)), followup],
        [header, user, final(JSON.stringify(proposal)), user, final('{}')],
        [header, user, final('```json\n{}\n```')],
        [header, user, final('x'.repeat(48001))],
        [header, user, final('{}', 'commentary')],
        [{ ...header, payload: { ...header.payload, cwd: '/other/project' } }, user, final('{}')],
        [{ ...header, payload: { ...header.payload, id: 'other-session' } }, user, final('{}')],
        [
          { ...header, payload: { ...header.payload, timestamp: new Date(0).toISOString() } },
          user,
          final('{}'),
        ],
      ]) {
        await contents(items);

        assert.equal((await reader.read({ run, prompt })).outcome, 'rejected');
      }

      await contents([header, user, final('{}')], false);

      assert.equal((await reader.read({ run, prompt })).outcome, 'rejected');

      await contents([header, user, final('{}')]);
      const symbolic = join(context.context.root, 'symbolic.jsonl');
      await symlink(file, symbolic);

      assert.equal(
        (await createCodexReportReader({ file: symbolic, session }).read({ run, prompt })).outcome,
        'rejected',
      );

      const hard = join(context.context.root, 'hard.jsonl');
      await link(file, hard);

      assert.equal((await reader.read({ run, prompt })).outcome, 'rejected');

      const controller = new AbortController();
      controller.abort();

      assert.equal((await reader.read({ run, prompt }, controller.signal)).outcome, 'rejected');
    });
  },
);
