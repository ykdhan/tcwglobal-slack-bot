import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { encryptionKey } from '../env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export interface Encrypted {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** Encrypt a string with AES-256-GCM. A fresh random IV is generated per call. */
export function encrypt(plaintext: string): Encrypted {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Decrypt a value produced by {@link encrypt}.
 *
 * Throws if the auth tag does not verify — a wrong key or tampered file is a
 * hard failure, never a silently empty result.
 */
export function decrypt(enc: Encrypted): string {
  const decipher = createDecipheriv(ALGORITHM, encryptionKey, Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.authTag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(enc.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
