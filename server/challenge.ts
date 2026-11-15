import { randomBytes } from 'node:crypto';
import { createChallenge, extractParams, verifySolution } from 'altcha-lib/v1';
import { z } from 'zod';

const solutionSchema = z.strictObject({
  algorithm: z.literal('SHA-256'),
  challenge: z.string().regex(/^[a-f0-9]{64}$/),
  salt: z.string().min(1).max(200),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  number: z.number().int().min(0).max(100_000)
});

export function challenges(now: () => number) {
  const key = randomBytes(32).toString('hex');
  return {
    create: () => createChallenge({ hmacKey: key, algorithm: 'SHA-256', maxnumber: 100_000,
      expires: new Date(now() + 600_000) }),
    async verify(value: unknown) {
      const parsed = solutionSchema.safeParse(value);
      if (!parsed.success) return null;
      const expires = Number(extractParams(parsed.data).expires) * 1000;
      if (!Number.isFinite(expires) || expires <= now()) return null;
      // Expiry uses the same server clock as issuance, never the phone clock.
      return await verifySolution(parsed.data, key, false) ? parsed.data.challenge : null;
    }
  };
}
