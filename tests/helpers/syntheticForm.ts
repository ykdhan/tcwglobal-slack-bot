import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { z } from 'zod';

import type { FormDefinition, FormSchema } from '../../src/forms/types.js';
import type { Profile } from '../../src/profile.js';

/**
 * A form that does not exist, used to test the engine.
 *
 * The engine must work for a form it has never heard of. Testing it against the
 * real PTO definition would let PTO-shaped assumptions pass unnoticed, and those
 * only become expensive once a second form arrives.
 */

export const DemoRequestSchema = z.object({
  topic: z.string().min(1),
  whenDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().optional(),
});

export type DemoRequest = z.infer<typeof DemoRequestSchema>;

export const DEMO_PROFILE: Profile = {
  firstName: 'Gildong',
  lastName: 'Hong',
  email: 'gildong@example.com',
  clientName: 'Acme Corp',
  country: 'South Korea - APAC Region',
  supervisorName: 'Jane Doe',
  supervisorEmail: 'jane@acme.com',
};

export const DEMO_REQUEST: DemoRequest = {
  topic: 'Quarterly review',
  whenDate: '2026-08-17',
  note: 'Second half of the day',
};

/** Field names, in the `field{id}` shape Formstack uses. */
export const PROFILE_FIELD_NAMES: Record<keyof Profile, string> = {
  firstName: 'field1001',
  lastName: 'field1002',
  email: 'field1003',
  clientName: 'field1004',
  country: 'field1005',
  supervisorName: 'field1006',
  supervisorEmail: 'field1007',
};

export const TOPIC_FIELD = 'field2001';
export const WHEN_FIELD = 'field2002';
export const NOTE_FIELD = 'field2003';

/** Values the page carries that a submission has to echo back verbatim. */
export const PAGE_HIDDEN: Record<string, string> = {
  displayTime: '2026-08-05T22:36:23-04:00',
  form: '9999',
  viewkey: 'DEMOVIEWKEY',
  formstackFormSchemaVersion: '4',
  _submit: '1',
};

export function demoSchema(overrides: Partial<FormSchema> = {}): FormSchema {
  return {
    formUrl: 'https://example.invalid/form',
    action: 'https://example.invalid/submit',
    successMarker: 'Thanks for your submission',
    dateFormat: 'MM/DD/YYYY',
    constants: { rendererVersion: '7.52.7', emptyOnPurpose: '' },
    profile: Object.fromEntries(
      Object.entries(PROFILE_FIELD_NAMES).map(([key, name]) => [key, { name }]),
    ) as FormSchema['profile'],
    request: {
      topic: { name: TOPIC_FIELD },
      whenDate: { name: WHEN_FIELD, type: 'date' },
      note: { name: NOTE_FIELD, optional: true },
    },
    ...overrides,
  };
}

export function demoForm(schema: FormSchema = demoSchema()): FormDefinition<DemoRequest> {
  return {
    id: 'demo',
    label: 'demo request',
    schema,
    requestSchema: DemoRequestSchema,
    buildModal: () => ({ type: 'modal', title: { type: 'plain_text', text: 'Demo' }, blocks: [] }),
    toFieldValues: (request) => ({
      topic: request.topic,
      whenDate: request.whenDate,
      note: request.note ?? '',
    }),
    summarize: (request) => [
      ['Topic', request.topic],
      ['Date', request.whenDate],
    ],
  };
}

/**
 * A page shaped like the real one: no `<form>` element, the definition embedded
 * in a `FSForm.render(...)` call. `omit` drops fields, to simulate a rename.
 */
export function demoFormHtml(options: { omit?: string[]; submitUrl?: string } = {}): string {
  const omit = new Set(options.omit ?? []);

  const fieldNames = [
    ...Object.values(PROFILE_FIELD_NAMES),
    TOPIC_FIELD,
    WHEN_FIELD,
    NOTE_FIELD,
  ].filter((name) => !omit.has(name));

  const definition = {
    error: null,
    form: {
      id: Number(PAGE_HIDDEN.form),
      version: PAGE_HIDDEN.formstackFormSchemaVersion,
      viewKey: PAGE_HIDDEN.viewkey,
      // Omitted unless a test sets it, so the engine falls back to the target
      // the schema declares — which tests point at the local server.
      ...(options.submitUrl ? { submitUrl: options.submitUrl } : {}),
      meta: { hiddenSubmitFields: [{ key: 'displayTime', value: PAGE_HIDDEN.displayTime }] },
      sections: [
        // The definition keys fields by bare id; the engine prefixes them.
        { fields: fieldNames.map((name) => ({ general: { id: name.replace(/^field/, '') } })) },
      ],
    },
  };

  return `<!doctype html>
<html><body>
<div id="fsform-container"></div>
<script src="https://static.example.invalid/renderer.js"></script>
<script>
  FSForm.render({"id":${PAGE_HIDDEN.form},"viewKey":"${PAGE_HIDDEN.viewkey}"},
    { formResponse: ${JSON.stringify(definition)} });
</script>
</body></html>`;
}

export interface FormServer {
  url: string;
  /** The fields of the most recent POST, parsed. */
  lastBody(): Map<string, string> | null;
  postCount(): number;
  /** Replace the page served on GET. */
  setPage(html: string): void;
  /** Replace the body returned from POST. */
  setResponse(html: string, status?: number): void;
  /** Fail every request, as an unreachable host would. */
  setUnreachable(unreachable: boolean): void;
  close(): Promise<void>;
}

/** Parse a multipart/form-data body into plain fields. */
function parseMultipart(raw: Buffer, contentType: string): Map<string, string> {
  const fields = new Map<string, string>();
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!boundary) return fields;

  const delimiter = `--${boundary[1] ?? boundary[2]}`;
  for (const part of raw.toString('utf8').split(delimiter)) {
    const match = /name="([^"]*)"/.exec(part);
    if (!match?.[1]) continue;

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    fields.set(match[1], part.slice(headerEnd + 4).replace(/\r\n$/, ''));
  }

  return fields;
}

/** A local stand-in for the form host. Nothing in the test suite touches the network. */
export async function startFormServer(initialPage = demoFormHtml()): Promise<FormServer> {
  let page = initialPage;
  let responseHtml = 'Thanks for your submission';
  let responseStatus = 200;
  let unreachable = false;
  let lastBody: Map<string, string> | null = null;
  let postCount = 0;

  const server: Server = createServer((req, res) => {
    if (unreachable) {
      req.socket.destroy();
      return;
    }

    if (req.method === 'POST') {
      postCount += 1;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        lastBody = parseMultipart(Buffer.concat(chunks), req.headers['content-type'] ?? '');
        res.writeHead(responseStatus, { 'Content-Type': 'text/html' });
        res.end(responseHtml);
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/form`,
    lastBody: () => lastBody,
    postCount: () => postCount,
    setPage: (html) => {
      page = html;
    },
    setResponse: (html, status = 200) => {
      responseHtml = html;
      responseStatus = status;
    },
    setUnreachable: (value) => {
      unreachable = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
