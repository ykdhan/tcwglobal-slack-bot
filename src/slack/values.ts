import type { z } from 'zod';

/**
 * Modal state plumbing.
 *
 * Slack returns `view.state.values` keyed by block, then by action, with a
 * different value shape per input type. Every modal in this app gives its inputs
 * an `action_id` equal to the schema key they populate, so flattening produces
 * an object a zod schema can parse directly.
 */

type StateValues = Record<string, Record<string, unknown>>;

function extract(raw: unknown): unknown {
  const value = raw as {
    type?: string;
    value?: string | null;
    selected_date?: string | null;
    selected_time?: string | null;
    selected_option?: { value?: string } | null;
    selected_options?: { value?: string }[] | null;
    selected_user?: string | null;
  };

  switch (value.type) {
    case 'datepicker':
      return value.selected_date ?? undefined;
    case 'timepicker':
      return value.selected_time ?? undefined;
    case 'static_select':
    case 'external_select':
    case 'radio_buttons':
      return value.selected_option?.value ?? undefined;
    case 'multi_static_select':
    case 'checkboxes':
      return (value.selected_options ?? []).map((option) => option.value);
    case 'users_select':
      return value.selected_user ?? undefined;
    case 'number_input': {
      const text = value.value?.trim();
      // Slack sends numbers as strings. Leaving it as one would fail a
      // z.number() check with a type error instead of the intended message.
      return text ? Number(text) : undefined;
    }
    default: {
      const text = value.value?.trim();
      return text ? text : undefined;
    }
  }
}

/** Flatten `view.state.values` into `{ [action_id]: value }`. */
export function flattenValues(state: StateValues | undefined): Record<string, unknown> {
  const flat: Record<string, unknown> = {};

  for (const block of Object.values(state ?? {})) {
    for (const [actionId, raw] of Object.entries(block)) {
      flat[actionId] = extract(raw);
    }
  }

  return flat;
}

/**
 * The block_id an input's errors are reported against.
 *
 * Inline errors are addressed by block, not by action, so every modal follows
 * the same convention: `leaveType` lives in `leave_type_block`. Keeping it
 * derivable means a new field cannot forget to register its mapping.
 */
export function blockIdFor(key: string): string {
  return `${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}_block`;
}

/**
 * Turn a zod failure into Slack's inline error map.
 *
 * Only the first issue per field survives — Slack shows one message per block,
 * and the first is the one the user needs.
 */
export function toBlockErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key !== 'string') continue;

    const blockId = blockIdFor(key);
    if (!(blockId in errors)) errors[blockId] = issue.message;
  }

  return errors;
}
