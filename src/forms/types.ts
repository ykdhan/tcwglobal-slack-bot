import type { ModalView } from '@slack/types';
import type { z } from 'zod';

import type { Profile } from '../profile.js';

/**
 * One field on a Formstack form.
 *
 * `name` is the HTML `name` attribute — everything else describes how a value
 * has to be shaped before it goes into the request body.
 */
export interface FieldDef {
  name: string;
  type?: 'date';
  /** Date split into `{name}-M` / `-D` / `-Y` inputs, as Formstack often does. */
  parts?: boolean;
  optional?: boolean;
  options?: string[];
}

export interface FormSchema {
  /** The page users see, and the page the engine GETs for hidden inputs. */
  formUrl: string;
  /** The POST target, used when the form's own `action` attribute is absent. */
  action: string;
  /** Literal string present in the response body on success. The only success signal. */
  successMarker: string;
  dateFormat: 'MM/DD/YYYY' | 'DD/MM/YYYY';
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
