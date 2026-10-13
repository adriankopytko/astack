import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { getApplicationInfo } from '../application/get-application-info.js';

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
      const info = getApplicationInfo(version);
      process.stdout.write(
        options.json
          ? `${JSON.stringify(info)}\n`
          : `${info.name} ${info.version} (${info.stage})\n`,
      );
    });

  return program;
}
