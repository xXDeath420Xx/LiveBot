'use strict';
/*
 * The CertiFried Studio window. Talks to the main process only through window.studio (src/preload/preload.js).
 * Everything the main process sends is written with textContent, never as HTML.
 */
(function () {
    const api = window.studio;
    const $ = (id) => document.getElementById(id);
    let S = null;                 // last state from the main process
    let filter = 'all';
    let editingId = null;
    let recordedKeys = null;
    let devicesLoaded = false;

    const ACTION_TEXT = {
        'sound.play': 'Play sound', 'sound.stop': 'Stop all sounds', 'obs.scene': 'Switch scene', 'obs.source': 'Show or hide source',
        'obs.mute': 'Mute or unmute', 'obs.stream': 'Streaming', 'obs.record': 'Recording', 'obs.replay': 'Save replay', 'obs.screenshot': 'Screenshot',
    };

    function el(tag, attrs, ...children) {
        const n = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v == null || v === false) continue;
            if (k === 'class') n.className = v;
            else if (k === 'text') n.textContent = v;
            else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
            else n.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children) if (c != null) n.append(c);
        return n;
    }
    function setMsg(id, text, kind) {
        const m = $(id);
        m.textContent = text || '';
        m.className = `msg${kind ? ` ${kind}` : ''}`;
    }
    async function call(channel, payload) {
        const r = await api.call(channel, payload);
        if (!r || !r.ok) throw new Error((r && r.error) || 'Something went wrong');
        return r;
    }
    function time(t) {
        const d = new Date(t);
        return d.toTimeString().slice(0, 8);
    }

    // ── tabs ──
    function showTab(name) {
        for (const b of document.querySelectorAll('.nav-item')) b.setAttribute('aria-current', b.dataset.tab === name ? 'page' : 'false');
        for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${name}`;
        if (name === 'sounds' && !devicesLoaded) loadDevices();
        if (name === 'voice') loadMicrophones();
        if (name === 'setup') refreshSetup();
        if (name === 'hotkeys' && S && S.engine.features.includes('request')) call('automations:refresh').catch(() => {});
    }
    document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    document.addEventListener('click', (e) => {
        const g = e.target.closest('[data-goto]');
        if (g) { e.preventDefault(); showTab(g.dataset.goto); }
        const p = e.target.closest('[data-page]');
        if (p) { e.preventDefault(); call('app:openPage', { page: p.dataset.page }).catch(() => {}); }
    });

    // ── render ──
    const ENGINE_TONE = { connected: 'ok', connecting: 'warn', reconnecting: 'warn', auth_failed: 'bad', revoked: 'bad', replaced: 'bad' };
    const OBS_TONE = { connected: 'ok', connecting: 'warn', unreachable: 'bad', auth_failed: 'bad', too_old: 'bad' };

    function render() {
        if (!S) return;
        document.documentElement.dataset.theme = S.app.theme || 'dark';
        $('version').textContent = `Version ${S.version}${S.isPortable ? ' (portable)' : ''}`;

        const eTone = S.paired ? (ENGINE_TONE[S.engine.status] || '') : 'bad';
        const eLabel = S.paired ? S.engine.label : 'Not paired';
        $('engine-pill').textContent = eLabel; $('engine-pill').className = `pill ${eTone}`;
        $('dot-engine').className = `dot ${eTone}`; $('side-engine').textContent = `CertiFried: ${eLabel}`;
        const oTone = OBS_TONE[S.obs.status] || '';
        $('obs-pill').textContent = S.obs.label; $('obs-pill').className = `pill ${oTone}`;
        $('dot-obs').className = `dot ${oTone}`; $('side-obs').textContent = `OBS: ${S.obs.label}`;

        $('pair-card').hidden = S.paired;
        const lk = S.link;
        $('link-idle').hidden = !!(lk && lk.status === 'waiting');
        $('link-wait').hidden = !(lk && lk.status === 'waiting');
        $('link-check').textContent = lk ? lk.check : '';
        if (lk && lk.status === 'ended' && lk.error) setMsg('link-msg', lk.error, 'bad');
        else if (lk && lk.status === 'waiting') setMsg('link-msg', '');
        $('obs-offer').hidden = !S.obs.offerImport;
        $('obs-import-status').hidden = !S.obs.offerImport;
        $('engine-device').textContent = S.paired ? (S.device.name || `Device ${S.device.id}`) : '-';
        $('engine-server').textContent = S.server.replace(/^https?:\/\//, '');
        $('engine-reconnect').disabled = !S.paired;
        let note = '';
        if (S.paired && S.engine.status === 'connected' && !S.engine.features.includes('request')) note = 'Hotkeys that run automations, OBS events and dashboard sounds need the next CertiFried server update. Actions from automations work now.';
        if (S.engine.status === 'revoked' || S.engine.status === 'auth_failed') note = 'Pair this PC again: unpair in Settings, then enter a new code.';
        if (S.engine.status === 'replaced') note = 'Another copy of the app connected with this pairing. Close it, then choose Reconnect.';
        $('engine-note').textContent = note;
        $('storage-banner').hidden = !S.storage.banner;
        $('storage-banner').textContent = S.storage.banner || '';
        $('storage-note').hidden = !S.storage.note;
        $('storage-note').textContent = S.storage.note || '';

        const o = S.obs;
        $('obs-address').textContent = o.settings.enabled ? `${o.settings.host}:${o.settings.port}` : 'Off';
        $('obs-version').textContent = o.snapshot.version || '-';
        $('obs-scene').textContent = o.snapshot.currentScene || '-';
        $('obs-output').textContent = o.snapshot.connected ? [o.snapshot.streaming ? 'Streaming' : 'Not streaming', o.snapshot.recording ? 'recording' : 'not recording'].join(', ') : '-';
        $('obs-note').textContent = o.status === 'auth_failed' ? (o.hasPassword ? 'OBS did not accept the password. Check it in Settings.' : 'OBS needs a password.')
            : o.status === 'unreachable' ? 'OBS is not running, or the WebSocket server is off, or the port is different. The app keeps trying.' : '';

        renderLog($('recent-log'), S.activity.slice(-6).reverse());
        renderActivity();
        renderSounds();
        renderHotkeys();
        renderSettings();
        renderUpdate();
        renderVoice();
        renderVod();
    }

    function logItem(a) {
        const tag = a.kind === 'action' ? 'Action' : a.kind === 'event' ? 'OBS' : a.kind === 'hotkey' ? 'Hotkey' : '';
        return el('li', null,
            el('span', { class: 'time', text: time(a.t) }),
            el('div', { class: 'what' },
                el('div', { text: a.title }),
                a.detail ? el('div', { class: 'detail', text: a.detail }) : null,
                a.ok === false && a.error ? el('div', { class: 'err', text: a.error }) : null),
            el('span', { class: 'tag', text: a.ok === false ? `${tag ? `${tag} · ` : ''}failed` : tag }));
    }
    function renderLog(ul, list) {
        ul.replaceChildren(...list.map(logItem));
        if (!list.length) ul.replaceChildren(el('li', null, el('span'), el('span', { class: 'detail', text: 'Nothing yet.' }), el('span')));
    }
    function renderActivity() {
        const list = S.activity.filter((a) => filter === 'all' || a.kind === filter).slice().reverse();
        $('activity-log').replaceChildren(...list.map(logItem));
        $('activity-log').hidden = !list.length;
        $('activity-empty').hidden = !!list.length;
    }
    document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
        filter = b.dataset.filter;
        document.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        renderActivity();
    }));

    // ── sounds ──
    async function loadDevices() {
        try {
            const r = await call('sound:devices');
            const sel = $('snd-device');
            const cur = S ? S.sound.settings.outputDeviceId : 'default';
            const list = r.devices.length ? r.devices : [{ id: 'default', label: 'Windows default' }];
            if (!list.some((d) => d.id === cur)) list.push({ id: cur, label: 'Saved device (not plugged in)' });
            sel.replaceChildren(...list.map((d) => el('option', { value: d.id, text: d.id === 'default' ? 'Windows default' : d.label })));
            sel.value = cur;
            devicesLoaded = true;
        } catch (e) { /* audio window not ready yet */ }
    }
    function renderSounds() {
        const s = S.sound.settings;
        if (document.activeElement !== $('snd-volume')) $('snd-volume').value = s.masterVolume;
        $('snd-volume-out').textContent = `${$('snd-volume').value}%`;
        $('snd-mode').value = s.defaultMode;
        $('snd-syncauto').checked = !!s.syncDashboard;
        $('snd-sync').disabled = !S.engine.features.includes('request');
        const rows = S.sound.library.map((x) => el('tr', null,
            el('td', { text: x.name }),
            el('td', { text: x.source === 'dashboard' ? 'Dashboard' : 'Folder' }),
            el('td', { class: 'right' }, el('button', { class: 'btn small', type: 'button', text: 'Play', onclick: () => call('sound:test', { name: x.name }).catch((e) => setMsg('snd-msg', e.message, 'bad')) }))));
        $('snd-table').tBodies[0].replaceChildren(...rows);
        $('snd-table').hidden = !rows.length;
        $('snd-empty').hidden = !!rows.length;
    }
    $('snd-device').addEventListener('change', (e) => call('sound:settings', { outputDeviceId: e.target.value }).catch(() => {}));
    $('snd-volume').addEventListener('input', (e) => { $('snd-volume-out').textContent = `${e.target.value}%`; });
    $('snd-volume').addEventListener('change', (e) => call('sound:settings', { masterVolume: Number(e.target.value) }).catch(() => {}));
    $('snd-mode').addEventListener('change', (e) => call('sound:settings', { defaultMode: e.target.value }).catch(() => {}));
    $('snd-syncauto').addEventListener('change', (e) => call('sound:settings', { syncDashboard: e.target.checked }).catch(() => {}));
    $('snd-stop').addEventListener('click', () => call('sound:stop').catch(() => {}));
    $('snd-folder').addEventListener('click', () => call('sound:openFolder').catch(() => {}));
    $('snd-sync').addEventListener('click', async () => {
        setMsg('snd-msg', 'Syncing...');
        try {
            const r = await call('sound:sync');
            setMsg('snd-msg', `Synced: ${r.result.total} dashboard sounds, ${r.result.downloaded} downloaded.`, 'ok');
        } catch (e) { setMsg('snd-msg', e.message, 'bad'); }
    });

    // ── hotkeys ──
    function describeBinding(b) {
        if (b.action.kind === 'automation') return `Run ${b.action.automationName || `automation ${b.action.automationId}`}`;
        const p = b.action.params || {};
        const what = ACTION_TEXT[b.action.type] || b.action.type;
        const extra = p.sound || p.scene || p.source || p.input || p.state || '';
        return extra ? `${what}: ${extra}` : what;
    }
    function renderHotkeys() {
        const fails = new Map((S.hotkeyFailures || []).map((f) => [f.id, f.reason]));
        const rows = S.hotkeys.map((b) => el('tr', null,
            el('td', null, el('kbd', { text: b.accelerator }), fails.has(b.id) ? el('span', { class: 'warn-note', text: fails.get(b.id) === 'in_use' ? 'Another program already uses these keys' : fails.get(b.id) === 'duplicate' ? 'Used twice' : 'Not valid' }) : null),
            el('td', { text: describeBinding(b) }),
            el('td', null, el('input', { type: 'checkbox', 'aria-label': 'On', checked: b.enabled !== false, onchange: (e) => saveHotkeys(S.hotkeys.map((x) => (x.id === b.id ? { ...x, enabled: e.target.checked } : x))) })),
            el('td', { class: 'right' },
                el('button', { class: 'btn small', type: 'button', text: 'Test', onclick: () => call('hotkeys:run', { id: b.id }).catch(() => {}) }), ' ',
                el('button', { class: 'btn small', type: 'button', text: 'Edit', onclick: () => editHotkey(b) }), ' ',
                el('button', { class: 'btn small danger', type: 'button', text: 'Remove', onclick: () => saveHotkeys(S.hotkeys.filter((x) => x.id !== b.id)) }))));
        $('hk-table').tBodies[0].replaceChildren(...rows);
        $('hk-table').hidden = !rows.length;
        $('hk-empty').hidden = !!rows.length;
        if (document.activeElement && $('hk-fields').contains(document.activeElement)) return;
        renderHotkeyFields();
    }

    function options(list, current, emptyText) {
        const opts = list.map((v) => el('option', { value: v, text: v }));
        if (current && !list.includes(current)) opts.unshift(el('option', { value: current, text: current }));
        if (!opts.length) opts.push(el('option', { value: '', text: emptyText }));
        return opts;
    }
    let fieldValues = {};
    function renderHotkeyFields() {
        const kind = $('hk-kind').value;
        const box = $('hk-fields');
        const snap = S.obs.snapshot;
        const fields = [];
        const sel = (name, label, list, empty) => {
            const s = el('select', { 'data-name': name }, ...options(list, fieldValues[name], empty));
            if (fieldValues[name]) s.value = fieldValues[name];
            s.addEventListener('change', () => { fieldValues[name] = s.value; if (name === 'scene') renderHotkeyFields(); });
            fields.push(el('label', { class: 'field' }, el('span', { text: label }), s));
        };
        const choice = (name, label, pairs) => {
            const s = el('select', { 'data-name': name }, ...pairs.map(([v, t]) => el('option', { value: v, text: t })));
            if (fieldValues[name]) s.value = fieldValues[name];
            s.addEventListener('change', () => { fieldValues[name] = s.value; });
            fields.push(el('label', { class: 'field' }, el('span', { text: label }), s));
        };
        if (kind === 'automation') {
            const list = S.automations || [];
            const s = el('select', { 'data-name': 'automationId' }, ...(list.length
                ? list.map((a) => el('option', { value: String(a.id), text: a.enabled ? a.name : `${a.name} (off)` }))
                : [el('option', { value: '', text: S.engine.features.includes('request') ? 'No automations yet' : 'Needs a connection to CertiFried' })]));
            if (fieldValues.automationId) s.value = fieldValues.automationId;
            s.addEventListener('change', () => { fieldValues.automationId = s.value; });
            fields.push(el('label', { class: 'field' }, el('span', { text: 'Automation' }), s));
        } else if (kind === 'sound.play') {
            sel('sound', 'Sound', S.sound.library.map((x) => x.name), 'No sounds in the library');
            const v = el('input', { type: 'number', min: '0', max: '100', 'data-name': 'volume', value: fieldValues.volume || '100' });
            v.addEventListener('input', () => { fieldValues.volume = v.value; });
            fields.push(el('label', { class: 'field' }, el('span', { text: 'Volume (0-100)' }), v));
        } else if (kind === 'obs.scene') {
            sel('scene', 'Scene', snap.scenes || [], 'Connect OBS to list scenes');
        } else if (kind === 'obs.source') {
            sel('scene', 'Scene', snap.scenes || [], 'Connect OBS to list scenes');
            const scene = fieldValues.scene || (snap.scenes || [])[0];
            sel('source', 'Source', (snap.sources || {})[scene] || [], 'No sources');
            choice('visible', 'Make it', [['toggle', 'Toggle'], ['show', 'Show'], ['hide', 'Hide']]);
        } else if (kind === 'obs.mute') {
            sel('input', 'Audio source', (snap.inputs || []).map((i) => i.name), 'Connect OBS to list sources');
            choice('state', 'Action', [['toggle', 'Toggle'], ['mute', 'Mute'], ['unmute', 'Unmute']]);
        } else if (kind === 'obs.stream' || kind === 'obs.record') {
            choice('state', 'Action', kind === 'obs.record' ? [['toggle', 'Start or stop'], ['toggle_pause', 'Pause or resume']] : [['toggle', 'Start or stop'], ['start', 'Start'], ['stop', 'Stop']]);
        } else if (kind === 'obs.screenshot') {
            sel('source', 'Source (empty: what is on air)', [''].concat(snap.scenes || []), '');
        }
        box.replaceChildren(...fields);
    }
    $('hk-kind').addEventListener('change', () => { fieldValues = {}; renderHotkeyFields(); });

    function readFields() {
        const out = {};
        for (const n of $('hk-fields').querySelectorAll('[data-name]')) out[n.dataset.name] = n.value;
        return out;
    }

    const CODE_KEYS = { Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
        ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`',
        NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
        MediaPlayPause: 'MediaPlayPause', MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack', MediaStop: 'MediaStop', AudioVolumeUp: 'VolumeUp', AudioVolumeDown: 'VolumeDown', AudioVolumeMute: 'VolumeMute' };
    function keyFromEvent(e) {
        const c = e.code || '';
        if (/^Key[A-Z]$/.test(c)) return c.slice(3);
        if (/^Digit[0-9]$/.test(c)) return c.slice(5);
        if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) return c;
        if (/^Numpad[0-9]$/.test(c)) return `num${c.slice(6)}`;
        return CODE_KEYS[c] || null;
    }
    const keysInput = $('hk-keys');
    keysInput.addEventListener('focus', () => { keysInput.classList.add('recording'); keysInput.placeholder = 'Press the keys now'; call('hotkeys:pause', { paused: true }).catch(() => {}); });
    keysInput.addEventListener('blur', () => { keysInput.classList.remove('recording'); keysInput.placeholder = 'Click, then press the keys'; call('hotkeys:pause', { paused: false }).catch(() => {}); });
    keysInput.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) return;
        e.preventDefault();
        const key = keyFromEvent(e);
        if (!key) return;
        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        if (e.metaKey) parts.push('Super');
        parts.push(key);
        recordedKeys = parts.join('+');
        keysInput.value = recordedKeys;
    });

    function editHotkey(b) {
        editingId = b.id;
        $('hk-form-title').textContent = 'Change hotkey';
        $('hk-cancel').hidden = false;
        recordedKeys = b.accelerator;
        keysInput.value = b.accelerator;
        $('hk-kind').value = b.action.kind === 'automation' ? 'automation' : b.action.type;
        fieldValues = b.action.kind === 'automation' ? { automationId: String(b.action.automationId) } : { ...(b.action.params || {}) };
        for (const k of Object.keys(fieldValues)) fieldValues[k] = String(fieldValues[k]);
        renderHotkeyFields();
        $('hk-form').scrollIntoView({ behavior: 'smooth' });
    }
    function resetHotkeyForm() {
        editingId = null; recordedKeys = null; keysInput.value = ''; fieldValues = {};
        $('hk-form-title').textContent = 'Add a hotkey';
        $('hk-cancel').hidden = true;
        renderHotkeyFields();
    }
    $('hk-cancel').addEventListener('click', () => { resetHotkeyForm(); setMsg('hk-msg', ''); });

    async function saveHotkeys(list) {
        try {
            const r = await call('hotkeys:save', { bindings: list });
            const failed = r.result.failed || [];
            if (failed.length) setMsg('hk-msg', 'Saved. Some keys could not be used; see the list.', 'bad');
            return true;
        } catch (e) { setMsg('hk-msg', e.message, 'bad'); return false; }
    }
    $('hk-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!recordedKeys) { setMsg('hk-msg', 'Click the Keys box and press the combination.', 'bad'); return; }
        const kind = $('hk-kind').value;
        const f = readFields();
        let action;
        if (kind === 'automation') {
            const a = (S.automations || []).find((x) => String(x.id) === f.automationId);
            if (!a) { setMsg('hk-msg', 'Pick an automation.', 'bad'); return; }
            action = { kind: 'automation', automationId: a.id, automationName: a.name };
        } else {
            const params = {};
            for (const [k, v] of Object.entries(f)) if (v !== '') params[k] = k === 'volume' ? Number(v) : v;
            if (kind === 'sound.play' && !params.sound) { setMsg('hk-msg', 'Pick a sound.', 'bad'); return; }
            if (kind === 'obs.scene' && !params.scene) { setMsg('hk-msg', 'Pick a scene.', 'bad'); return; }
            if (kind === 'obs.source' && !params.source) { setMsg('hk-msg', 'Pick a source.', 'bad'); return; }
            if (kind === 'obs.mute' && !params.input) { setMsg('hk-msg', 'Pick an audio source.', 'bad'); return; }
            action = { kind: 'action', type: kind, params };
        }
        const binding = { id: editingId || undefined, accelerator: recordedKeys, action, enabled: true };
        const list = editingId ? S.hotkeys.map((x) => (x.id === editingId ? { ...binding, enabled: x.enabled } : x)) : [...S.hotkeys, binding];
        if (await saveHotkeys(list)) { setMsg('hk-msg', 'Saved.', 'ok'); resetHotkeyForm(); }
    });

    // ── settings ──
    function renderSettings() {
        const o = S.obs.settings;
        if (!$('obs-form').contains(document.activeElement)) {
            $('obs-enabled').checked = o.enabled !== false;
            $('obs-host').value = o.host;
            $('obs-port').value = o.port;
            $('obs-password').placeholder = S.obs.hasPassword ? 'Saved (type to change)' : 'No password';
            $('obs-clear-wrap').hidden = !S.obs.hasPassword;
        }
        $('set-device').textContent = S.paired ? (S.device.name || `Device ${S.device.id}`) : 'Not paired';
        $('set-server').textContent = S.server;
        $('unpair-btn').disabled = !S.paired;
        $('server-form').querySelector('button').disabled = S.paired;
        if (document.activeElement !== $('server-input')) $('server-input').value = S.server;
        $('server-input').disabled = S.paired;
        $('app-theme').value = S.app.theme;
        $('app-login').checked = !!S.app.startWithWindows;
        $('app-min').checked = !!S.app.startMinimised;
        $('app-updates').checked = !!S.app.checkUpdates;
        $('app-links').hidden = !S.isPortable;
        $('app-about').textContent = `CertiFried Studio ${S.version}${S.isPortable ? ', portable' : ''}. Pressing keys for automations: ${S.keySending ? 'available' : 'not available on this PC'}.`;
    }
    $('obs-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        setMsg('obs-msg', 'Saving...');
        try {
            await call('obs:save', { enabled: $('obs-enabled').checked, host: $('obs-host').value, port: Number($('obs-port').value), password: $('obs-password').value, clearPassword: $('obs-clear').checked });
            $('obs-password').value = '';
            $('obs-clear').checked = false;
            setMsg('obs-msg', 'Saved. Connecting...', 'ok');
            document.activeElement.blur();
        } catch (err) { setMsg('obs-msg', err.message, 'bad'); }
    });
    $('obs-reconnect').addEventListener('click', () => call('obs:reconnect').catch(() => {}));
    $('engine-reconnect').addEventListener('click', () => call('engine:reconnect').catch(() => {}));
    $('unpair-btn').addEventListener('click', async () => {
        if (!confirm('Unpair this PC? Automations stop reaching it until you pair again. Remove it on the dashboard\'s Devices page too.')) return;
        await call('unpair').catch(() => {});
    });
    $('server-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await call('server:set', { server: $('server-input').value }); setMsg('server-msg', 'Saved.', 'ok'); } catch (err) { setMsg('server-msg', err.message, 'bad'); }
    });
    $('app-theme').addEventListener('change', (e) => { document.documentElement.dataset.theme = e.target.value; call('app:settings', { theme: e.target.value }).catch(() => {}); });
    $('app-login').addEventListener('change', (e) => call('app:settings', { startWithWindows: e.target.checked }).catch(() => {}));
    $('app-min').addEventListener('change', (e) => call('app:settings', { startMinimised: e.target.checked }).catch(() => {}));
    $('app-updates').addEventListener('change', (e) => call('app:settings', { checkUpdates: e.target.checked }).catch(() => {}));
    $('app-check').addEventListener('click', async () => {
        setMsg('app-msg', 'Checking...');
        try {
            const r = await call('app:checkUpdates');
            const st = r.update.state;
            setMsg('app-msg', st === 'none' ? 'You have the latest version.' : st === 'error' ? 'Could not check right now.' : st === 'portable-available' ? `Version ${r.update.version} is on the download page.` : 'Downloading the update...', st === 'error' ? 'bad' : 'ok');
        } catch (err) { setMsg('app-msg', err.message, 'bad'); }
    });
    $('app-logs').addEventListener('click', () => call('app:openLogs').catch(() => {}));
    $('app-links').addEventListener('click', async () => {
        const r = await call('app:registerLinks').catch(() => null);
        setMsg('app-msg', r && r.registered ? 'Pairing links from the dashboard now open this copy.' : 'Windows did not accept the change.', r && r.registered ? 'ok' : 'bad');
    });
    $('app-quit').addEventListener('click', () => call('app:quit').catch(() => {}));

    function renderUpdate() {
        const u = S.update || {};
        const b = $('update-banner');
        if (u.state === 'ready') {
            b.replaceChildren(el('span', { text: `Version ${u.version} is ready.` }), el('button', { class: 'btn primary', type: 'button', text: 'Restart to update', onclick: () => call('app:installUpdate') }));
            b.hidden = false;
        } else if (u.state === 'portable-available') {
            b.replaceChildren(el('span', { text: `Version ${u.version} is available.` }), el('button', { class: 'btn', type: 'button', text: 'Open the download page', 'data-page': 'download' }));
            b.hidden = false;
        } else b.hidden = true;
    }

    // ── VOD-safe music ──
    function renderVod() {
        const v = S.vod;
        if (!v) return;
        $('vod-pill').textContent = v.vodSafe ? 'Protected' : 'Music paused';
        $('vod-pill').className = `pill ${v.vodSafe ? 'ok' : 'bad'}`;
        $('vod-reason').textContent = v.vodSafe ? '' : (v.reason || '');
        $('vod-reason').className = `msg${v.vodSafe ? '' : ' bad'}`;
        $('vod-track').textContent = v.vodTrack ? `Track ${v.vodTrack} (live audio on track ${v.liveTrack})` : '-';
        $('vod-source').textContent = v.sourceReady ? v.sourceName : '-';
        document.querySelectorAll('.vod-track-n').forEach((n) => { n.textContent = v.vodTrack || 2; });
        $('vod-warn-wrap').hidden = !v.warnings.length;
        $('vod-warn').tBodies[0].replaceChildren(...v.warnings.map((w) => el('tr', null, el('td', { text: w.name }),
            el('td', { class: 'right' }, el('button', { class: 'btn small', type: 'button', text: 'Keep out of VOD', onclick: async () => {
                try { await call('vod:keepOut', { name: w.name }); setMsg('vod-msg', `${w.name} is now kept out of the VOD.`, 'ok'); } catch (err) { setMsg('vod-msg', err.message, 'bad'); }
            } })))));
        $('vod-desktop').hidden = !v.desktopWarning;
        if (document.activeElement !== $('vod-kick')) $('vod-kick').value = v.kickMusic || 'unknown';
        $('vod-record').checked = !!v.recordWithoutMusic;
    }
    $('vod-check').addEventListener('click', async () => { try { await call('vod:check'); setMsg('vod-msg', 'Checked.', 'ok'); } catch (err) { setMsg('vod-msg', err.message, 'bad'); } });
    $('vod-kick').addEventListener('change', (e) => call('vod:kick', { choice: e.target.value }).catch(() => {}));
    $('vod-record').addEventListener('change', async (e) => {
        try { await call('vod:record', { on: e.target.checked }); setMsg('vod-msg', e.target.checked ? 'Recordings now use only the VOD track.' : 'Recording tracks put back as they were.', 'ok'); } catch (err) { e.target.checked = !e.target.checked; setMsg('vod-msg', err.message, 'bad'); }
    });

    // ── voice ──
    let micsLoaded = false;
    async function loadMicrophones() {
        if (micsLoaded) return;
        try {
            const r = await call('voice:devices');
            const cur = S ? S.voice.settings.inputDeviceId : 'default';
            const list = r.devices.length ? r.devices : [{ id: 'default', label: 'Windows default' }];
            if (!list.some((d) => d.id === cur)) list.push({ id: cur, label: 'Saved microphone (not plugged in)' });
            $('voice-device').replaceChildren(...list.map((d) => el('option', { value: d.id, text: d.id === 'default' ? 'Windows default' : d.label })));
            $('voice-device').value = cur;
            micsLoaded = true;
        } catch (e) { /* audio window not ready */ }
    }
    const VOICE_LABEL = { off: 'Off', starting: 'Starting', listening: 'Listening', error: 'Not working' };
    function renderVoice() {
        const v = S.voice;
        if (!v) return;
        $('voice-unavailable').hidden = v.available;
        $('voice-enabled').checked = !!v.settings.enabled;
        $('voice-enabled').disabled = !v.available;
        let label = VOICE_LABEL[v.status.state] || 'Off';
        if (v.settings.enabled && v.status.state === 'listening' && v.settings.mode === 'ptt') label = v.held ? 'Listening (key held)' : 'Waiting for the key';
        $('voice-pill').textContent = label;
        $('voice-pill').className = `pill ${v.status.state === 'listening' ? 'ok' : v.status.state === 'error' || v.mic === 'error' ? 'bad' : v.status.state === 'starting' ? 'warn' : ''}`;
        $('voice-error').textContent = v.micError || (v.status.state === 'error' ? v.status.error : '') || '';
        const last = v.status.lastHeard;
        $('voice-last').textContent = last ? `Last heard: "${last.text}", ${Math.round(last.confidence * 100)}% sure${last.accepted ? '' : ' (not counted: below the setting, or said twice quickly)'}` : '';
        if (document.activeElement !== $('voice-mode')) $('voice-mode').value = v.settings.mode;
        $('voice-ptt-wrap').hidden = v.settings.mode !== 'ptt';
        if (document.activeElement !== $('voice-ptt')) $('voice-ptt').value = v.settings.pttKey || '';
        if (document.activeElement !== $('voice-threshold')) $('voice-threshold').value = Math.round((v.settings.threshold || 0.7) * 100);
        $('voice-threshold-out').textContent = `${$('voice-threshold').value}%`;
        $('voice-phrases').replaceChildren(...v.phrases.map((p) => el('li', { text: p })));
        $('voice-empty').hidden = v.phrases.length > 0;
        setMeter(v.settings.enabled ? v.level : 0);
    }
    function setMeter(level) { $('voice-meter').style.width = `${Math.min(100, Math.round(Math.sqrt(level) * 140))}%`; }
    api.on('voice-level', (x) => { if (S && S.voice.settings.enabled) setMeter(x.level); });
    $('voice-enabled').addEventListener('change', (e) => call('voice:settings', { enabled: e.target.checked }).catch((err) => setMsg('voice-msg', err.message, 'bad')));
    $('voice-device').addEventListener('change', (e) => call('voice:settings', { inputDeviceId: e.target.value }).catch(() => {}));
    $('voice-mode').addEventListener('change', (e) => call('voice:settings', { mode: e.target.value }).catch(() => {}));
    $('voice-threshold').addEventListener('input', (e) => { $('voice-threshold-out').textContent = `${e.target.value}%`; });
    $('voice-threshold').addEventListener('change', (e) => call('voice:settings', { threshold: Number(e.target.value) / 100 }).catch(() => {}));
    $('voice-ptt').addEventListener('keydown', (e) => {
        if (e.key === 'Tab') return;
        e.preventDefault();
        const key = keyFromEvent(e);
        if (!key) return;
        const name = /^num\d$/.test(key) ? `Num${key.slice(3)}` : key;
        $('voice-ptt').value = name;
        call('voice:settings', { pttKey: name }).then(() => setMsg('voice-msg', `Hold ${name} to talk.`, 'ok')).catch((err) => setMsg('voice-msg', err.message, 'bad'));
    });
    $('voice-refresh').addEventListener('click', async () => {
        try { const r = await call('voice:refresh'); setMsg('voice-msg', `${r.phrases.length} voice commands.`, 'ok'); } catch (err) { setMsg('voice-msg', err.message, 'bad'); }
    });

    // ── OBS setup ──
    let setup = null;
    async function refreshSetup() {
        try { setup = (await call('setup:status')).setup; } catch (e) { return; }
        renderSetup();
    }
    function pill(id, text, tone) { $(id).textContent = text; $(id).className = `pill ${tone || ''}`; }
    function renderSetup() {
        if (!setup || !S) return;
        const wsOk = S.obs.status === 'connected';
        pill('step-ws-pill', wsOk ? 'Connected' : 'Not connected', wsOk ? 'ok' : 'warn');
        $('step-ws-import').hidden = wsOk;
        pill('step-docks-pill', setup.docksInObs >= 3 ? 'Added' : setup.dockConfig ? 'Not added' : 'OBS not found', setup.docksInObs >= 3 ? 'ok' : '');
        $('step-docks-running').hidden = !setup.obsRunning;
        $('step-docks-add').disabled = setup.obsRunning || !setup.dockConfig || !S.engine.features.includes('request');
        $('step-docks-table').tBodies[0].replaceChildren(...setup.dockList.filter((d) => d.url).map((d) => el('tr', null,
            el('td', { text: d.title }),
            el('td', { class: 'right' },
                el('button', { class: 'btn small', type: 'button', text: 'Copy name', onclick: () => call('app:copy', { text: d.title }) }), ' ',
                el('button', { class: 'btn small', type: 'button', text: 'Copy address', onclick: () => call('app:copy', { text: d.url }).then(() => setMsg('step-docks-msg', `Copied the ${d.title} address.`, 'ok')) })))));
        pill('step-theme-pill', setup.themeInstalled ? 'Installed' : 'Not installed', setup.themeInstalled ? 'ok' : '');
        pill('step-scenes-pill', setup.starter.length ? `${setup.starter.length} to create` : 'All there', setup.starter.length ? '' : 'ok');
        $('step-scenes-list').replaceChildren(...setup.starterAll.map((n) => {
            const missing = setup.starter.includes(n);
            return el('label', { class: 'check' }, el('input', { type: 'checkbox', 'data-scene': n, checked: false, disabled: !missing }), ` ${n}${missing ? '' : ' (already in OBS)'}`);
        }));
        $('step-scenes-create').disabled = !setup.obsConnected || !setup.starter.length;
        $('step-overlay-refresh').disabled = !setup.overlayAvailable;
        if (!setup.overlayAvailable) pill('step-overlay-pill', 'Connect to CertiFried', 'warn');
    }
    // CertiFried overlays: one row per overlay, saying what its button will do before it is clicked.
    async function refreshOverlays() {
        setMsg('step-overlay-msg', 'Asking CertiFried...');
        let r;
        try { r = await call('overlays:list'); } catch (err) { setMsg('step-overlay-msg', err.message, 'bad'); return; }
        const rows = r.overlays || [];
        setMsg('step-overlay-msg', rows.length ? (r.obsConnected ? '' : 'Connect OBS to add them.') : 'No overlays yet. Make one on the Overlays tab of the dashboard, then show them again.', rows.length && r.obsConnected ? '' : 'warn');
        const done = rows.filter((o) => o.plan.action === 'there').length;
        pill('step-overlay-pill', rows.length ? `${done} of ${rows.length} in this scene` : 'None yet', rows.length && done === rows.length ? 'ok' : '');
        $('step-overlay-table').tBodies[0].replaceChildren(...rows.map((o) => el('tr', null,
            el('td', null, el('strong', { text: o.name || o.label }), el('br'), el('span', { class: 'muted', text: `${o.label}. ${o.plan.text}` })),
            el('td', { class: 'right' }, el('button', { class: 'btn small primary', type: 'button', text: o.plan.action === 'there' ? 'Added' : o.plan.action === 'update' ? 'Update' : 'Add to scene',
                disabled: !r.obsConnected || o.plan.action === 'there' || o.plan.action === 'none',
                onclick: async () => {
                    setMsg('step-overlay-msg', `Adding ${o.sourceName}...`);
                    try { const x = (await call('overlays:add', { id: o.id })).result; setMsg('step-overlay-msg', `${x.sourceName} is in ${x.scene}.`, 'ok'); } catch (err) { setMsg('step-overlay-msg', err.message, 'bad'); return; }
                    refreshOverlays();
                } })))));
    }
    $('step-overlay-refresh').addEventListener('click', refreshOverlays);
    $('step-overlay-site').addEventListener('click', () => call('app:openPage', { page: 'overlays' }).catch(() => {}));
    $('step-ws-import').addEventListener('click', async () => {
        try { const r = await call('obs:import'); setMsg('step-ws-msg', `Found OBS on port ${r.port}. Connecting...`, 'ok'); } catch (err) { setMsg('step-ws-msg', err.message, 'bad'); }
    });
    $('step-docks-check').addEventListener('click', () => { setMsg('step-docks-msg', ''); refreshSetup(); });
    $('step-docks-add').addEventListener('click', async () => {
        setMsg('step-docks-msg', 'Adding...');
        try {
            const r = (await call('docks:add')).result;
            setMsg('step-docks-msg', `Added ${r.added} docks${r.kept ? `, kept your ${r.kept} other docks` : ''}. Backup: ${r.backup}. Open OBS; the docks appear under Docks.`, 'ok');
        } catch (err) { setMsg('step-docks-msg', err.message, 'bad'); }
        refreshSetup();
    });
    async function prepareDocks(regenerate) {
        try { await call('docks:prepare', { regenerate }); setMsg('step-docks-msg', regenerate ? 'New addresses made. The old ones stop working; add the new ones to OBS.' : '', 'ok'); } catch (err) { setMsg('step-docks-msg', err.message, 'bad'); }
        refreshSetup();
    }
    $('step-docks-prepare').addEventListener('click', () => prepareDocks(false));
    $('step-docks-regen').addEventListener('click', () => { if (confirm('Make new dock addresses? The docks already in OBS stop working until you add the new ones.')) prepareDocks(true); });
    $('step-theme-install').addEventListener('click', async () => {
        try {
            const r = (await call('theme:install')).result;
            setMsg('step-theme-msg', `Copied${r.backups.length ? ` (older copies kept: ${r.backups.join(', ')})` : ''}. In OBS open Settings, Appearance, and pick the CertiFried Style.`, 'ok');
        } catch (err) { setMsg('step-theme-msg', err.message, 'bad'); }
        refreshSetup();
    });
    $('step-scenes-create').addEventListener('click', async () => {
        const names = [...document.querySelectorAll('[data-scene]')].filter((c) => c.checked).map((c) => c.dataset.scene);
        if (!names.length) { setMsg('step-scenes-msg', 'Tick the scenes to create.', 'bad'); return; }
        try { const r = (await call('scenes:create', { names })).result; setMsg('step-scenes-msg', r.created.length ? `Created: ${r.created.join(', ')}.` : 'Nothing to create.', 'ok'); } catch (err) { setMsg('step-scenes-msg', err.message, 'bad'); }
        refreshSetup();
    });

    // ── browser sign-in ──
    $('link-btn').addEventListener('click', async () => {
        $('link-btn').disabled = true;
        setMsg('link-msg', 'Opening your browser...');
        try { await call('link:start', { name: $('link-name').value }); setMsg('link-msg', ''); } catch (err) { setMsg('link-msg', err.message, 'bad'); }
        $('link-btn').disabled = false;
    });
    $('link-open').addEventListener('click', () => call('link:open').catch(() => {}));
    $('link-cancel').addEventListener('click', () => { call('link:cancel').catch(() => {}); setMsg('link-msg', ''); });

    // ── OBS: use the settings OBS already has ──
    async function importObs(msgId) {
        setMsg(msgId, 'Reading OBS settings...');
        try {
            const r = await call('obs:import');
            setMsg(msgId, `Found OBS on port ${r.port}. Connecting...`, 'ok');
        } catch (err) { setMsg(msgId, err.message, 'bad'); }
    }
    $('obs-import').addEventListener('click', () => importObs('obs-import-msg'));
    $('obs-import-status').addEventListener('click', () => importObs('obs-import-status-msg'));

    // ── pairing ──
    $('pair-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('pair-btn');
        btn.disabled = true;
        setMsg('pair-msg', 'Pairing...');
        try {
            await call('pair', { code: $('pair-code').value, name: $('pair-name').value });
            setMsg('pair-msg', 'Paired.', 'ok');
            $('pair-code').value = '';
        } catch (err) { setMsg('pair-msg', err.message, 'bad'); }
        btn.disabled = false;
    });
    function fillCode(code) {
        if (!code) return;
        showTab('status');
        $('pair-code').value = code;
        if (S && S.paired) { setMsg('pair-msg', ''); return; }
        setMsg('pair-msg', 'Code filled in from the dashboard link. Choose Pair.', 'ok');
        $('pair-name').focus();
    }

    // ── wiring ──
    api.on('state', (s) => { S = s; render(); });
    api.on('activity', (a) => {
        if (!S) return;
        S.activity.push(a);
        if (S.activity.length > 300) S.activity.shift();
        renderLog($('recent-log'), S.activity.slice(-6).reverse());
        renderActivity();
    });
    api.on('pair-code', fillCode);
    call('state:get').then((r) => { S = r.state; render(); fillCode(r.pendingCode); }).catch(() => {});
})();
