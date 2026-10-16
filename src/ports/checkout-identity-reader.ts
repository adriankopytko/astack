import type { CheckoutLocation } from '../contracts/projects.js';

export interface CheckoutIdentityReader {
  read(paths: {
    rootPath: string;
    gitDirectory: string;
    commonDirectory: string;
  }): Promise<CheckoutLocation>;
}
