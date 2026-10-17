import { z } from 'zod';

/** Text for an interactive prompt, never raw terminal control bytes. */
export const workerInputTextSchema = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);

      if (code !== 9 && code !== 10 && (code < 32 || code === 127)) {
        return false;
      }
    }

    return (
      Buffer.from(value, 'utf8').toString('utf8') === value && Buffer.byteLength(value) <= 16_384
    );
  });
