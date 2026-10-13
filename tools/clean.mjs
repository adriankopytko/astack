import { rm } from 'node:fs/promises';

// Anchor deletion to this package, independently of the caller's directory.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
