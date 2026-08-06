import type { ModalView } from '@slack/types';
import type { z } from 'zod';

import type { Profile } from '../profile.js';

/**
 * How a date value is spread across the inputs a form exposes.
 *
 * - `hyphenParts` — `{name}-M` / `-D` / `-Y`, zero-padded. Classic Formstack date field.
 * - `datetimeParts` — `{name}M` / `D` / `Y` / `H` / `I` / `S` / `A`, no separator,
 *   month as a three-letter English abbreviation and an unpadded day. This is
 *   what a Formstack `datetime` field posts.
 *
 * Unset means a single input, formatted according to `FormSchema.dateFormat`.
 */
export type DatePartStyle = 'hyphenParts' | 'datetimeParts';

/** One input on a Formstack form. */
export interface FieldDef {
  /** The `name` the value is posted under. */
  name: string;
  type?: 'date';
  parts?: DatePartStyle;
  /**
   * The form field this input belongs to, when a single field is posted as
   * several inputs — a name split into `-first` / `-last`, or a radio's
   * free-text "Other" companion. Presence checks use this instead of `name`,
   * because the form only advertises the field, not its inputs.
   */
  base?: string;
  optional?: boolean;
  options?: string[];
}

export interface FormSchema {
  /** The page users see, and the page the engine reads the form definition from. */
  formUrl: string;
  /** The POST target, used when the page does not advertise one. */
  action: string;
  /** Literal string present in the response body on success. The only success signal. */
  successMarker: string;
  /** Applies only to date fields with no `parts` style. */
  dateFormat: 'MM/DD/YYYY' | 'DD/MM/YYYY';
  /**
   * Values the renderer posts that the page does not carry — version stamps and
   * the like. Values the page *does* carry are read from it instead, so they
   * stay correct when the form is republished.
   */
  constants?: Record<string, string>;
  profile: Record<keyof Profile, FieldDef>;
  request: Record<string, FieldDef>;
}

/**
 * Everything form-specific lives behind this interface. The engine, the store,
 * the Home tab and the handlers are written against it and never name a form.
 *
 * Adding a form is a new directory plus one registry entry. If shared code ever
 * needs to branch on `id`, this interface is wrong — fix it here instead.
 */
export interface FormDefinition<TRequest = unknown> {
  /** Stable identifier, used in action IDs and callback IDs. */
  id: string;
  /** Human-readable name, used in button text and DMs. */
  label: string;
  schema: FormSchema;
  requestSchema: z.ZodType<TRequest>;

  /** Block Kit modal for the request-specific fields. callback_id must be `${id}_request_modal`. */
  buildModal(profile: Profile): ModalView;

  /** Extra validation the zod schema cannot express, e.g. endDate >= startDate. */
  validate?(request: TRequest): { blockId: string; message: string } | null;

  /** Map request fields to form field values. Profile fields are handled by the engine. */
  toFieldValues(request: TRequest): Record<string, string>;

  /** Human-readable lines for success DMs and the manual-submission fallback block. */
  summarize(request: TRequest): Array<[label: string, value: string]>;
}
