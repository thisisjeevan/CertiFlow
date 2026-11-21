import { createHash, createHmac } from 'node:crypto';

export const numberPattern = /^CF-[A-F0-9]{40}$/;
export const downloadTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function grantToken(secret: string, receiptId: string, expiresAt: Date) {
  return createHmac('sha256', secret).update('certiflow-download-v1:').update(receiptId)
    .update(':').update(expiresAt.toISOString()).digest('base64url');
}

export function grantDigest(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function downloadLink(origin: string, id: string, token: string) {
  return new URL('/download/' + id + '#' + token, origin).toString();
}
