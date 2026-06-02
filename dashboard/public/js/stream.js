const $ = (s) => document.querySelector(s);

// Copy buttons
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const el = document.querySelector(btn.dataset.copy);
    await navigator.clipboard.writeText(el.value);
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = 'Copy'), 1200);
  });
});

$('#revealKey')?.addEventListener('click', () => {
  const k = $('#streamKey');
  k.type = k.type === 'password' ? 'text' : 'password';
});

$('#regenKey')?.addEventListener('click', async () => {
  if (!confirm('Regenerate your stream key? Your current key stops working immediately.')) return;
  const res = await fetch('/stream/api/key/regenerate', { method: 'POST' });
  const data = await res.json();
  if (data.ok) { $('#streamKey').value = data.streamKey; alert('New key set. Update OBS.'); }
});

// Prefill rtmp_url from the selected platform preset
$('#platformSel')?.addEventListener('change', (e) => {
  const preset = window.__PLATFORMS__[e.target.value];
  if (preset) $('#rtmpUrl').value = preset.rtmpUrl;
});

async function loadDestinations() {
  const res = await fetch('/stream/api/destinations');
  if (!res.ok) return;
  const { destinations } = await res.json();
  const list = $('#destList');
  list.innerHTML = '';
  destinations.forEach((d) => {
    const li = document.createElement('li');
    li.className = 'flex items-center justify-between bg-gray-800 rounded px-3 py-2 text-sm';
    // Build the label with textContent (never innerHTML) so a user-chosen
    // destination name can't inject markup/script into the page.
    const left = document.createElement('span');
    const dot = document.createElement('span');
    dot.className = 'dot inline-block w-2 h-2 rounded-full bg-gray-500 mr-2';
    const nameEl = document.createElement('strong');
    nameEl.textContent = d.name;
    const platEl = document.createElement('span');
    platEl.className = 'text-gray-500';
    platEl.textContent = ` (${d.platform})`;
    left.append(dot, nameEl, document.createTextNode(' '), platEl);
    li.append(left);
    const right = document.createElement('span');
    right.className = 'flex gap-2';
    const toggle = document.createElement('button');
    toggle.textContent = d.enabled ? 'Disable' : 'Enable';
    toggle.className = 'text-xs px-2 py-1 rounded ' + (d.enabled ? 'bg-yellow-700' : 'bg-green-700');
    toggle.onclick = async () => {
      await fetch(`/stream/api/destinations/${d.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !d.enabled })
      });
      loadDestinations();
    };
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'text-xs px-2 py-1 rounded bg-red-800';
    del.onclick = async () => {
      if (!confirm(`Delete ${d.name}?`)) return;
      await fetch(`/stream/api/destinations/${d.id}`, { method: 'DELETE' });
      loadDestinations();
    };
    right.append(toggle, del);
    li.dataset.name = d.name;
    li.append(right);
    list.append(li);
  });
}

$('#addDest')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const res = await fetch('/stream/api/destinations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Failed to add'); return; }
  e.target.reset();
  loadDestinations();
});

async function pollStatus() {
  try {
    const res = await fetch('/stream/api/status');
    if (!res.ok) return;
    const s = await res.json();
    $('#liveBadge').textContent = s.live ? 'LIVE' : 'offline';
    $('#liveBadge').className = 'text-xs px-2 py-1 rounded ' + (s.live ? 'bg-red-600' : 'bg-gray-700');
    const byName = Object.fromEntries((s.destinations || []).map((d) => [d.name, d]));
    document.querySelectorAll('#destList li').forEach((li) => {
      const st = byName[li.dataset.name];
      const dot = li.querySelector('.dot');
      const color = !st ? 'bg-gray-500'
        : st.state === 'live' ? 'bg-green-500'
        : st.state === 'failed' ? 'bg-red-500' : 'bg-yellow-500';
      dot.className = 'dot inline-block w-2 h-2 rounded-full mr-2 ' + color;
    });
  } catch {}
}

loadDestinations();
setInterval(pollStatus, 2000);
pollStatus();
