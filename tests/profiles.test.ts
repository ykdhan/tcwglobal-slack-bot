import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Profile } from '../src/profile.js';

const PROFILE: Profile = {
  fullName: 'Hong Gildong',
  email: 'gildong@example.com',
  clientName: 'Acme Corp',
  country: 'South Korea',
  managerName: 'Jane Doe',
  managerEmail: 'jane@acme.com',
};

let dir: string;
let dataFile: string;

/** Load a fresh copy of the store module, re-reading DATA_FILE from disk. */
async function loadStore() {
  vi.resetModules();
  return import('../src/store/profiles.js');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tcwglobal-profiles-'));
  dataFile = join(dir, 'profiles.json');
  process.env.DATA_FILE = dataFile;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe('profile store', () => {
  it('returns null for an unknown user', async () => {
    const store = await loadStore();

    expect(store.getProfile('U0UNKNOWN')).toBeNull();
  });

  it('returns the saved profile', async () => {
    const store = await loadStore();
    store.saveProfile('U01ABCDEF', PROFILE);

    expect(store.getProfile('U01ABCDEF')).toEqual(PROFILE);
  });

  it('round-trips through the file across a reload', async () => {
    const first = await loadStore();
    first.saveProfile('U01ABCDEF', PROFILE);

    const second = await loadStore();

    expect(second.getProfile('U01ABCDEF')).toEqual(PROFILE);
  });

  it('keeps profiles separate per user', async () => {
    const store = await loadStore();
    store.saveProfile('U01ABCDEF', PROFILE);
    store.saveProfile('U02GHIJKL', { ...PROFILE, fullName: 'Kim Cheolsu' });

    expect(store.getProfile('U01ABCDEF')?.fullName).toBe('Hong Gildong');
    expect(store.getProfile('U02GHIJKL')?.fullName).toBe('Kim Cheolsu');
  });

  it('overwrites an existing profile rather than merging', async () => {
    const store = await loadStore();
    store.saveProfile('U01ABCDEF', PROFILE);
    store.saveProfile('U01ABCDEF', { ...PROFILE, clientName: 'Globex' });

    expect(store.getProfile('U01ABCDEF')?.clientName).toBe('Globex');
  });

  it('forgets a profile in memory and on disk', async () => {
    const first = await loadStore();
    first.saveProfile('U01ABCDEF', PROFILE);
    first.forgetProfile('U01ABCDEF');

    expect(first.getProfile('U01ABCDEF')).toBeNull();
    if (existsSync(dataFile)) {
      expect(readFileSync(dataFile, 'utf8')).not.toContain('gildong@example.com');
    }

    const second = await loadStore();
    expect(second.getProfile('U01ABCDEF')).toBeNull();
  });

  it('leaves other users untouched when forgetting one', async () => {
    const store = await loadStore();
    store.saveProfile('U01ABCDEF', PROFILE);
    store.saveProfile('U02GHIJKL', { ...PROFILE, fullName: 'Kim Cheolsu' });
    store.forgetProfile('U01ABCDEF');

    expect(store.getProfile('U02GHIJKL')?.fullName).toBe('Kim Cheolsu');

    const reloaded = await loadStore();
    expect(reloaded.getProfile('U02GHIJKL')?.fullName).toBe('Kim Cheolsu');
  });

  it('writes no plaintext field values to disk', async () => {
    const store = await loadStore();
    store.saveProfile('U01ABCDEF', PROFILE);

    const onDisk = readFileSync(dataFile, 'utf8');

    for (const value of Object.values(PROFILE)) {
      expect(onDisk).not.toContain(value);
    }
    // The Slack user ID is the lookup key and is stored in the clear on purpose.
    expect(onDisk).toContain('U01ABCDEF');
  });

  it('leaves no temp file behind', async () => {
    const store = await loadStore();
    store.saveProfile('U01ABCDEF', PROFILE);

    expect(existsSync(`${dataFile}.tmp`)).toBe(false);
  });

  it('loads a profile stored before a field was removed', async () => {
    // Removing a field from ProfileSchema must not strand the profiles already
    // on disk. They are decrypted, the departed field is dropped, and the app
    // boots — rather than throwing and taking the deployment down.
    const { encrypt } = await import('../src/store/crypto.js');
    const legacy = { ...PROFILE, employeeId: 'EMP-1024' };
    writeFileSync(dataFile, JSON.stringify({ U01ABCDEF: encrypt(JSON.stringify(legacy)) }));

    const store = await loadStore();

    expect(store.getProfile('U01ABCDEF')).toEqual(PROFILE);
    expect(store.getProfile('U01ABCDEF')).not.toHaveProperty('employeeId');
  });

  it('throws at load when the stored data cannot be decrypted', async () => {
    const first = await loadStore();
    first.saveProfile('U01ABCDEF', PROFILE);

    const originalKey = process.env.PROFILE_ENC_KEY;
    process.env.PROFILE_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
    try {
      await expect(loadStore()).rejects.toThrow(/PROFILE_ENC_KEY/);
    } finally {
      process.env.PROFILE_ENC_KEY = originalKey;
    }
  });
});
