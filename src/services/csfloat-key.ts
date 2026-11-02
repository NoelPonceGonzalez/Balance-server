import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { config } from '../config/env.js';
import { CsfloatKey } from '../models/CsfloatKey.js';

function secret(): Buffer {
  return createHash('sha256').update(`${config.jwtSecret}:csfloat-key`).digest();
}

function seal(plain: string): { iv: string; tag: string; cipher: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    cipher: encrypted.toString('base64'),
  };
}

function open(row: { iv: string; tag: string; cipher: string }): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', secret(), Buffer.from(row.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(row.cipher, 'base64')),
      decipher.final(),
    ]);
    const key = plain.toString('utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}

export async function csfloatConnected(userId: string): Promise<boolean> {
  const row = await CsfloatKey.findOne({ userId }).select('_id');
  return Boolean(row);
}

export async function readCsfloatKey(userId: string): Promise<string | null> {
  const row = await CsfloatKey.findOne({ userId }).select('iv tag cipher');
  if (!row) return null;
  return open(row);
}

export async function saveCsfloatKey(userId: string, key: string): Promise<void> {
  const sealed = seal(key.trim());
  await CsfloatKey.updateOne({ userId }, { $set: { ...sealed, userId } }, { upsert: true });
}

export async function clearCsfloatKey(userId: string): Promise<void> {
  await CsfloatKey.deleteOne({ userId });
}

/** Comprueba la clave con una lectura. No registra la clave ni el cuerpo. */
export async function csfloatKeyWorks(key: string): Promise<'ok' | 'rejected' | 'later'> {
  try {
    const response = await fetch('https://csfloat.com/api/v1/listings?limit=1&type=buy_now', {
      headers: {
        accept: 'application/json',
        authorization: key.trim(),
        'user-agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok) return 'ok';
    if (response.status === 401 || response.status === 403) return 'rejected';
    return 'later';
  } catch {
    return 'later';
  }
}
