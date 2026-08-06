import { afterEach, describe, expect, it, vi } from 'vitest';

import { decrypt, encrypt } from '../src/store/crypto.js';

const ORIGINAL_KEY = process.env.PROFILE_ENC_KEY;

afterEach(() => {
  process.env.PROFILE_ENC_KEY = ORIGINAL_KEY;
  vi.resetModules();
});

describe('crypto', () => {
  it('round-trips a value', () => {
    const plaintext = JSON.stringify({ fullName: 'Hong Gildong', email: 'gildong@example.com' });

    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('produces a different ciphertext each time for the same plaintext', () => {
    const a = encrypt('same input');
    const b = encrypt('same input');

    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decrypt(a)).toBe(decrypt(b));
  });

  it('throws when decrypting with a different key', async () => {
    const sealed = encrypt('secret value');

    process.env.PROFILE_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
    vi.resetModules();
    const other = await import('../src/store/crypto.js');

    expect(() => other.decrypt(sealed)).toThrow();
  });

  it('throws when the ciphertext has been tampered with', () => {
    const sealed = encrypt('secret value');
    const tampered = { ...sealed, ciphertext: Buffer.from('not the same').toString('base64') };

    expect(() => decrypt(tampered)).toThrow();
  });
});
