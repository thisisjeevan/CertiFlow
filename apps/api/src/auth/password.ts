import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const options = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const format = 'scrypt-v1';
const hashLength = 64;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, hashLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return [format, salt.toString('hex'), hash.toString('hex')].join('$');
}

export async function verifyPassword(password: string, stored: string | undefined) {
  const [version, salt = '', hash = '', extra] = stored?.split('$') ?? [];
  const valid = version === format && extra === undefined && /^[0-9a-f]{32}$/.test(salt)
    && /^[0-9a-f]{128}$/.test(hash);
  // Run the same derivation for missing or unusable credentials.
  const computed = await derive(password, valid ? Buffer.from(salt, 'hex') : Buffer.alloc(16));
  const expected = valid ? Buffer.from(hash, 'hex') : Buffer.alloc(hashLength);
  return timingSafeEqual(computed, expected) && valid;
}
