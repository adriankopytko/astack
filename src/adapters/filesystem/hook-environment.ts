import type { HookEnvironment } from '../../ports/hooks.js';
import { completed, rejected } from '../../contracts/operation-result.js';
export const nodeHookEnvironment: HookEnvironment = {
  async read(names) {
    const entries: [string, string][] = [];

    for (const name of names) {
      const value = Object.hasOwn(process.env, name) ? process.env[name] : undefined;

      if (value === undefined || value.includes('\0')) {
        return rejected(
          'configuration_blocked',
          'A required approved hook environment value is missing.',
        );
      }

      entries.push([name, value]);
    }

    return completed(Object.fromEntries(entries));
  },
};
