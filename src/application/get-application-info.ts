import type { ApplicationInfo } from '../contracts/application-info.js';

/** Describe the package without probing projects, providers, or user state. */
export function getApplicationInfo(version: string): ApplicationInfo {
  return { name: 'astack', version, stage: 'foundation' };
}
