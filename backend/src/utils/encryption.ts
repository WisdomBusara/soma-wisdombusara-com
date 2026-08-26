import crypto from 'crypto';
import { env } from '../config/env';

function getKey(): Buffer {
  const key = Buffer.from(env.ENCRYPTION_KEY_BASE64, 'base64');
  if (key.length !== 32) throw Object.assign(new Error('ENCRYPTION_KEY_BASE64 must be 32 bytes'), { status: 500 });
  return key;
}

export function encryptString(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptString(blob: string): string {
  const key = getKey();
  const parts = blob.split('.');
  if (parts.length !== 3) throw Object.assign(new Error('Invalid encrypted secret format'), { status: 500 });
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
