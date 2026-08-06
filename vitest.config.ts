import { defineConfig } from 'vitest/config';

/**
 * `src/env.ts` validates the environment at import time and exits the process if
 * anything is missing, so every test run needs a complete, deliberately fake
 * environment. These values are never used against a real workspace: the tokens
 * are syntactically valid but inert, and DATA_FILE is overridden per test.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup/noNetwork.ts'],
    env: {
      SLACK_BOT_TOKEN: 'xoxb-test-token',
      SLACK_APP_TOKEN: 'xapp-test-token',
      DATA_FILE: './data/test-profiles.json',
      PROFILE_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
      LOG_LEVEL: 'fatal',
    },
  },
});
