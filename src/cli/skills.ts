import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Command, InvalidArgumentError } from 'commander';
import { createBundledSkillReader } from '../adapters/filesystem/skill-bundle.js';
import { nodeSkillDirectories } from '../adapters/filesystem/skill-directories.js';
import { nodeManagedFileStore } from '../core/node-managed-file-store.js';
import { listSkills, showSkill, inspectSkills, installSkills } from '../application/skills.js';
import { skillIdSchema, type SkillId } from '../contracts/skills.js';

function skill(value: string): SkillId {
  const parsed = skillIdSchema.safeParse(value);

  if (!parsed.success) {
    throw new InvalidArgumentError('Select orchestrator, implementer or reviewer.');
  }

  return parsed.data;
}

function root(selected?: string) {
  return selected === undefined
    ? join(
        process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), '.codex'),
        'skills',
      )
    : resolve(process.cwd(), selected);
}

export function wireSkillCommands(program: Command) {
  const deps = {
    bundle: createBundledSkillReader(),
    files: nodeManagedFileStore,
    directories: nodeSkillDirectories,
  };
  const command = program
    .command('skills')
    .description('Discover, print, inspect and deliberately install versioned role skills');
  command
    .command('list')
    .option('--json')
    .action(async (options: { json?: boolean }) => {
      const result = await listSkills({ schemaVersion: 1 }, deps);

      if (options.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else if (result.outcome === 'rejected') {
        process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
      } else {
        for (const asset of result.value.skills) {
          process.stdout.write(
            `${asset.id}: ${asset.name} v${asset.version}\n${asset.description}\n`,
          );
        }
      }

      if (result.outcome === 'rejected') {
        process.exitCode = 1;
      }
    });
  command
    .command('show <skill>')
    .description('Print a focused SKILL.md; no installation or execution')
    .option('--json')
    .action(async (selected: string, options: { json?: boolean }) => {
      const result = await showSkill({ schemaVersion: 1, id: selected }, deps);
      process.stdout.write(
        options.json
          ? `${JSON.stringify(result)}\n`
          : result.outcome === 'rejected'
            ? `${result.error.code}: ${result.error.message}\n`
            : result.value.content,
      );

      if (result.outcome === 'rejected') {
        process.exitCode = 1;
      }
    });

  for (const install of [false, true]) {
    command
      .command(install ? 'install' : 'inspect')
      .description(
        install
          ? 'Install/update owned role skills; preserve authored files and pending writes'
          : 'Read installed skill availability/provenance without creating files',
      )
      .option('--root <directory>', 'Skills root; default: $CODEX_HOME/skills or ~/.codex/skills')
      .option(
        '--role <id>',
        'Select a role; repeatable, default: all three',
        (value: string, previous: SkillId[]) => [...previous, skill(value)],
        [],
      )
      .option('--json')
      .action(async (options: { root?: string; role: SkillId[]; json?: boolean }) => {
        const input = {
          schemaVersion: 1,
          root: root(options.root),
          ...(options.role.length > 0 ? { skills: options.role } : {}),
        };
        const result = install
          ? await installSkills(input, deps)
          : await inspectSkills(input, deps);

        if (options.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } else if (result.outcome === 'rejected') {
          process.stdout.write(`${result.error.code}: ${result.error.message}\n`);
        } else {
          const view = 'view' in result ? result.view : result.value;
          process.stdout.write(`Skills root: ${view.root}\nOutcome: ${result.outcome}\n`);

          for (const entry of view.skills) {
            process.stdout.write(
              `${entry.asset.id}: ${entry.state}${entry.reason ? ` (${entry.reason})` : ''}\n`,
            );
          }
        }

        if (!['completed', 'installed', 'unchanged'].includes(result.outcome)) {
          process.exitCode = 1;
        }
      });
  }
}
