import * as crypto from 'node:crypto';

/** Comparação em tempo constante: `!==` vaza o ponto da diferença pelo tempo. */
export function tokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
