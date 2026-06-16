// Owner self-exclusion.
//
// The visitor id logged server-side is a hash of IP+UA+salt, so it changes
// whenever the owner switches network, browser, or country and can never be
// pinned down. Instead the owner carries a deliberate key:
//
//   visit any page once with  ?owner=<key>
//
// and it's stashed in this browser's localStorage, then attached to every
// /api/* control-plane call. The Worker — the only side that knows the real
// key (env.OWNER_KEY) — collapses those hits to a single 'owner' visitor id,
// which the dashboard excludes by default. One-time per browser; survives
// IP/country/UA changes thereafter.
const LS_KEY = 'wb_owner';

function readKey(): string {
  try {
    // Capture ?owner=<key> from the landing URL once, persist it, then strip it
    // from the address bar so it doesn't linger or get copied into shared links.
    const u = new URL(window.location.href);
    const fromUrl = u.searchParams.get('owner');
    if (fromUrl) {
      localStorage.setItem(LS_KEY, fromUrl);
      u.searchParams.delete('owner');
      window.history.replaceState(null, '', u.pathname + u.search + u.hash);
      return fromUrl;
    }
    return localStorage.getItem(LS_KEY) || '';
  } catch {
    return ''; // no window/localStorage (SSR, private mode quirks) — feature off
  }
}

const OWNER_KEY = readKey();

/** Append the owner key to a control-plane URL when this browser carries one. */
export function appendOwner(url: string): string {
  if (!OWNER_KEY) return url;
  return url + (url.includes('?') ? '&' : '?') + 'owner=' + encodeURIComponent(OWNER_KEY);
}
