import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { loadSchema } from '../../formstack/schema.js';
import type { FormDefinition } from '../types.js';
import { buildPtoModal } from './modal.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const PtoRequestSchema = z.object({
  leaveType: z.string().min(1, 'Choose a leave type.'),
  startDate: z.string().regex(ISO_DATE, 'Choose a start date.'),
  endDate: z.string().regex(ISO_DATE, 'Choose an end date.'),
  totalDays: z.number({ invalid_type_error: 'Enter the number of days.' }).positive(),
  comments: z.string().optional(),
});

export type PtoRequest = z.infer<typeof PtoRequestSchema>;

const schema = loadSchema(fileURLToPath(new URL('./schema.json', import.meta.url)));

export const ptoForm: FormDefinition<PtoRequest> = {
  id: 'pto',
  label: 'PTO request',
  schema,
  requestSchema: PtoRequestSchema,

  buildModal: (profile) => buildPtoModal(schema, profile),

  // Dates are compared as ISO strings, which sort correctly as text. No Date
  // objects anywhere: these are calendar dates, not instants, and converting
  // them would only introduce a timezone to get wrong.
  validate: (request) =>
    request.endDate < request.startDate
      ? { blockId: 'end_date_block', message: 'End date must be on or after the start date.' }
      : null,

  toFieldValues: (request) => ({
    leaveType: request.leaveType,
    startDate: request.startDate,
    endDate: request.endDate,
    totalDays: String(request.totalDays),
    comments: request.comments ?? '',
  }),

  summarize: (request) => [
    ['Leave type', request.leaveType],
    ['Dates', `${request.startDate} ~ ${request.endDate}`],
    ['Total days', String(request.totalDays)],
    ...(request.comments ? [['Comments', request.comments] as [string, string]] : []),
  ],
};
