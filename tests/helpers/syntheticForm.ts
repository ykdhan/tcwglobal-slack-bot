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
  fullName: 'Hong Gildong',
  email: 'gildong@example.com',
  employeeId: 'EMP-1024',
  clientName: 'Acme Corp',
  country: 'South Korea',
  managerName: 'Jane Doe',
  managerEmail: 'jane@acme.com',
};

export const DEMO_REQUEST: DemoRequest = {
  topic: 'Quarterly review',
  whenDate: '2026-08-17',
  note: 'Second half of the day',
};

export const PROFILE_FIELD_NAMES: Record<keyof Profile, string> = {
  fullName: 'p_name',
  email: 'p_email',
  employeeId: 'p_employee',
  clientName: 'p_client',
  country: 'p_country',
  managerName: 'p_manager',
  managerEmail: 'p_manager_email',
};

export const HIDDEN_FIELDS: Record<string, string> = {
  form: '9999',
  session_token: 'abc123',
  // Anti-spam honeypot: present, empty, and it must stay that way.
  trap: '',
};

export function demoSchema(overrides: Partial<FormSchema> = {}): FormSchema {
  return {
    formUrl: 'https://example.invalid/form',
    action: 'https://example.invalid/submit',
    successMarker: 'Thanks for your submission',
    dateFormat: 'MM/DD/YYYY',
    profile: Object.fromEntries(
      Object.entries(PROFILE_FIELD_NAMES).map(([key, name]) => [key, { name }]),
    ) as FormSchema['profile'],
    request: {
      topic: { name: 'q_topic' },
      whenDate: { name: 'q_when', type: 'date' },
      note: { name: 'q_note', optional: true },
    },
    ...overrides,
  };
}

export function demoForm(schema: FormSchema = demoSchema()): FormDefinition<DemoRequest> {
  return {
    id: 'demo',
    label: 'Demo request',
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

/** Markup for the synthetic form. `omit` drops fields, to simulate a renamed one. */
export function demoFormHtml(options: { omit?: string[]; action?: string } = {}): string {
  const omit = new Set(options.omit ?? []);
  const action = options.action ?? '/submit';

  const hidden = Object.entries(HIDDEN_FIELDS)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${value}" />`)
    .join('\n      ');

  const visible = [...Object.values(PROFILE_FIELD_NAMES), 'q_topic', 'q_when', 'q_note']
    .filter((name) => !omit.has(name))
    .map((name) => `<input type="text" name="${name}" value="" />`)
    .join('\n      ');

  return `<!doctype html>
<html>
  <body>
    <form action="${action}" method="post">
      ${hidden}
      ${visible}
      <input type="submit" value="Send" />
    </form>
  </body>
</html>`;
}

export interface FormServer {
  url: string;
  /** The body of the most recent POST, parsed. */
  lastBody(): URLSearchParams | null;
  postCount(): number;
  /** Replace the page served on GET. */
  setPage(html: string): void;
  /** Replace the body returned from POST. */
  setResponse(html: string, status?: number): void;
  /** Fail every request, as an unreachable host would. */
  setUnreachable(unreachable: boolean): void;
  close(): Promise<void>;
}

/** A local stand-in for the form host. Nothing in the test suite touches the network. */
export async function startFormServer(initialPage = demoFormHtml()): Promise<FormServer> {
  let page = initialPage;
  let responseHtml = 'Thanks for your submission';
  let responseStatus = 200;
  let unreachable = false;
  let lastBody: URLSearchParams | null = null;
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
        lastBody = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
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
