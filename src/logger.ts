import pino from 'pino';

import { env } from './env.js';

/**
 * Structured logger.
 *
 * The redaction list covers every personally identifying field on a Profile.
 * Never log a full profile object or a submission body — the redaction paths are
 * a safety net for accidental nesting, not a licence to pass PII to the logger.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: ['*.email', '*.fullName', '*.employeeId', '*.managerEmail', '*.managerName'],
});
