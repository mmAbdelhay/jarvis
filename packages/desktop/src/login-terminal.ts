/**
 * The one terminal Jarvis opens on the user's behalf rather than because
 * they asked for a terminal: the AWS login tab a cluster click opens to run
 * `saml2aws login` in (see createClusterHandlers in ipc.ts).
 *
 * It is marked with this on the tab's own `detail`, and that mark is the
 * only thing separating it from a Terminal tab the user opened. Both the
 * main process (which sets it) and the renderer (which draws the tab's
 * pane without blocks — one command, run once, framed by nothing) need the
 * same string, so it lives in a module of its own with no imports: a
 * renderer module may not import a value from a workspace package, and this
 * one must be safe to load in the browser context.
 */
export const LOGIN_TERMINAL_DETAIL = "AWS login";
