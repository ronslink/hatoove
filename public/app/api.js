/**
 * The client's API layer — the ONLY place in `public/app/` that knows a URL.
 *
 * Ron, 2 October 2026: "we should be using a api structure to serve data to the frontend from the
 * backend", and "keep the approach consistent using apis to serve data not files".
 *
 * So views never build a path, never fetch, and never read a file. A view asks for a THING
 * (`api.tasks.list()`), and this module owns the transport, the paths, the error shape and the
 * session-expiry rule. Three things follow, and each is the point rather than a side effect:
 *
 *   1. ONE place to change a path. Renaming `/api/v1/tasks` is one edit here, not a grep through
 *      views for a string that half of them spell slightly differently.
 *   2. ONE refusal rule. A 401 means "the session is gone, go and sign in" everywhere, because it is
 *      decided once. A view cannot accidentally render a 401 as content.
 *   3. NO DATA IN FILES. There is no `fetch('/data/…')` in this client, because there is no `/data/`
 *      route any more. Content arrives as JSON from the API under a verified session.
 *
 * It returns `{ ok, status, data, error }` rather than throwing, so a caller must decide what a
 * failure looks like on screen instead of silently rendering `undefined`.
 */

/** Every path the client uses, in one place. */
const PATHS = Object.freeze({
  session: '/api/auth/get-session',
  signIn: '/api/auth/sign-in/email',
  signOut: '/api/auth/sign-out',
  account: '/api/v1/account',
  settings: '/api/v1/settings',
  tasks: '/api/v1/tasks',
});

/**
 * A 401 is not an error to render: the session is gone and only signing in can fix it. The redirect
 * happens here so no view can get it wrong, and callers receive `null` to mean "we are leaving".
 */
async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    location.replace('/signin');
    return null;
  }
  let payload = null;
  try { payload = await res.json(); } catch { /* a refusal may carry no body; the status still counts */ }
  return { ok: res.ok, status: res.status, data: payload, error: payload && (payload.error || payload.code) };
}

export const api = Object.freeze({
  /** The verified session, or null when signed out. Returns the raw response for the boot check. */
  session: () => call('GET', PATHS.session),

  auth: Object.freeze({
    signIn: (email, password) => call('POST', PATHS.signIn, { email, password }),
    signUp: (name, email, password) => call('POST', '/api/auth/sign-up/email', { name, email, password }),
    signOut: () => call('POST', PATHS.signOut, {}),
  }),

  account: Object.freeze({
    read: () => call('GET', PATHS.account),
    // `{}` and not no body: the server requires application/json on every mutating route.
    remove: () => call('DELETE', PATHS.account, {}),
  }),

  settings: Object.freeze({
    read: () => call('GET', PATHS.settings),
    write: (expectedRevision, settings) => call('PUT', PATHS.settings, { expectedRevision, settings }),
  }),

  /**
   * The servable tasks for this learner. The policy that decides WHICH versions are servable is
   * deployment configuration on the server and is deliberately not a parameter here: a client must
   * not be able to ask for content the deployment has chosen not to serve.
   */
  tasks: Object.freeze({
    list: ({ exam = null, family = null } = {}) => {
      const query = new URLSearchParams();
      if (exam) query.set('exam', exam);
      if (family) query.set('family', family);
      const suffix = query.toString();
      return call('GET', suffix ? `${PATHS.tasks}?${suffix}` : PATHS.tasks);
    },
  }),
});
