import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

export async function hostExecutable(name: string, explicit?: string): Promise<string | null> {
  if (explicit !== undefined) {
    return isAbsolute(explicit) ? explicit : null;
  }

  for (const directory of (process.env.PATH ?? '/usr/bin:/bin').split(delimiter)) {
    if (!isAbsolute(directory)) {
      continue;
    }

    const candidate = join(directory, name);

    try {
      await access(candidate, constants.X_OK);

      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function gitExecutable(explicit?: string): Promise<string | null> {
  return hostExecutable('git', explicit);
}
