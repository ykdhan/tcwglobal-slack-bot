import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { PROFILE_KEYS } from '../profile.js';
import type { FieldDef, FormSchema } from '../forms/types.js';

const FieldDefSchema = z.object({
  name: z.string().min(1),
  type: z.literal('date').optional(),
  parts: z.enum(['hyphenParts', 'datetimeParts']).optional(),
  base: z.string().optional(),
  optional: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});

const FormSchemaSchema = z.object({
  formUrl: z.string().url(),
  action: z.string().min(1),
  successMarker: z.string().min(1),
  dateFormat: z.enum(['MM/DD/YYYY', 'DD/MM/YYYY']),
  constants: z.record(z.string()).optional(),
  profile: z.object(
    Object.fromEntries(PROFILE_KEYS.map((key) => [key, FieldDefSchema])) as Record<
      (typeof PROFILE_KEYS)[number],
      typeof FieldDefSchema
    >,
  ),
  request: z.record(FieldDefSchema),
});

/**
 * Read and validate a form's schema.json.
 *
 * Validation happens at import time, so a mapping that is missing a profile
 * field or misspells a date format takes the app down at boot with a precise
 * message rather than producing a submission with silently blank fields.
 */
export function loadSchema(path: string): FormSchema {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Could not read the form schema at ${path}`, { cause: error });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`The form schema at ${path} is not valid JSON`, { cause: error });
  }

  const parsed = FormSchemaSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid form schema at ${path}:\n${issues}`);
  }

  return parsed.data;
}

/**
 * Every form field a submission depends on.
 *
 * Inputs that are one part of a larger field — `-first` and `-last`, a radio's
 * `_other` companion — collapse onto the field they belong to, because that is
 * what the form advertises. Date part suffixes are not expanded for the same
 * reason: the form declares one datetime field, not seven inputs.
 */
export function requiredFieldNames(schema: FormSchema): string[] {
  const names: string[] = [];

  for (const field of [...Object.values(schema.profile), ...Object.values(schema.request)]) {
    if (field.optional) continue;
    names.push(field.base ?? field.name);
  }

  return [...new Set(names)];
}

/** Anything a value can be written to: URLSearchParams, FormData, or a Map. */
export interface FieldSink {
  set(name: string, value: string): unknown;
}

const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * Write a `YYYY-MM-DD` value onto the body in whatever shape the form expects.
 *
 * Calendar dates stay ISO strings everywhere else in the codebase; this is the
 * single place they are reformatted, and the only place a day/month mix-up can
 * happen.
 */
export function setDateField(
  body: FieldSink,
  field: FieldDef,
  iso: string,
  schema: FormSchema,
): void {
  const [year, month, day] = iso.split('-');
  if (!year || !month || !day) {
    throw new Error(`Expected a YYYY-MM-DD date for ${field.name}, got: ${iso}`);
  }

  if (field.parts === 'hyphenParts') {
    body.set(`${field.name}-M`, month);
    body.set(`${field.name}-D`, day);
    body.set(`${field.name}-Y`, year);
    return;
  }

  if (field.parts === 'datetimeParts') {
    const abbreviation = MONTH_ABBREVIATIONS[Number(month) - 1];
    if (!abbreviation) {
      throw new Error(`Not a month: ${month} (from ${iso})`);
    }

    body.set(`${field.name}M`, abbreviation);
    body.set(`${field.name}D`, String(Number(day)));
    body.set(`${field.name}Y`, year);

    // The form displays no time control, but the renderer still posts these and
    // a datetime field is stored with a time. Midnight keeps the stored value on
    // the date the user actually picked, in any interpretation.
    body.set(`${field.name}H`, '12');
    body.set(`${field.name}I`, '00');
    body.set(`${field.name}S`, '00');
    body.set(`${field.name}A`, 'AM');
    return;
  }

  if (schema.dateFormat === 'DD/MM/YYYY') {
    body.set(field.name, `${day}/${month}/${year}`);
  } else {
    body.set(field.name, `${month}/${day}/${year}`);
  }
}
