import { createHash } from 'node:crypto';
import {
  configurationRoleSchema,
  effectiveConfigurationSchema,
  type ConfigurationPatch,
  type ConfigurationSnapshot,
  type EffectiveConfiguration,
} from '../contracts/configuration.js';

/** Stable object order; arrays retain order and are replaced as complete values. */
export function configurationDigest(value: unknown): string {
  function normalized(item: unknown): unknown {
    if (Array.isArray(item)) {
      return item.map(normalized);
    }

    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, normalized(child)]),
      );
    }

    return item;
  }

  return createHash('sha256')
    .update(JSON.stringify(normalized(value)))
    .digest('hex');
}

export function mergeConfiguration(layers: {
  user: ConfigurationPatch;
  project: ConfigurationPatch;
  local: ConfigurationPatch;
  request: ConfigurationPatch;
}): { effective: EffectiveConfiguration; provenance: ConfigurationSnapshot['provenance'] } {
  const emptyRole = {
    runtime: null,
    command: null,
    timeoutMs: 300_000,
    skills: [],
    environment: [],
  };
  const effective: EffectiveConfiguration = {
    roles: { implementer: { ...emptyRole }, reviewer: { ...emptyRole } },
    hooks: { setup: null, verify: null, teardown: null },
  };
  const sources = new Map<string, ConfigurationSnapshot['provenance'][number]['source']>();

  for (const [role, settings] of Object.entries(effective.roles)) {
    for (const field of Object.keys(settings)) {
      sources.set(`roles.${role}.${field}`, 'defaults');
    }
  }

  for (const hook of Object.keys(effective.hooks)) {
    sources.set(`hooks.${hook}`, 'defaults');
  }

  for (const source of ['user', 'project', 'local', 'request'] as const) {
    const layer = layers[source];

    for (const [role, patch] of Object.entries(layer.roles ?? {})) {
      const previous = Object.hasOwn(effective.roles, role) ? effective.roles[role] : undefined;

      if (!previous) {
        for (const field of Object.keys(emptyRole)) {
          sources.set(`roles.${role}.${field}`, 'defaults');
        }
      }

      Object.defineProperty(effective.roles, role, {
        value: configurationRoleSchema.parse({ ...emptyRole, ...previous, ...patch }),
        enumerable: true,
        configurable: true,
        writable: true,
      });

      for (const field of Object.keys(patch)) {
        sources.set(`roles.${role}.${field}`, source);
      }
    }

    Object.assign(effective.hooks, layer.hooks);

    for (const field of Object.keys(layer.hooks ?? {})) {
      sources.set(`hooks.${field}`, source);
    }
  }

  return {
    effective: effectiveConfigurationSchema.parse(effective),
    provenance: [...sources]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([path, source]) => ({ path, source })),
  };
}
