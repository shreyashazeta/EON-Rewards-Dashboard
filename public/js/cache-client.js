// Thin caching wrapper around fetch(), shared by all dashboards inside the
// governance shell. Same-origin iframes share sessionStorage with the
// parent shell and with each other, so this cache survives navigating
// away and back to a dashboard within the TTL window.
//
// Usage is a drop-in replacement for fetch() at call sites:
//   const res = await cachedFetch(url, opts, ttlMs);
//   const json = await res.json();
// No other code in a dashboard needs to change.

const CACHE_PREFIX = 'gov_cache::';

function cacheKeyFor(url) {
  return CACHE_PREFIX + url;
}

function cachedFetch(url, opts = {}, ttlMs = 5 * 60 * 1000) {
  const key = cacheKeyFor(url);
  const forceFresh = opts.cache === 'no-store' || (typeof window !== 'undefined' && window.__govForceRefresh);

  if (!forceFresh) {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const entry = JSON.parse(raw);
        if (Date.now() - entry.at < ttlMs) {
          // Return a Response-like object so callers' `.json()` / `.ok` / `.status` still work.
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(entry.body),
            __fromCache: true,
            __cachedAt: entry.at,
          });
        }
      }
    } catch (e) {
      // Corrupt or unavailable storage — fall through to a live fetch.
    }
  }

  return fetch(url, opts).then(res => {
    if (res.ok) {
      // Clone so the caller can still read the original response body.
      res.clone().json().then(body => {
        try {
          sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), body }));
          sessionStorage.setItem(CACHE_PREFIX + 'lastWrite', String(Date.now()));
        } catch (e) { /* storage full or unavailable — non-fatal, just skip caching */ }
      }).catch(() => {});
    }
    return res;
  });
}

// Lets the shell (or a dashboard's own refresh button) force the next
// fetch for a given URL to bypass the cache, without clearing everything.
function invalidateCache(url) {
  try { sessionStorage.removeItem(cacheKeyFor(url)); } catch (e) {}
}
function invalidateAllCache() {
  try {
    Object.keys(sessionStorage)
      .filter(k => k.startsWith(CACHE_PREFIX))
      .forEach(k => sessionStorage.removeItem(k));
  } catch (e) {}
}
function lastCacheWriteTime() {
  try {
    const v = sessionStorage.getItem(CACHE_PREFIX + 'lastWrite');
    return v ? parseInt(v, 10) : null;
  } catch (e) { return null; }
}
