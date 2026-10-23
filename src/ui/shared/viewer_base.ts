/**
 * Where the SPA is mounted, from its own pathname, so one build serves at `/`
 * (`spf ui`), under a path (`/spf/`) and on a receipt link (`/spf/r/<id>`)
 * with no server-side injection. Pure: no DOM.
 */
export function apiBase(pathname: string): string {
  // A leading `//` would make every href and fetch built from the base protocol-relative (off-site).
  const path = pathname.replace(/^\/{2,}/, "/");
  const run = /^(.*)\/r\/[^/]+\/?$/.exec(path);
  if (run) return run[1] ?? "";
  return path.replace(/\/?index\.html$/, "").replace(/\/+$/, "");
}
