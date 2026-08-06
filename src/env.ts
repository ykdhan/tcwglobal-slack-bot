import { z } from 'zod';

/**
 * Environment configuration, validated at import time.
 *
 * Any missing or malformed value aborts startup with a readable message rather
 * than surfacing later as a confusing runtime error deep inside a Slack handler.
 */

const base64Key32 = z
  .string()
  .min(1, 'PROFILE_ENC_KEY is required — generate one with: openssl rand -base64 32')
  .refine((value) => {
    try {
      return Buffer.from(value, 'base64').length === 32;
    } catch {
      return false;
    }
  }, 'PROFILE_ENC_KEY must be base64 that decodes to exactly 32 bytes');

const EnvSchema = z.object({
  SLACK_BOT_TOKEN: z
    .string()
    .startsWith('xoxb-', 'SLACK_BOT_TOKEN must start with xoxb- (Settings -> Install App)'),

  SLACK_APP_TOKEN: z
    .string()
    .startsWith(
      'xapp-',
      'SLACK_APP_TOKEN must start with xapp- (Basic Information -> App-Level Tokens, scope connections:write)',
    ),

  ALLOWED_TEAM_IDS: z
    .string()
    .min(1, 'ALLOWED_TEAM_IDS is required')
    .transform((value) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),

  DATA_FILE: z.string().default('./data/profiles.json'),

  PROFILE_ENC_KEY: base64Key32,

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  console.error(`Invalid environment configuration:\n${issues}\n`);
  console.error('Copy .env.example to .env and fill in the missing values.');
  process.exit(1);
}

export const env = parsed.data;

/** The encryption key as raw bytes, decoded once. */
export const encryptionKey = Buffer.from(env.PROFILE_ENC_KEY, 'base64');
