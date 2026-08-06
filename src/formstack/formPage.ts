/**
 * Reading a Formstack form's definition out of its page.
 *
 * The page contains no `<form>` element — the renderer builds one client-side —
 * but it embeds the entire form definition as JSON in a `FSForm.render(...)`
 * call. Reading that is both possible without a browser and more reliable than
 * scraping markup: field IDs, option values and the session values that have to
 * be echoed back all come from one structured source.
 */

export interface FormPage {
  /** Field names the form advertises, as `field{id}`. */
  fields: Set<string>;
  /** Values the page carries that must be posted back verbatim. */
  hidden: Record<string, string>;
  /** Where the renderer posts to. */
  action: string | null;
}

const RENDER_MARKER = 'formResponse:';

/**
 * Read one JSON object starting at `from`, stopping at its closing brace.
 *
 * `JSON.parse` cannot be used directly because the object is followed by more
 * JavaScript. Strings and their escapes are tracked so that a brace inside a
 * value does not end the scan early.
 */
function readJsonObject(text: string, from: number): unknown {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = from; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(from, i + 1));
    }
  }

  throw new Error('The embedded form definition is not a complete JSON object');
}

interface RawForm {
  id?: number | string;
  version?: string;
  viewKey?: string;
  submitUrl?: string;
  sections?: Array<{ fields?: Array<{ general?: { id?: string } }> }>;
  meta?: { hiddenSubmitFields?: Array<{ key?: string; value?: string }> };
}

/** Parse a fetched form page. Throws if the definition is absent or malformed. */
export function parseFormPage(html: string): FormPage {
  const marker = html.indexOf(RENDER_MARKER);
  if (marker === -1) {
    throw new Error('No embedded form definition was found on the page');
  }

  const start = html.indexOf('{', marker);
  if (start === -1) {
    throw new Error('No embedded form definition was found on the page');
  }

  const response = readJsonObject(html, start) as { form?: RawForm };
  const form = response.form;
  if (!form) {
    throw new Error('The embedded form definition contains no form');
  }

  const fields = new Set<string>();
  for (const section of form.sections ?? []) {
    for (const field of section.fields ?? []) {
      const id = field.general?.id;
      if (id) fields.add(`field${id}`);
    }
  }

  // Copied verbatim, empty values included: some are session values the server
  // expects back, and synthesising them is how a submission gets rejected in a
  // way that looks like nothing happened.
  const hidden: Record<string, string> = {};
  for (const entry of form.meta?.hiddenSubmitFields ?? []) {
    if (entry.key) hidden[entry.key] = entry.value ?? '';
  }

  if (form.id !== undefined) hidden.form = String(form.id);
  if (form.viewKey) hidden.viewkey = form.viewKey;
  if (form.version) hidden.formstackFormSchemaVersion = form.version;
  hidden._submit = '1';

  return { fields, hidden, action: form.submitUrl ?? null };
}
