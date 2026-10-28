import { wireResourceCommands } from './resources.js';
import { wireInitializationCommand } from './initialization.js';
import { wireSkillCommands } from './skills.js';
import { wireCleanupCommands } from './cleanup.js';
import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { getApplicationInfo } from '../application/get-application-info.js';
import { wireProjectCommands } from './projects.js';
import { wireWorktreeCommands } from './worktrees.js';
import { wireConfigurationCommands } from './configuration.js';
import { wireServiceCommands } from './service.js';
import { wireRunCommands } from './runs.js';
import { wireReviewCommands } from './review.js';
import { wireImplementationCommands } from './implementation.js';
import { wireCiCommands } from './ci.js';
import { wireHandoffCommands } from './handoff.js';
import { wireHerdrCommands } from './herdr.js';

/** Construct commands without parsing arguments or performing startup effects. */
export function createProgram(version: string): Command {
  const program = new Command()
    .name('astack')
    .description('Reusable primitives and orchestration for coding agents')
    .version(version)
    .option('--skill', 'Print agent instructions in SKILL.md format')
    .hook('preAction', (root, command) => {
      if (root.opts<{ skill?: boolean }>().skill && command !== root) {
        root.error('--skill must be used without a subcommand');
      }
    })
    .action(async (options: { skill?: boolean }) => {
      if (!options.skill) {
        program.help({ error: true });
      }

      const skill = await readFile(
        new URL('../../skills/astack-cli/SKILL.md', import.meta.url),
        'utf8',
      );
      process.stdout.write(skill);
    });

  program
    .command('info')
    .description('Show package information; orchestration is not implemented yet')
    .option('--json', 'Print machine-readable JSON')
    .action((options: { json?: boolean }) => {
      const result = getApplicationInfo({ schemaVersion: 1 }, version);

      if (result.outcome === 'rejected') {
        process.stdout.write(
          options.json ? `${JSON.stringify(result)}\n` : `${result.error.message}\n`,
        );
        process.exitCode = 1;

        return;
      }

      const info = result.value;
      process.stdout.write(
        options.json
          ? `${JSON.stringify(result)}\n`
          : `${info.name} ${info.version} (${info.stage})\n`,
      );
    });

  wireProjectCommands(program);
  wireWorktreeCommands(program);
  wireConfigurationCommands(program);
  wireServiceCommands(program);
  wireHerdrCommands(program);
  wireImplementationCommands(program);
  wireReviewCommands(program);
  wireRunCommands(program);
  wireHandoffCommands(program);
  wireCiCommands(program);
  wireCleanupCommands(program);
  wireSkillCommands(program);
  wireInitializationCommand(program);
  wireResourceCommands(program);

  return program;
}
