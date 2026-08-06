import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { env } from '../env.js';
import { ProfileSchema, type Profile } from '../profile.js';
import { decrypt, encrypt, type Encrypted } from './crypto.js';

/**
 * Profile storage: an in-memory object backed by an encrypted JSON file.
 *
 * The in-memory object *is* the cache — there is no second layer. Reads never
 * touch the disk; every mutation rewrites the whole file. At the expected scale
 * (well under 50 users, tens of KB) that is cheaper than any alternative.
 *
 * `saveProfile` and `forgetProfile` are the only ways a stored value can change,
 * which is what makes "your details stay put until you click Edit info" a
 * structural guarantee rather than a convention.
 */

type ProfileStore = Record<string, Profile>;
type EncryptedStore = Record<string, Encrypted>;

const profiles: ProfileStore = load();

function load(): ProfileStore {
  if (!existsSync(env.DATA_FILE)) return {};

  // A store that exists but cannot be read is a hard startup failure. Starting
  // empty instead would silently discard every user's details, and the next save
  // would overwrite the file that still held them.
  let raw: string;
  try {
    raw = readFileSync(env.DATA_FILE, 'utf8');
  } catch (error) {
    throw new Error(`Could not read the profile store at ${env.DATA_FILE}`, { cause: error });
  }

  let parsed: EncryptedStore;
  try {
    parsed = JSON.parse(raw) as EncryptedStore;
  } catch (error) {
    throw new Error(`The profile store at ${env.DATA_FILE} is not valid JSON`, { cause: error });
  }

  const store: ProfileStore = {};
  for (const [userId, encrypted] of Object.entries(parsed)) {
    try {
      store[userId] = ProfileSchema.parse(JSON.parse(decrypt(encrypted)));
    } catch (error) {
      throw new Error(
        `Could not decrypt the stored profile for ${userId}. ` +
          'PROFILE_ENC_KEY most likely differs from the one used to write this file.',
        { cause: error },
      );
    }
  }

  return store;
}

/**
 * Write the whole store atomically: a temp file plus a rename, so a crash
 * mid-write leaves the previous file intact instead of a truncated one.
 */
function persist(): void {
  const encrypted: EncryptedStore = {};
  for (const [userId, profile] of Object.entries(profiles)) {
    encrypted[userId] = encrypt(JSON.stringify(profile));
  }

  mkdirSync(dirname(env.DATA_FILE), { recursive: true });

  const tmp = `${env.DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  renameSync(tmp, env.DATA_FILE);
}

export function getProfile(userId: string): Profile | null {
  return profiles[userId] ?? null;
}

export function saveProfile(userId: string, profile: Profile): void {
  profiles[userId] = profile;
  persist();
}

export function forgetProfile(userId: string): void {
  if (!(userId in profiles)) return;

  delete profiles[userId];

  // Removing the last profile leaves an empty store rather than a stale file.
  if (Object.keys(profiles).length === 0 && existsSync(env.DATA_FILE)) {
    unlinkSync(env.DATA_FILE);
    return;
  }

  persist();
}
