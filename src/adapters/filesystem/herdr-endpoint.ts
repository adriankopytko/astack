import { lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HerdrEndpointReader } from '../../ports/herdr.js';

/** Socket identity is transport evidence, not a Herdr-issued server UUID. */
export const nodeHerdrEndpointReader: HerdrEndpointReader = {
  async read(target) {
    const path = await realpath(target.socketPath);
    const info = await lstat(path, { bigint: true });
    const parent = await lstat(dirname(path), { bigint: true });
    const uid = process.getuid?.();

    if (
      path !== target.socketPath ||
      !info.isSocket() ||
      (info.mode & 0o077n) !== 0n ||
      !parent.isDirectory() ||
      (parent.mode & 0o022n) !== 0n ||
      (uid !== undefined && (info.uid !== BigInt(uid) || parent.uid !== BigInt(uid)))
    ) {
      throw new Error('Unsafe Herdr socket');
    }

    return {
      ...target,
      device: String(info.dev),
      inode: String(info.ino),
      changedAtNs: String(info.ctimeNs),
    };
  },
};
