import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const [mode, ...args] = process.argv.slice(2);

/** @param {number} index */
function argument(index) {
  const value = args[index];

  if (value === undefined) {
    throw new Error('Missing fixture argument');
  }

  return value;
}

/** @param {string | undefined} marker */
function wait(marker, ignoreTerm = false) {
  if (ignoreTerm) {
    process.on('SIGTERM', () => {});
  }

  if (marker) {
    writeFileSync(marker, String(process.pid));
  }

  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(0), 12_000).unref();
}

async function main() {
  if (mode === 'inspect') {
    process.stdout.write(
      JSON.stringify({
        args,
        cwd: process.cwd(),
        value: process.env.VALUE ?? null,
        ambient: process.env.ASTACK_PROCESS_AMBIENT_SECRET ?? null,
      }),
    );

    return;
  }

  if (mode === 'output') {
    process.stdout.write(Buffer.alloc(Number(args[0]), 'x'));
    process.stderr.write(Buffer.alloc(Number(args[1]), 'y'));

    return;
  }

  if (mode === 'binary') {
    process.stdout.write(Buffer.from([0xf0, 0x9f, 0x98, 0x80, 0xff]));

    return;
  }

  if (mode === 'exit') {
    process.exitCode = Number(args[0]);

    return;
  }

  if (mode === 'signal') {
    process.kill(process.pid, 'SIGTERM');

    return;
  }

  if (mode === 'wait' || mode === 'ignore-term') {
    wait(args[0], mode === 'ignore-term');

    return;
  }

  if (mode === 'descendant') {
    process.on('SIGTERM', () => {
      writeFileSync(argument(1), 'terminated');
      process.exit(0);
    });
    wait(args[0]);

    return;
  }

  if (mode === 'orphan' || mode === 'escaped') {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant', ...args], {
      env: process.env,
      stdio: 'inherit',
      detached: mode === 'escaped',
    });
    child.on('error', () => process.exit(1));
    const deadline = Date.now() + 3000;

    while (!existsSync(argument(0))) {
      if (Date.now() >= deadline) {
        process.exit(1);
      }

      await delay(10);
    }

    child.unref();
    process.exit(0);
  }

  throw new Error('Unknown fixture mode');
}

await main();
