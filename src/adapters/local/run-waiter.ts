import { setTimeout } from 'node:timers/promises';
import type { RunEventWaiter } from '../../ports/runs.js';
export const nodeRunEventWaiter: RunEventWaiter = {
  async pause(ms, signal) {
    await setTimeout(ms, undefined, signal ? { signal } : {});
  },
};
