import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export function certificateKey(id: string) {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)) throw new Error('Invalid certificate storage identity');
  return id + '.pdf';
}

export function readCertificatePdf(directory: string, id: string) {
  return readFile(join(directory, certificateKey(id)));
}

export async function storeCertificatePdf(directory: string, id: string, render: () => Promise<Buffer>) {
  const objectKey = certificateKey(id);
  let bytes: Buffer;
  try {
    bytes = await readCertificatePdf(directory, id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    bytes = await render();
    const temporary = join(directory, '.' + id + '-' + randomUUID() + '.tmp');
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(directory, objectKey));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('The private file is not a PDF');
  return { objectKey, checksum: createHash('sha256').update(bytes).digest('hex') };
}
