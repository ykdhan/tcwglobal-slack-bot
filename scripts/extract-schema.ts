/**
 * Field extraction tool.
 *
 * Standalone: not imported by the app, and it deliberately does not write a
 * usable schema.json. It dumps what the form exposes; deciding which field means
 * "start date" is a human judgement and stays one.
 *
 *   pnpm extract-schema --url https://example.formstack.com/forms/x --out src/forms/pto/schema.raw.json
 *
 * A local file works too, which is how the committed fixture is inspected:
 *
 *   pnpm extract-schema --url ./tests/fixtures/pto-form.html --out /tmp/raw.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import * as cheerio from 'cheerio';

interface RawOption {
  value: string;
  text: string;
}

interface RawField {
  name: string;
  tag: string;
  type: string | null;
  label: string | null;
  required: boolean;
  value: string | null;
  options?: RawOption[];
}

function parseArgs(argv: string[]): { url: string; out: string } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg?.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      args.set(arg.slice(2), next);
      i += 1;
    }
  }

  const url = args.get('url');
  const out = args.get('out');
  if (!url || !out) {
    throw new Error(
      'Usage: pnpm extract-schema --url <form url or local html file> --out <output json path>',
    );
  }

  return { url, out };
}

async function loadHtml(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, {
      headers: { 'User-Agent': 'tcwglobal-slack-bot' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`GET ${source} returned ${response.status}`);
    }
    return response.text();
  }

  return readFile(resolve(source), 'utf8');
}

/**
 * Label resolution, best effort: an explicit `label[for=id]` first, then the
 * first label inside the nearest container. Formstack usually provides the
 * former; hand-built forms often only have the latter.
 */
function labelFor($: cheerio.CheerioAPI, element: cheerio.Cheerio<never>): string | null {
  // Hidden inputs have no label of their own; the nearest one belongs to a
  // neighbouring visible field and would only mislead the operator.
  if (element.attr('type') === 'hidden') return null;

  const container = element.closest('div, li, fieldset, td');
  const type = element.attr('type');

  // On a radio or checkbox the `label[for]` names the option, not the field, so
  // the group's own label — a legend, or a label pointing at no input — wins.
  if (type === 'radio' || type === 'checkbox') {
    const groupLabel =
      container.find('legend').first().text().trim() ||
      container.find('label:not([for])').first().text().trim();
    if (groupLabel) return groupLabel;
  }

  const id = element.attr('id');
  if (id) {
    const explicit = $(`label[for="${id}"]`).first().text().trim();
    if (explicit) return explicit;
  }

  const nearest = container.find('label').first().text().trim();
  return nearest || null;
}

/** The visible text of one radio or checkbox option, as opposed to its group label. */
function optionLabel($: cheerio.CheerioAPI, element: cheerio.Cheerio<never>): string {
  const id = element.attr('id');
  const explicit = id ? $(`label[for="${id}"]`).first().text().trim() : '';
  return explicit || (element.attr('value') ?? '');
}

function extract(html: string): RawField[] {
  const $ = cheerio.load(html);
  const form = $('form').first();
  if (form.length === 0) {
    throw new Error('No <form> element found on the page');
  }

  const fields: RawField[] = [];
  const seen = new Set<string>();

  form.find('input, select, textarea').each((_, element) => {
    const node = $(element) as unknown as cheerio.Cheerio<never>;
    const name = node.attr('name');
    if (!name) return;

    const type = node.attr('type') ?? null;
    if (type === 'submit' || type === 'button' || type === 'image') return;

    // Radio groups share one name; the first occurrence carries the label and
    // the rest only contribute their values.
    if (seen.has(name)) {
      if (type === 'radio' || type === 'checkbox') {
        const existing = fields.find((field) => field.name === name);
        existing?.options?.push({
          value: node.attr('value') ?? '',
          text: optionLabel($, node),
        });
      }
      return;
    }
    seen.add(name);

    const tag = (element as { tagName?: string }).tagName ?? 'input';
    const field: RawField = {
      name,
      tag,
      type,
      label: labelFor($, node),
      required: node.attr('required') !== undefined || node.attr('aria-required') === 'true',
      value: node.attr('value') ?? null,
      ...(tag === 'select' || type === 'radio' || type === 'checkbox' ? { options: [] } : {}),
    };

    if (tag === 'select') {
      field.options = node
        .find('option')
        .map((__, option) => ({
          value: $(option).attr('value') ?? '',
          text: $(option).text().trim(),
        }))
        .get();
    } else if (type === 'radio' || type === 'checkbox') {
      field.options = [{ value: node.attr('value') ?? '', text: optionLabel($, node) }];
    }

    fields.push(field);
  });

  return fields;
}

function print(fields: RawField[]): void {
  console.log('');
  console.table(
    fields.map((field) => ({
      name: field.name,
      tag: field.tag,
      type: field.type ?? '',
      required: field.required,
      label: (field.label ?? '').slice(0, 40),
      options: field.options ? field.options.length : '',
    })),
  );

  const withOptions = fields.filter((field) => field.options && field.options.length > 0);
  if (withOptions.length > 0) {
    console.log('Option values (use `value`, not the visible text, in schema.json):\n');
    for (const field of withOptions) {
      console.log(`  ${field.name} — ${field.label ?? '(no label)'}`);
      for (const option of field.options ?? []) {
        console.log(`      ${JSON.stringify(option.value).padEnd(24)} ${option.text}`);
      }
      console.log('');
    }
  }

  const dateParts = fields.filter((field) => /-(M|D|Y)$/.test(field.name));
  if (dateParts.length > 0) {
    console.log(
      'Split date fields detected. Set `"parts": true` on the base name for:\n' +
        `  ${[...new Set(dateParts.map((field) => field.name.replace(/-(M|D|Y)$/, '')))].join(', ')}\n`,
    );
  }

  console.log('Still to confirm by hand, from a real submission (F12 -> Network -> Payload):');
  console.log('  1. Which field is which — the labels above are a hint, not the answer');
  console.log('  2. Date format: MM/DD/YYYY vs DD/MM/YYYY');
  console.log('  3. The success marker — a literal string on the page after a successful submit');
  console.log('');
}

async function main(): Promise<void> {
  const { url, out } = parseArgs(process.argv.slice(2));

  const fields = extract(await loadHtml(url));
  await writeFile(resolve(out), `${JSON.stringify(fields, null, 2)}\n`, 'utf8');

  print(fields);
  console.log(`Wrote ${fields.length} fields to ${out}`);
  console.log('Hand-write schema.json from this. Do not generate it.\n');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
