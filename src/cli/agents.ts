import { Command } from 'commander';
import { createNodeConfigurationReader } from '../adapters/filesystem/configuration.js';
import { hostConfigurationPolicySchema } from '../contracts/configuration.js';
import { openSubmissionState } from './submission-state.js';
import { submissionProject } from './submit-project.js';
import { rejected } from '../contracts/operation-result.js';

/** List project-defined agents without starting a worker or coordinator. */
export function wireAgentCommands(program: Command) {
  const agents = program.command('agents').description('Inspect project-defined agents');

  agents
    .command('list')
    .option('--project <id>', 'Registered project; inferred from the current repository if omitted')
    .option('--json')
    .action(async (options: { project?: string; json?: boolean }) => {
      const host = program.opts<{
        stateDirectory?: string;
        gitExecutable?: string;
        herdrExecutable?: string;
      }>();
      const state = await openSubmissionState(host, false);
      const configurationError = () => {
        const error = rejected(
          'configuration_blocked',
          'Project configuration is unavailable or invalid.',
        );
        process.stdout.write(`${options.json ? JSON.stringify(error) : error.error.message}\n`);
        process.exitCode = 1;
      };

      if (state.outcome !== 'opened') {
        process.stdout.write(`${options.json ? JSON.stringify(state) : state.error.message}\n`);
        process.exitCode = 1;

        return;
      }

      try {
        const selected = await submissionProject(
          options.project,
          state.registry,
          host.gitExecutable,
        );

        if (selected.outcome === 'rejected') {
          process.stdout.write(
            `${options.json ? JSON.stringify(selected) : selected.error.message}\n`,
          );
          process.exitCode = 1;

          return;
        }

        const reader = createNodeConfigurationReader(state.registry, state.store);
        const parsed = hostConfigurationPolicySchema.safeParse(
          await reader.readPolicy(selected.value),
        );

        if (!parsed.success) {
          configurationError();

          return;
        }

        const entries = Object.entries(parsed.data.execution.agentSettings ?? {}).map(
          ([name, agent]) => ({
            name,
            description: agent.description ?? '',
            provider: agent.provider,
          }),
        );

        process.stdout.write(
          options.json
            ? `${JSON.stringify({ projectId: selected.value, agents: entries })}\n`
            : entries.map((item) => `${item.name}\t${item.description}\n`).join(''),
        );
      } catch {
        configurationError();
      } finally {
        state.store.close();
      }
    });
}
