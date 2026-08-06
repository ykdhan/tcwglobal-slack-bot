import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { loadSchema } from '../../formstack/schema.js';
import type { FormDefinition } from '../types.js';
import { buildPtoModal } from './modal.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The category value the form uses for its free-text choice. */
export const OTHER_CATEGORY = 'Other';

export const PtoRequestSchema = z.object({
  startDate: z.string().regex(ISO_DATE, 'Choose a start date.'),
  endDate: z.string().regex(ISO_DATE, 'Choose an end date.'),
  category: z.string().min(1, 'Choose a category.'),
  otherCategory: z.string().optional(),
  comments: z.string().optional(),
});

export type PtoRequest = z.infer<typeof PtoRequestSchema>;

const schema = loadSchema(fileURLToPath(new URL('./schema.json', import.meta.url)));

/** What the user actually asked for, whether they picked a preset or typed one. */
function categoryText(request: PtoRequest): string {
  return request.category === OTHER_CATEGORY && request.otherCategory
    ? `${OTHER_CATEGORY} — ${request.otherCategory}`
    : request.category;
}

export const ptoForm: FormDefinition<PtoRequest> = {
  id: 'pto',
  label: 'time off request',
  schema,
  requestSchema: PtoRequestSchema,

  buildModal: (profile) => buildPtoModal(schema, profile),

  // Dates are compared as ISO strings, which sort correctly as text. No Date
  // objects anywhere: these are calendar dates, not instants, and converting
  // them would only introduce a timezone to get wrong.
  validate: (request) => {
    if (request.endDate < request.startDate) {
      return { blockId: 'end_date_block', message: 'End date must be on or after the start date.' };
    }
    if (request.category === OTHER_CATEGORY && !request.otherCategory?.trim()) {
      return {
        blockId: 'other_category_block',
        message: 'Describe the category, since you chose Other.',
      };
    }
    return null;
  },

  toFieldValues: (request) => ({
    startDate: request.startDate,
    endDate: request.endDate,
    category: request.category,
    // The renderer posts this alongside the radio whether or not Other was
    // chosen, so it is sent empty rather than omitted.
    otherCategory: request.category === OTHER_CATEGORY ? (request.otherCategory ?? '') : '',
    comments: request.comments ?? '',
  }),

  summarize: (request) => [
    ['Dates', `${request.startDate} ~ ${request.endDate}`],
    ['Category', categoryText(request)],
    ...(request.comments ? [['Comments', request.comments] as [string, string]] : []),
  ],
};
