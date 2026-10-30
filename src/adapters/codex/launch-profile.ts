import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { processRequestSchema, processResultSchema } from '../../contracts/process.js';
import { completed, rejected } from '../../contracts/operation-result.js';
import type { ProcessRunner } from '../../ports/process-runner.js';
import type {
  RuntimeLaunchValidator,
  RuntimeLaunchValidationInput,
  RuntimePaneProbe,
} from '../../ports/runtime.js';

const path = z.string().min(1).max(4096).refine(isAbsolute);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
/** Astack profiles are private role policy, not native --profile files or arbitrary -c overrides. */
export const codexLaunchProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
  reasoning: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  executableDigest: digest,
  version: z.string().min(1).max(256),
  ambientEnvironmentApproved: z.literal(true),
  shellResolutionApproved: z.literal(true),
  environment: z.strictObject({
    HOME: path,
    CODEX_HOME: path.optional(),
    PATH: z.string().min(1).max(8192),
    XDG_CONFIG_HOME: path.optional(),
  }),
  files: z.record(path, digest).refine((value) => Object.keys(value).length <= 64),
});

// Kept self-contained for execution by the same trusted Node binary on both sides of Herdr.
// Only digests and a unique completion marker escape. Agent output is never retained.
const probeProgram = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function requireEvidence(condition) {
  if (!condition) {
    throw new Error('Validation evidence unavailable');
  }
}

function successful(result) {
  return !result.error && !result.signal && result.status === 0;
}

try {
  const environmentKeys = ['HOME', 'CODEX_HOME', 'PATH', 'XDG_CONFIG_HOME'];
  const environment = Object.fromEntries(environmentKeys
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));

  requireEvidence(JSON.stringify(environment) === JSON.stringify(p.environment));
  requireEvidence(fs.realpathSync(process.cwd()) === p.root);

  const executable = fs.realpathSync(p.executable);
  const executableDigest = hash(fs.readFileSync(executable));

  requireEvidence(executableDigest === p.executableDigest);

  const candidates = environment.PATH.split(path.delimiter)
    .map((directory) => path.join(directory, 'codex'));
  const resolved = candidates.find((file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);

      return true;
    } catch {
      return false;
    }
  });

  requireEvidence(resolved && fs.realpathSync(resolved) === executable);

  const home = environment.CODEX_HOME || path.join(environment.HOME, '.codex');
  const files = new Set([
    path.join(home, 'config.toml'),
    path.join(home, 'requirements.toml'),
    '/etc/codex/config.toml',
    '/etc/codex/requirements.toml',
    '/etc/codex/managed_config.toml',
    ...Object.keys(p.files),
  ]);
  let directory = p.root;

  while (true) {
    files.add(path.join(directory, '.codex', 'config.toml'));
    const parent = path.dirname(directory);

    if (parent === directory) {
      break;
    }

    directory = parent;
  }

  function inventory() {
    const actual = {};

    for (const file of [...files].sort()) {
      let stat;

      try {
        stat = fs.lstatSync(file);
      } catch (error) {
        if (error.code === 'ENOENT') {
          continue;
        }

        throw error;
      }

      requireEvidence(stat.isFile() && stat.size <= 1048576 && fs.realpathSync(file) === file);
      actual[file] = hash(fs.readFileSync(file));
    }

    return actual;
  }

  const actual = inventory();

  requireEvidence(JSON.stringify(actual) === JSON.stringify(p.files));

  const fingerprint = hash(JSON.stringify({
    root: p.root,
    node: process.execPath,
    nodeVersion: process.version,
    executable,
    executableDigest,
    version: p.version,
    environment,
    files: actual,
  }));

  if (p.validate) {
    const version = cp.spawnSync(executable, ['--version'], {
      encoding: 'utf8', timeout: p.timeoutMs, maxBuffer: 4096,
    });

    requireEvidence(successful(version) && version.stdout.trim() === p.version);

    const help = cp.spawnSync(executable, [...p.launchArgs, '--help'], {
      encoding: 'utf8', timeout: p.timeoutMs, maxBuffer: 1048576,
    });

    requireEvidence(successful(help));

    for (const flag of p.flags) {
      requireEvidence(help.stdout.includes(flag));
    }

    const config = cp.spawnSync(executable, [...p.configArgs, 'features', 'list'], {
      stdio: 'ignore', timeout: p.timeoutMs,
    });

    requireEvidence(successful(config));
  }

  // Reobserve after installed-agent validation; output remains digest-only.
  requireEvidence(JSON.stringify(inventory()) === JSON.stringify(actual));
  requireEvidence(hash(fs.readFileSync(executable)) === executableDigest);
  console.log(p.marker + ':0:' + fingerprint);
} catch {
  console.log(p.marker + ':1');
  process.exitCode = 1;
}
`;

export function parseCodexValidationMarker(text: string, marker: string): string | null {
  const lines = text
    .replaceAll('\r', '')
    .split('\n')
    .filter((line) => line.startsWith(marker + ':'));

  if (lines.length !== 1 || text.split(marker + ':').length !== 2) {
    return null;
  }

  const line = lines[0] ?? '';
  const value = line.slice(marker.length + 3);

  return line.startsWith(marker + ':0:') && digest.safeParse(value).success ? value : null;
}

export function createCodexLaunchValidator(options: {
  runner: ProcessRunner;
  pane: RuntimePaneProbe;
  nodeExecutable: string;
  environment: Readonly<Record<string, string>>;
}): RuntimeLaunchValidator {
  function settings(input: RuntimeLaunchValidationInput, marker: string, validate: boolean) {
    const profile = codexLaunchProfileSchema.parse(input.profile.settings);

    if (input.profile.runtime !== 'codex-herdr' || !isAbsolute(options.nodeExecutable)) {
      throw new Error('Unsupported validation context');
    }

    const args = [
      ...input.args,
      '--model',
      profile.model,
      '-c',
      `model_reasoning_effort=${JSON.stringify(profile.reasoning)}`,
    ];
    const value = (flag: string) => input.args[input.args.indexOf(flag) + 1];
    const configArgs = [
      '-c',
      `model=${JSON.stringify(profile.model)}`,
      '-c',
      `model_reasoning_effort=${JSON.stringify(profile.reasoning)}`,
      '-c',
      `sandbox_mode=${JSON.stringify(value('--sandbox'))}`,
      '-c',
      `approval_policy=${JSON.stringify(value('--ask-for-approval'))}`,
      '-c',
      'check_for_update_on_startup=false',
    ];
    // Stable ordering allows the standalone helper to compare without a dependency on this package.
    const environment = Object.fromEntries(
      ['HOME', 'CODEX_HOME', 'PATH', 'XDG_CONFIG_HOME']
        .filter((key) => profile.environment[key as keyof typeof profile.environment] !== undefined)
        .map((key) => [key, profile.environment[key as keyof typeof profile.environment]]),
    );
    const parameters = {
      ...profile,
      environment,
      files: Object.fromEntries(
        Object.entries(profile.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
      executable: input.executable,
      root: input.space.root,
      marker,
      validate,
      timeoutMs: Math.max(100, Math.floor(input.timeoutMs / 4)),
      flags: [
        '--sandbox',
        '--ask-for-approval',
        '--no-daemon',
        '--no-alt-screen',
        '--model',
        '--config',
        '--cd',
      ],
      configArgs,
      launchArgs: [...args, '-c', 'check_for_update_on_startup=false', '--cd', input.space.root],
    };
    const encoded = Buffer.from(JSON.stringify(parameters)).toString('base64');
    const program = `const p=JSON.parse(Buffer.from('${encoded}','base64').toString());\n${probeProgram}`;

    return { args, program };
  }

  async function host(
    input: RuntimeLaunchValidationInput,
    marker: string,
    validate: boolean,
    signal?: AbortSignal,
  ) {
    const { args, program } = settings(input, marker, validate);
    const result = processResultSchema.parse(
      await options.runner.run(
        processRequestSchema.parse({
          schemaVersion: 1,
          executable: options.nodeExecutable,
          args: ['-e', program],
          cwd: input.space.root,
          env: { ...options.environment },
          timeoutMs: input.timeoutMs,
          maxCaptureBytes: 4096,
        }),
        signal,
      ),
    );

    if (
      result.outcome !== 'exited' ||
      result.exitCode !== 0 ||
      result.signal !== null ||
      result.error !== null ||
      result.shutdown.processGroup !== 'absent' ||
      !result.stdout.complete ||
      result.stdout.truncated ||
      !result.stderr.complete ||
      result.stderr.truncated
    ) {
      throw new Error('Host validation failed');
    }

    const contextDigest = parseCodexValidationMarker(result.stdout.text, marker);

    if (!contextDigest) {
      throw new Error('Missing host completion marker');
    }

    return { contextDigest, args, program };
  }

  return {
    async validate(input, signal) {
      try {
        const marker = `ASTACK_VALIDATE_${input.invocationId}_${randomUUID().replaceAll('-', '')}`;
        const first = await host(input, marker, true, signal);
        const response = await options.pane.probe(
          {
            space: input.space,
            executable: options.nodeExecutable,
            program: first.program,
            marker,
            timeoutMs: input.timeoutMs,
          },
          signal,
        );

        if (
          response.outcome === 'rejected' ||
          parseCodexValidationMarker(response.value, marker) !== first.contextDigest
        ) {
          throw new Error('Pane validation failed');
        }

        const last = await host(input, `${marker}_RECHECK`, false, signal);

        if (last.contextDigest !== first.contextDigest || signal?.aborted) {
          throw new Error('Validation context changed');
        }

        return completed({ args: first.args, contextDigest: first.contextDigest });
      } catch {
        return rejected(
          'runtime_capability_missing',
          'Launch-profile validation failed; inspect the saved invocation and approved configuration before creating a replacement attempt.',
        );
      }
    },
    async inspect(input, signal) {
      try {
        const marker = `ASTACK_INSPECT_${randomUUID().replaceAll('-', '')}`;
        const result = await host(input, marker, false, signal);

        return completed({ contextDigest: result.contextDigest, args: result.args });
      } catch {
        return rejected(
          'configuration_blocked',
          'The approved runtime profile or host context changed.',
        );
      }
    },
  };
}
