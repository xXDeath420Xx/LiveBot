/**
 * Shared client helper for the /kick dashboard. Sends the CSRF token BOTH as
 * the X-CSRF-Token header AND in the JSON body (_csrf) because some reverse
 * proxies strip non-standard X- headers. Surfaces the real server error.
 *
 * Also: small DOM helpers the Kick pages share (element builder, UTC time,
 * "x min ago", a log table and a stacked bar chart). Everything that shows
 * server or user text goes through textContent.
 */
(function () {
  const meta = document.querySelector('meta[name="csrf-token"]');
  const CSRF = meta ? meta.getAttribute('content') : '';
  const SVGNS = 'http://www.w3.org/2000/svg';

  async function sendJson(method, url, payload) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF, 'Accept': 'application/json' },
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

  async function getJson(url) {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (HTTP ${res.status}).`); err.status = res.status; throw err;
    }
    return data || {};
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function fmtTime(v) {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }

  function ago(v) {
    const t = typeof v === 'number' ? v : new Date(v).getTime();
    if (!t || isNaN(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  // Status line next to a button: tone '' | 'ok' | 'bad'.
  function status(node, text, tone) {
    if (!node) return;
    node.textContent = text || '';
    node.classList.remove('is-ok', 'is-bad');
    if (tone) node.classList.add('is-' + tone);
  }

  /**
   * Fill `host` with a table. headers: ['Time', ...]; rows: arrays of cells, a cell is a string
   * or { text, cls } or a DOM node. Wrapped so a wide table scrolls inside the panel.
   */
  function table(host, headers, rows, emptyText) {
    host.replaceChildren();
    if (!rows.length) { host.appendChild(el('p', 'muted', emptyText || 'Nothing yet.')); return; }
    const wrap = el('div', 'kick-scroll');
    const t = el('table', 'kick-log');
    if (headers && headers.length) {
      const tr = el('tr');
      headers.forEach(h => { const th = el('th', null, h); th.scope = 'col'; tr.appendChild(th); });
      const thead = el('thead'); thead.appendChild(tr); t.appendChild(thead);
    }
    const tb = el('tbody');
    rows.forEach(r => {
      const tr = el('tr');
      r.forEach(c => {
        const td = el('td');
        if (c instanceof Node) td.appendChild(c);
        else if (c && typeof c === 'object') { td.textContent = c.text == null ? '' : String(c.text); if (c.cls) td.className = c.cls; }
        else td.textContent = c == null ? '' : String(c);
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t); host.appendChild(wrap);
  }

  /**
   * Stacked daily bars. series: [{ date: 'YYYY-MM-DD', ...counts }]; parts: [{ key, cls, label }]
   * drawn bottom-up. Colours come from CSS classes (.kick-chart .b-<cls>).
   */
  function bars(host, series, parts, opts) {
    opts = opts || {};
    host.replaceChildren();
    const totals = series.map(d => parts.reduce((s, p) => s + (Number(d[p.key]) || 0), 0));
    const max = Math.max(0, ...totals);
    if (!series.length || max <= 0) { host.appendChild(el('p', 'muted', opts.empty || 'No activity in the last 14 days.')); return; }
    const W = 560, H = opts.height || 160, padL = 8, padR = 8, padT = 8;
    const labelH = opts.labels === false ? 2 : 20;
    const axisY = H - labelH, plotH = axisY - padT;
    const slot = (W - padL - padR) / series.length;
    const barW = Math.min(opts.barMax || 22, slot * 0.6);
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', opts.label || 'Daily activity chart');
    const mk = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); Object.keys(attrs).forEach(k => n.setAttribute(k, attrs[k])); return n; };
    svg.appendChild(mk('line', { x1: padL, y1: axisY, x2: W - padR, y2: axisY, class: 'axis' }));
    series.forEach((d, i) => {
      const cx = padL + slot * i + slot / 2;
      const x = cx - barW / 2;
      let y = axisY;
      const g = mk('g', {});
      const tip = mk('title', {});
      tip.textContent = String(d.date || '') + ': ' + parts.map(p => (p.label || p.key) + ' ' + (Number(d[p.key]) || 0)).join(', ');
      g.appendChild(tip);
      parts.forEach(p => {
        const v = Number(d[p.key]) || 0;
        if (v <= 0) return;
        const h = (v / max) * plotH;
        y -= h;
        g.appendChild(mk('rect', { x: x.toFixed(1), y: y.toFixed(1), width: barW.toFixed(1), height: h.toFixed(1), rx: 1.5, class: 'b-' + p.cls }));
      });
      // Transparent hit area so the tooltip works on short bars too.
      g.appendChild(mk('rect', { x: (cx - slot / 2).toFixed(1), y: padT, width: slot.toFixed(1), height: plotH, fill: 'transparent' }));
      svg.appendChild(g);
      if (opts.labels !== false && i % 3 === 0 && typeof d.date === 'string' && d.date.length >= 10) {
        const t = mk('text', { x: cx.toFixed(1), y: H - 6, 'text-anchor': 'middle', class: 'lbl' });
        t.textContent = d.date.slice(5, 7) + '/' + d.date.slice(8, 10);
        svg.appendChild(t);
      }
    });
    host.appendChild(svg);
  }

  window.KickDash = {
    post: (url, payload) => sendJson('POST', url, payload),
    patch: (url, payload) => sendJson('PATCH', url, payload),
    put: (url, payload) => sendJson('PUT', url, payload),
    del: (url, payload) => sendJson('DELETE', url, payload),
    get: getJson,
    el, fmtTime, ago, status, table, bars,
    csrf: CSRF
  };
})();
