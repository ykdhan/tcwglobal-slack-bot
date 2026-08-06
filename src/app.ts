import { App, LogLevel } from '@slack/bolt';

import { env } from './env.js';
import { forms } from './forms/registry.js';
import { logger } from './logger.js';
import { registerHandlers } from './slack/handlers.js';

// A test run that reaches the real form creates a real request for a human to
// cancel. Refuse to start rather than rely on remembering.
if (process.env.CI) {
  for (const form of forms) {
    if (form.schema.formUrl.includes('formstack.com')) {
      throw new Error(`Refusing to use the real form URL in CI: ${form.id}`);
    }
  }
}

const app = new App({
  token: env.SLACK_BOT_TOKEN,
  appToken: env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace' ? LogLevel.DEBUG : LogLevel.WARN,
});

registerHandlers(app);

async function main(): Promise<void> {
  await app.start();
  logger.info('socket mode connected');
  logger.info({ forms: forms.map((form) => form.id), dataFile: env.DATA_FILE }, 'app started');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    void app.stop().finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'app failed to start');
  process.exit(1);
});
