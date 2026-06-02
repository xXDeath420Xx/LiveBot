/* CertiFried Multicast — Studio client.
 * Manages the ingest panel, destination CRUD, and live status polling.
 * window.fetch is already CSRF-patched by /js/csrf.js (loaded before this). */
(function () {
  const $ = (s) => document.querySelector(s);
  const PLATFORMS = window.__PLATFORMS__ || {};

  // platform -> { icon HTML, css class } for the brand-colored badge
  const META = {
    twitch:    { icon: '<i class="fab fa-twitch"></i>',     cls: 'platform-twitch' },
    youtube:   { icon: '<i class="fab fa-youtube"></i>',    cls: 'platform-youtube' },
    kick:      { icon: '<b>K</b>',                          cls: 'platform-kick' },
    trovo:     { icon: '<b>T</b>',                          cls: 'platform-trovo' },
    tiktok:    { icon: '<i class="fab fa-tiktok"></i>',     cls: 'platform-tiktok' },
    facebook:  { icon: '<i class="fab fa-facebook-f"></i>', cls: 'platform-facebook' },
    instagram: { icon: '<i class="fab fa-instagram"></i>',  cls: 'platform-instagram' },
    twitter:   { icon: '<i class="fab fa-x-twitter"></i>',  cls: 'platform-twitter' },
    custom:    { icon: '<i class="fas fa-tower-broadcast"></i>', cls: 'platform-custom' },
  };
  const metaFor = (p) => META[p] || META.custom;
  const labelFor = (p) => (PLATFORMS[p] && PLATFORMS[p].name) || p;

  /* ---------- toast ---------- */
  function toast(message, kind = 'info') {
    const host = $('#toast-host');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : 'info');
    const ic = kind === 'ok' ? 'fa-circle-check' : kind === 'err' ? 'fa-circle-exclamation' : 'fa-circle-info';
    const i = document.createElement('i'); i.className = 'fas ' + ic;
    const span = document.createElement('span'); span.textContent = message;
    el.append(i, span);
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 3200);
  }

  /* ---------- ingest panel ---------- */
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const el = document.querySelector(btn.dataset.copy);
      try {
        await navigator.clipboard.writeText(el.value);
        toast('Copied to clipboard', 'ok');
      } catch { el.select(); document.execCommand && document.execCommand('copy'); toast('Copied', 'ok'); }
    });
  });

  $('#revealKey')?.addEventListener('click', (e) => {
    const k = $('#streamKey');
    const showing = k.type === 'text';
    k.type = showing ? 'password' : 'text';
    const icon = e.currentTarget.querySelector('i');
    if (icon) icon.className = showing ? 'fas fa-eye' : 'fas fa-eye-slash';
  });

  $('#regenKey')?.addEventListener('click', async () => {
    if (!confirm('Regenerate your stream key? Your current key stops working immediately and OBS must be updated.')) return;
    try {
      const res = await fetch('/stream/api/key/regenerate', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed');
      $('#streamKey').value = data.streamKey;
      $('#streamKey').type = 'text';
      const icon = $('#revealKey')?.querySelector('i'); if (icon) icon.className = 'fas fa-eye-slash';
      toast('New key generated — update OBS', 'ok');
    } catch (err) { toast(err.message || 'Could not regenerate key', 'err'); }
  });

  /* ---------- add-destination form: preset prefill ---------- */
  function applyPreset(key) {
    const p = PLATFORMS[key];
    const urlEl = $('#rtmpUrl'), keyEl = $('#destKey'), help = $('#helpUrl');
    if (!p) return;
    urlEl.value = p.rtmpUrl || '';
    if (p.keyPlaceholder) keyEl.placeholder = p.keyPlaceholder;
    if (p.helpUrl) { help.href = p.helpUrl; help.style.display = ''; } else { help.style.display = 'none'; }
  }
  $('#platformSel')?.addEventListener('change', (e) => applyPreset(e.target.value));
  if ($('#platformSel')) applyPreset($('#platformSel').value);

  /* ---------- destinations list ---------- */
  let lastDestinations = [];

  function renderDestinations(destinations) {
    lastDestinations = destinations;
    const list = $('#destList'), empty = $('#destEmpty');
    $('#destCount').textContent = destinations.length;
    $('#metaTotal').textContent = destinations.length;
    list.innerHTML = '';
    if (!destinations.length) { empty.style.display = ''; return; }
    empty.style.display = 'none';

    destinations.forEach((d) => {
      const m = metaFor(d.platform);
      const row = document.createElement('div');
      row.className = 'dest-item' + (d.enabled ? '' : ' is-disabled');
      row.dataset.name = d.name;

      const badge = document.createElement('div');
      badge.className = 'platform-icon ' + m.cls;
      badge.innerHTML = m.icon;

      const info = document.createElement('div');
      info.className = 'dest-info';
      const name = document.createElement('div'); name.className = 'dest-name'; name.textContent = d.name;
      const sub = document.createElement('div'); sub.className = 'dest-sub';
      const maskedKey = d.dest_stream_key ? '••••' + String(d.dest_stream_key).slice(-4) : 'no key';
      sub.textContent = labelFor(d.platform) + ' · ' + maskedKey;
      info.append(name, sub);

      const state = document.createElement('span');
      state.className = 'dest-state';
      state.innerHTML = '<span class="dot"></span><span class="lbl">' + (d.enabled ? 'Idle' : 'Off') + '</span>';

      const actions = document.createElement('div');
      actions.className = 'dest-actions';
      const toggle = document.createElement('button');
      toggle.className = 'icon-btn'; toggle.title = d.enabled ? 'Disable' : 'Enable';
      toggle.innerHTML = '<i class="fas ' + (d.enabled ? 'fa-toggle-on' : 'fa-toggle-off') + '"></i>';
      toggle.style.color = d.enabled ? 'var(--accent-green)' : '';
      toggle.onclick = () => patchDest(d.id, { enabled: !d.enabled });
      const del = document.createElement('button');
      del.className = 'icon-btn danger'; del.title = 'Delete';
      del.innerHTML = '<i class="fas fa-trash"></i>';
      del.onclick = () => deleteDest(d.id, d.name);
      actions.append(toggle, del);

      row.append(badge, info, state, actions);
      list.appendChild(row);
    });
  }

  async function loadDestinations() {
    try {
      const res = await fetch('/stream/api/destinations');
      if (!res.ok) return;
      const { destinations } = await res.json();
      renderDestinations(destinations || []);
    } catch {}
  }

  async function patchDest(id, body) {
    try {
      const res = await fetch('/stream/api/destinations/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Update failed');
      await loadDestinations();
    } catch (err) { toast(err.message, 'err'); }
  }

  async function deleteDest(id, name) {
    if (!confirm('Delete destination "' + name + '"?')) return;
    try {
      const res = await fetch('/stream/api/destinations/' + id, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast('Destination removed', 'ok');
      await loadDestinations();
    } catch (err) { toast(err.message, 'err'); }
  }

  $('#addDest')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      const res = await fetch('/stream/api/destinations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add destination');
      toast('Destination added', 'ok');
      e.target.reset();
      applyPreset($('#platformSel').value);
      await loadDestinations();
    } catch (err) { toast(err.message, 'err'); }
  });

  /* ---------- live status polling ---------- */
  function fmtUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(sec).padStart(2, '0');
  }

  function applyStatus(s) {
    const pill = $('#livePill'), pillText = $('#livePillText');
    const live = !!s.live;
    pill.classList.toggle('is-live', live);
    pillText.textContent = live ? 'LIVE' : 'Offline';
    $('#metaUptime').textContent = live && s.startedAt ? fmtUptime(Date.now() - s.startedAt) : '—';

    const byName = {};
    (s.destinations || []).forEach((d) => { byName[d.name] = d; });
    $('#metaActive').textContent = (s.destinations || []).filter((d) => d.state === 'live').length;

    document.querySelectorAll('#destList .dest-item').forEach((row) => {
      const st = byName[row.dataset.name];
      const stateEl = row.querySelector('.dest-state');
      const lbl = stateEl.querySelector('.lbl');
      stateEl.classList.remove('s-live', 's-failed', 's-connecting');
      if (!st || !live) { lbl.textContent = row.classList.contains('is-disabled') ? 'Off' : 'Idle'; return; }
      if (st.state === 'live') { stateEl.classList.add('s-live'); lbl.textContent = 'Live'; }
      else if (st.state === 'failed') { stateEl.classList.add('s-failed'); lbl.textContent = 'Failed'; }
      else { stateEl.classList.add('s-connecting'); lbl.textContent = 'Connecting'; }
    });
  }

  async function pollStatus() {
    try {
      const res = await fetch('/stream/api/status');
      if (!res.ok) return;
      applyStatus(await res.json());
    } catch {}
  }

  loadDestinations();
  pollStatus();
  setInterval(pollStatus, 2000);
})();
