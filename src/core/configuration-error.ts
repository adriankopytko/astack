export class ConfigurationReadError extends Error {
  constructor(
    readonly code: 'configuration_unsafe' | 'configuration_unavailable' | 'configuration_invalid',
  ) {
    super(
      code === 'configuration_unsafe'
        ? 'Configuration must use safe, regular files at the selected paths.'
        : code === 'configuration_invalid'
          ? 'Configuration must be bounded UTF-8 JSON matching schemaVersion 1.'
          : 'Configuration could not be read; inspect trusted files and retry the read.',
    );
  }
}
