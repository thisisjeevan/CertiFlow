import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';

it('uses a unique salt and verifies only the matching password', async () => {
  const password = randomBytes(24).toString('base64url');
  const [first, second] = await Promise.all([hashPassword(password), hashPassword(password)]);
  expect(first).not.toBe(second);
  expect(first).not.toContain(password);
  await expect(verifyPassword(password, first)).resolves.toBe(true);
  await expect(verifyPassword(password + '!', first)).resolves.toBe(false);
  await expect(verifyPassword(password, undefined)).resolves.toBe(false);
  await expect(verifyPassword(password, 'legacy-or-malformed')).resolves.toBe(false);
});
