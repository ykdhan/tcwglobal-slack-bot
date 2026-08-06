import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { PROFILE_KEYS } from '../profile.js';
import type { FieldDef, FormSchema } from '../forms/types.js';

const FieldDefSchema = z.object({
  name: z.string().min(1),
  type: z.literal('date').optional(),
  parts: z.boolean().optional(),
  optional: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});

const FormSchemaSchema = z.object({
  formUrl: z.string().url(),
  action: z.string().min(1),
  successMarker: z.string().min(1),
  dateFormat: z.enum(['MM/DD/YYYY', 'DD/MM/YYYY']),
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

/** The three input names a split date field is spread across. */
export function datePartNames(field: FieldDef): [string, string, string] {
  return [`${field.name}-M`, `${field.name}-D`, `${field.name}-Y`];
}

/**
 * Every field name the form must expose for a submission to be meaningful.
 *
 * Split dates expand into their three suffixed names, because that is what the
 * presence check compares against — the base name never appears in the markup.
 */
export function requiredFieldNames(schema: FormSchema): string[] {
  const names: string[] = [];

  for (const field of [...Object.values(schema.profile), ...Object.values(schema.request)]) {
    if (field.optional) continue;
    if (field.parts) {
      names.push(...datePartNames(field));
    } else {
      names.push(field.name);
    }
  }

  return [...new Set(names)];
}

/**
 * Write a `YYYY-MM-DD` value onto the body in whatever shape the form expects.
 *
 * Dates stay as ISO strings everywhere else in the codebase; this is the single
 * place they are reformatted, and the only place a day/month mix-up can happen.
 */
export function setDateField(
  body: URLSearchParams,
  field: FieldDef,
  iso: string,
  schema: FormSchema,
): void {
  const [year, month, day] = iso.split('-');
  if (!year || !month || !day) {
    throw new Error(`Expected a YYYY-MM-DD date for ${field.name}, got: ${iso}`);
  }

  if (field.parts) {
    body.set(`${field.name}-M`, month);
    body.set(`${field.name}-D`, day);
    body.set(`${field.name}-Y`, year);
  } else if (schema.dateFormat === 'DD/MM/YYYY') {
    body.set(field.name, `${day}/${month}/${year}`);
  } else {
    body.set(field.name, `${month}/${day}/${year}`);
  }
}
