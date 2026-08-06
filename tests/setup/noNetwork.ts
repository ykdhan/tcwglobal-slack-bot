/**
 * Block every request that is not to a local test server.
 *
 * The suite serves each form from localhost, but a form's own page advertises
 * where to post — and a fixture is a copy of a real page, so it advertises the
 * real endpoint. One missing override is enough to turn a test run into real
 * submissions that a human has to go and delete.
 *
 * This is the backstop for that: a mistake fails the test instead of reaching
 * the internet.
 */
const realFetch = globalThis.fetch;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return new URL(input).hostname;
  if (input instanceof URL) return input.hostname;
  return new URL(input.url).hostname;
}

globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  let host: string;
  try {
    host = hostOf(input);
  } catch {
    return realFetch(input, init);
  }

  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Blocked a test request to ${host}. Tests must talk to the local fixture server only — ` +
        'point the form definition at it, including its `action`.',
    );
  }

  return realFetch(input, init);
}) as typeof fetch;
