/**
 * Shared client helper for the /kick dashboard. Sends the CSRF token BOTH as
 * the X-CSRF-Token header AND in the JSON body (_csrf) because some reverse
 * proxies strip non-standard X- headers. Surfaces the real server error.
 */
(function () {
  const meta = document.querySelector('meta[name="csrf-token"]');
  const CSRF = meta ? meta.getAttribute('content') : '';

  async function sendJson(method, url, payload) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify({ ...(payload || {}), _csrf: CSRF })
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    if (!res.ok) {
      const msg = (data && data.error) ? data.error : `Request failed (HTTP ${res.status}).`;
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return data;
  }

  window.KickDash = {
    post: (url, payload) => sendJson('POST', url, payload),
    del: (url, payload) => sendJson('DELETE', url, payload),
    csrf: CSRF
  };
})();
