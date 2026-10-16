import { canonicalFileRoot } from '../../core/file-paths.js';
import type { CheckoutIdentityReader } from '../../ports/checkout-identity-reader.js';

export const nodeCheckoutIdentityReader: CheckoutIdentityReader = {
  async read(paths) {
    const [root, gitDirectory, commonDirectory] = await Promise.all([
      canonicalFileRoot(paths.rootPath),
      canonicalFileRoot(paths.gitDirectory),
      canonicalFileRoot(paths.commonDirectory),
    ]);
    const identity = (directory: typeof root) => ({
      path: directory.path,
      device: directory.device.toString(),
      inode: directory.inode.toString(),
    });

    return {
      root: identity(root),
      gitDirectory: identity(gitDirectory),
      commonDirectory: identity(commonDirectory),
    };
  },
};
