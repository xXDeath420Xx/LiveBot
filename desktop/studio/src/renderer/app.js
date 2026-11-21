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
        renderAlertAudio();
        renderPrograms();
        renderVod();
        renderLights();
        renderHeart(S.heart);
        renderAudio();
        renderStreamdeck();
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
        const off = v.enforced === false;
        $('vod-pill').textContent = off ? 'Song requests off' : v.vodSafe ? 'Protected' : 'Music paused';
        $('vod-pill').className = `pill ${off ? '' : v.vodSafe ? 'ok' : 'bad'}`;
        $('vod-reason').textContent = v.vodSafe ? '' : (v.reason || '');
        $('vod-reason').className = `msg${v.vodSafe || off ? '' : ' bad'}`;
        $('vod-remove').hidden = !(off && v.sourceExists);
        $('vod-track').textContent = v.vodTrack ? `Track ${v.vodTrack} (live audio on track ${v.liveTrack})` : '-';
        $('vod-source').textContent = v.sourceReady || v.sourceExists ? v.sourceName : '-';
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
    $('vod-remove').addEventListener('click', async () => {
        try { await call('vod:removeSource'); setMsg('vod-msg', 'The CertiFried Music source was removed from OBS.', 'ok'); } catch (err) { setMsg('vod-msg', err.message, 'bad'); }
    });

    // ── lights (Phase 5) ──
    const DRIVER_LABEL = { govee: 'Govee', hue: 'Philips Hue', lifx: 'LIFX', nanoleaf: 'Nanoleaf', elgato: 'Elgato', litra: 'Logitech Litra', goveeble: 'Govee (Bluetooth)' };
    const LIGHT_ERRORS = {
        no_lights: 'No lights yet.', device_offline: 'That light did not answer. Is it on and on the same network?', needs_pairing: 'Pair it first.',
        cert_changed: 'The Hue bridge presented a different certificate than when it was paired. Forget it and pair again.', not_supported: 'That light cannot do this.',
    };
    const lightError = (err) => LIGHT_ERRORS[String(err.message || '').split(':')[0]] || err.message;
    function renderLights() {
        const L = S.lights;
        if (!L) return;
        $('lights-pill').textContent = L.busy === 'finding' ? 'Looking' : L.busy === 'pairing' ? 'Pairing' : L.enabled ? `${L.devices.filter((d) => d.online).length} online` : 'Off';
        $('lights-pill').className = `pill ${L.enabled ? 'ok' : ''}`;
        $('lights-find').disabled = !!L.busy;
        $('lights-find').textContent = L.enabled ? 'Look again' : 'Find lights';
        $('lights-off').hidden = !L.enabled;
        $('lights-notes').replaceChildren(...(L.notes || []).map((n) => el('li', { text: n.message })));
        const rows = (L.devices || []).map((d) => {
            const state = d.needsPairing ? 'Needs pairing' : d.online ? 'Online' : 'Offline';
            const caps = [d.caps && d.caps.color ? 'colour' : null, d.caps && d.caps.white ? 'white' : null, d.caps && (d.caps.scenes || []).length ? `${d.caps.scenes.length} scenes` : null, d.caps && (d.caps.effects || []).length ? `${d.caps.effects.length} effects` : null].filter(Boolean).join(', ');
            const btns = [];
            if (d.needsPairing) btns.push(el('button', { class: 'btn small', text: 'Pair', onclick: async (e) => {
                const hint = d.driver === 'hue' ? 'Press the button on the Hue bridge now. Studio waits 30 seconds.' : d.driver === 'goveeble' ? `Connecting to ${d.name} over Bluetooth. Only add lights that are yours: Bluetooth also reaches lights next door.` : 'Hold the power button on the Nanoleaf for 5 to 7 seconds until the lights flash. Studio waits 30 seconds.';
                setMsg('lights-msg', hint);
                e.target.disabled = true;
                try { const r = await call('lights:pair', { id: d.id }); setMsg('lights-msg', r.result.message || (r.result.ok ? 'Paired.' : 'Not paired.'), r.result.ok ? 'ok' : 'bad'); } catch (err) { setMsg('lights-msg', lightError(err), 'bad'); }
                e.target.disabled = false;
            } }));
            else if (d.kind !== 'bridge') btns.push(el('button', { class: 'btn small', text: 'Test', onclick: async () => {
                try { await call('lights:test', { id: d.id }); setMsg('lights-msg', `${d.name}: flashed.`, 'ok'); } catch (err) { setMsg('lights-msg', `${d.name}: ${lightError(err)}`, 'bad'); }
            } }));
            btns.push(el('button', { class: 'btn small ghost', text: 'Forget', 'aria-label': `Forget ${d.name}`, onclick: async () => {
                try { await call('lights:forget', { id: d.id }); setMsg('lights-msg', `${d.name} forgotten.`, 'ok'); } catch (err) { setMsg('lights-msg', err.message, 'bad'); }
            } }));
            return el('tr', null,
                el('td', null, el('span', { text: d.name }), d.model ? el('span', { class: 'sub', text: d.model }) : null),
                el('td', null, el('span', { text: `${DRIVER_LABEL[d.driver] || d.driver}${d.kind === 'group' ? ' room' : d.kind === 'bridge' ? ' bridge' : ''}` }), caps ? el('span', { class: 'sub', text: caps }) : null),
                el('td', { text: state }),
                el('td', { class: 'light-actions' }, ...btns));
        });
        $('lights-table').tBodies[0].replaceChildren(...rows);
        $('lights-table').hidden = !rows.length;
        $('lights-empty').hidden = !!rows.length;
        const box = $('lights-drivers');
        if (!box.childElementCount) {
            for (const k of Object.keys(DRIVER_LABEL)) {
                const cb = el('input', { type: 'checkbox', id: `lights-driver-${k}` });
                cb.addEventListener('change', () => call('lights:drivers', { drivers: { [k]: cb.checked } }).catch(() => {}));
                box.append(el('label', { class: 'check' }, cb, ` ${DRIVER_LABEL[k]}`));
            }
        }
        for (const k of Object.keys(DRIVER_LABEL)) { const cb = $(`lights-driver-${k}`); if (cb && document.activeElement !== cb) cb.checked = (L.drivers || {})[k] !== false; }
    }
    // 0.2.10: cloud lights through the streamer's Govee / LIFX key, run by the server.
    let cloudLoaded = false;
    async function loadCloud() {
        cloudLoaded = true;
        try {
            const r = await call('lights:cloud');
            const rows = (r.lights || []).map((d) => el('tr', null,
                el('td', { text: d.name }), el('td', { text: d.providerLabel || d.provider }), el('td', { text: d.model || '' }),
                el('td', null, el('button', { class: 'btn small', type: 'button', text: 'Test', onclick: async (ev) => {
                    ev.target.disabled = true;
                    setMsg('cloud-msg', `${d.name}: asking the server to flash it...`);
                    try { const x = await call('lights:cloudTest', { id: d.id }); setMsg('cloud-msg', `${d.name}: ${x.message}`, 'ok'); } catch (err) { setMsg('cloud-msg', `${d.name}: ${err.message}`, 'bad'); }
                    ev.target.disabled = false;
                } }))));
            $('cloud-table').tBodies[0].replaceChildren(...rows);
            $('cloud-table').hidden = !rows.length;
            $('cloud-empty').hidden = !!rows.length;
            const bad = (r.accounts || []).filter((x) => x.status && x.status !== 'ok');
            setMsg('cloud-msg', bad.map((x) => `${x.label}: ${x.lastError || 'the key needs checking on the dashboard.'}`).join(' '), bad.length ? 'bad' : '');
        } catch (err) {
            $('cloud-table').hidden = true;
            $('cloud-empty').hidden = false;
            setMsg('cloud-msg', err.message, 'bad');
        }
    }
    $('cloud-refresh').addEventListener('click', () => loadCloud());
    document.querySelector('.nav-item[data-tab="lights"]').addEventListener('click', () => { if (!cloudLoaded) loadCloud(); });

    $('lights-find').addEventListener('click', async () => {
        setMsg('lights-msg', 'Looking for lights on your network and USB...');
        try { const r = await call('lights:find'); setMsg('lights-msg', `Found ${r.count} light${r.count === 1 ? '' : 's'}.`, 'ok'); } catch (err) { setMsg('lights-msg', err.message, 'bad'); }
    });
    $('lights-off').addEventListener('click', async () => { try { await call('lights:off'); setMsg('lights-msg', 'Studio no longer looks for lights. Light actions are refused until you choose Find lights again.', 'ok'); } catch (err) { setMsg('lights-msg', err.message, 'bad'); } });
    $('lights-add').addEventListener('submit', async (e) => {
        e.preventDefault();
        try { const r = await call('lights:add', { driver: $('lights-add-driver').value, address: $('lights-add-address').value }); setMsg('lights-add-msg', `Added ${r.count}.`, 'ok'); $('lights-add-address').value = ''; } catch (err) { setMsg('lights-add-msg', lightError(err), 'bad'); }
    });

    // ── heart rate (0.2.14) ──
    const HEART_STATE = {
        off: ['Off', ''], idle: ['No device', ''], connecting: ['Connecting', 'warn'], waiting: ['Waiting for a reading', 'warn'],
        connected: ['Connected', 'ok'], reconnecting: ['Reconnecting', 'warn'], error: ['Not working', 'bad'],
    };
    function ago(t) {
        if (!t) return '-';
        const s = Math.max(0, Math.round((Date.now() - t) / 1000));
        return s < 2 ? 'just now' : s < 90 ? `${s} seconds ago` : `${Math.round(s / 60)} minutes ago`;
    }
    function drawSpark(list) {
        const cv = $('heart-spark');
        const ctx = cv.getContext('2d');
        const w = cv.width, h = cv.height;
        ctx.clearRect(0, 0, w, h);
        const pts = (list || []).filter((x) => Number.isFinite(x));
        if (pts.length < 2) return;
        const lo = Math.min(...pts) - 4, hi = Math.max(...pts) + 4;
        const css = getComputedStyle(document.documentElement);
        ctx.strokeStyle = css.getPropertyValue('--cf-accent').trim() || '#b4e04f';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        pts.forEach((v, i) => {
            const x = (i / (120 - 1)) * (w - 8) + 4 + (w - 8) * (1 - (pts.length - 1) / (120 - 1));
            const y = h - 6 - ((v - lo) / Math.max(1, hi - lo)) * (h - 12);
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        ctx.stroke();
    }
    function renderHeart(H) {
        if (!H) return;
        const [label, tone] = HEART_STATE[H.state] || [H.state, ''];
        $('heart-pill').textContent = label; $('heart-pill').className = `pill ${tone}`;
        const fresh = H.lastAt && Date.now() - H.lastAt < 15000;
        $('heart-bpm').textContent = H.bpm != null ? String(H.bpm) : '--';
        $('heart-bpm').className = `hr-bpm${fresh ? '' : ' is-stale'}`;
        $('heart-device').textContent = H.device ? (H.device.name || `Device ${H.device.address.slice(-4)}`) : 'None chosen';
        $('heart-battery').textContent = H.battery != null ? `${H.battery}%` : '-';
        $('heart-last').textContent = ago(H.lastAt);
        $('heart-sent').textContent = !H.share ? 'Not sent (switched off)' : !S.paired ? 'Not paired' : H.sent ? `Sent ${ago(H.sent)}` : 'Nothing sent yet';
        if (document.activeElement !== $('heart-enabled')) $('heart-enabled').checked = !!H.enabled;
        if (document.activeElement !== $('heart-share')) $('heart-share').checked = !!H.share;
        $('heart-forget').hidden = !H.device;
        $('heart-scan').textContent = H.device ? 'Choose another device' : 'Find my watch';
        if ((H.state === 'error' || H.state === 'reconnecting') && H.error && !$('heart-msg').dataset.mine) setMsg('heart-msg', H.error, H.state === 'error' ? 'bad' : 'warn');
        else if (!$('heart-msg').dataset.mine && H.state === 'connected') setMsg('heart-msg', '');
        drawSpark(H.history);
    }
    function heartMsg(text, kind) {
        setMsg('heart-msg', text, kind);
        $('heart-msg').dataset.mine = text ? '1' : '';
        if (text) setTimeout(() => { $('heart-msg').dataset.mine = ''; }, 8000);
    }
    $('heart-scan').addEventListener('click', async () => {
        const btn = $('heart-scan');
        btn.disabled = true;
        heartMsg('Looking for heart-rate devices for 6 seconds. Make sure the app on your watch is broadcasting.');
        try {
            const r = await call('heart:scan', { all: $('heart-all').checked });
            const rows = (r.devices || []).map((d) => el('tr', null,
                el('td', null, el('span', { text: d.name || 'No name' }), el('span', { class: 'sub', text: d.hr ? 'Heart-rate sensor' : `Ends in ${d.address.slice(-4)}` })),
                el('td', { text: d.rssi != null ? `${d.rssi} dBm` : '-' }),
                el('td', null, el('button', { class: 'btn small', type: 'button', text: 'Use this one', onclick: async () => {
                    try { await call('heart:choose', { address: d.address, name: d.name }); heartMsg(`Connecting to ${d.name || 'the device'}...`, 'ok'); $('heart-table').hidden = true; } catch (err) { heartMsg(err.message, 'bad'); }
                } }))));
            $('heart-table').tBodies[0].replaceChildren(...rows);
            $('heart-table').hidden = !rows.length;
            heartMsg(rows.length ? `Found ${rows.length}. Choose Use this one next to your watch.` : 'Nothing found. Start broadcasting in the app on your watch, keep it near this PC, and try again.', rows.length ? 'ok' : 'warn');
        } catch (err) { heartMsg(err.message, 'bad'); }
        btn.disabled = false;
    });
    $('heart-forget').addEventListener('click', async () => { try { await call('heart:forget'); heartMsg('Forgotten. Studio no longer connects to it.', 'ok'); } catch (err) { heartMsg(err.message, 'bad'); } });
    $('heart-enabled').addEventListener('change', () => call('heart:settings', { enabled: $('heart-enabled').checked }).catch((err) => heartMsg(err.message, 'bad')));
    $('heart-share').addEventListener('change', () => call('heart:settings', { share: $('heart-share').checked }).catch((err) => heartMsg(err.message, 'bad')));

    // ── Voicemeeter (Phase 5) ──
    const VM_TYPE = { basic: 'Voicemeeter', banana: 'Voicemeeter Banana', potato: 'Voicemeeter Potato' };
    function renderAudio() {
        const V = S.voicemeeter;
        if (!V) return;
        const i = V.info;
        const on = !!V.settings.enabled;
        if (document.activeElement !== $('vm-enabled')) $('vm-enabled').checked = on;
        const label = !on ? 'Off' : !i ? 'Not checked' : !i.installed ? 'Not installed' : !i.running ? 'Not running' : (VM_TYPE[i.type] || 'Running');
        $('vm-pill').textContent = label;
        $('vm-pill').className = `pill ${on && i && i.running ? 'ok' : on && i && !i.running ? 'warn' : ''}`;
        $('vm-version').textContent = i && i.version ? i.version : '-';
        $('vm-strips').textContent = i && i.strips && i.strips.length ? i.strips.map((x) => x.label || `Strip ${x.index + 1}`).join(', ') : '-';
        $('vm-buses').textContent = i && i.buses && i.buses.length ? i.buses.map((x) => x.label || x.name || `Bus ${x.index + 1}`).join(', ') : '-';
        $('vm-profiles').textContent = i && i.profiles && i.profiles.length ? i.profiles.join(', ') : 'None saved yet';
        $('vm-macro').textContent = i ? (i.macroButtons ? 'Running' : 'Not running') : '-';
    }
    $('vm-enabled').addEventListener('change', async (e) => {
        try { await call('voicemeeter:settings', { enabled: e.target.checked }); setMsg('vm-msg', e.target.checked ? 'Voicemeeter control is on.' : 'Voicemeeter control is off.', 'ok'); } catch (err) { e.target.checked = !e.target.checked; setMsg('vm-msg', err.message, 'bad'); }
    });
    $('vm-detect').addEventListener('click', async () => { try { await call('voicemeeter:detect'); setMsg('vm-msg', 'Checked.', 'ok'); } catch (err) { setMsg('vm-msg', err.message, 'bad'); } });

    // ── Stream Deck (Phase 5) ──
    function renderStreamdeck() {
        const D = S.streamdeck;
        if (!D) return;
        const on = !!D.settings.enabled;
        if (document.activeElement !== $('sd-enabled')) $('sd-enabled').checked = on;
        if (document.activeElement !== $('sd-port')) $('sd-port').value = D.settings.port;
        $('sd-pill').textContent = !on ? 'Off' : D.error ? 'Not running' : D.clients ? `${D.clients} connected` : 'Waiting for the plugin';
        $('sd-pill').className = `pill ${on && !D.error ? (D.clients ? 'ok' : 'warn') : on ? 'bad' : ''}`;
        if (D.error) setMsg('sd-msg', D.error, 'bad');
        $('sd-install').disabled = !D.pluginBundled;
        for (const id of ['sd-show', 'sd-copy', 'sd-regen']) $(id).disabled = !on;
    }
    async function sdToken(regenerate) { const r = await call('streamdeck:token', { regenerate: !!regenerate }); return r.token; }
    $('sd-enabled').addEventListener('change', async (e) => {
        try { await call('streamdeck:settings', { enabled: e.target.checked }); setMsg('sd-msg', e.target.checked ? 'The plugin can connect now. Paste the token into one of its keys.' : 'The Stream Deck connection is off.', 'ok'); } catch (err) { e.target.checked = !e.target.checked; setMsg('sd-msg', err.message, 'bad'); }
    });
    $('sd-port').addEventListener('change', async (e) => { try { await call('streamdeck:settings', { port: Number(e.target.value) }); setMsg('sd-msg', 'Port saved. Set the same port in the plugin.', 'ok'); } catch (err) { setMsg('sd-msg', err.message, 'bad'); } });
    $('sd-show').addEventListener('click', async () => {
        const t = $('sd-token');
        if (t.type === 'text') { t.type = 'password'; t.value = ''; $('sd-show').textContent = 'Show token'; return; }
        try { t.value = await sdToken(false); t.type = 'text'; $('sd-show').textContent = 'Hide token'; } catch (err) { setMsg('sd-msg', err.message, 'bad'); }
    });
    $('sd-copy').addEventListener('click', async () => { try { await call('app:copy', { text: await sdToken(false) }); setMsg('sd-msg', 'Token copied.', 'ok'); } catch (err) { setMsg('sd-msg', err.message, 'bad'); } });
    $('sd-regen').addEventListener('click', async () => {
        try { const tok = await sdToken(true); if ($('sd-token').type === 'text') $('sd-token').value = tok; setMsg('sd-msg', 'New token made. Connected keys must get the new one.', 'ok'); } catch (err) { setMsg('sd-msg', err.message, 'bad'); }
    });
    $('sd-install').addEventListener('click', async () => { try { await call('streamdeck:install'); setMsg('sd-msg', 'The Stream Deck app is installing the plugin.', 'ok'); } catch (err) { setMsg('sd-msg', err.message, 'bad'); } });

    $('vod-check').addEventListener('click', async () => { try { await call('vod:check'); setMsg('vod-msg', 'Checked.', 'ok'); } catch (err) { setMsg('vod-msg', err.message, 'bad'); } });
    $('vod-kick').addEventListener('change', (e) => call('vod:kick', { choice: e.target.value }).catch(() => {}));
    $('vod-record').addEventListener('change', async (e) => {
        try { await call('vod:record', { on: e.target.checked }); setMsg('vod-msg', e.target.checked ? 'Recordings now use only the VOD track.' : 'Recording tracks put back as they were.', 'ok'); } catch (err) { e.target.checked = !e.target.checked; setMsg('vod-msg', err.message, 'bad'); }
    });

    // ── voice ──
    let micsLoaded = false;
    let micsTried = 0;
    async function loadMicrophones(force) {
        if (micsLoaded && !force) return;
        if (Date.now() - micsTried < 5000) return;
        micsTried = Date.now();
        try {
            const r = await call('voice:devices');
            const cur = S ? S.voice.settings.inputDeviceId : null;
            // 0.2.12: only real devices; Studio saves the device itself, never "default"
            const strip = (l) => String(l || '').replace(/^(Default|Communications)\s*-\s*/i, '').trim();
            const list = (r.devices || []).filter((d) => d.id !== 'default' && d.id !== 'communications').map((d) => ({ id: d.id, label: strip(d.label) }));
            if (cur && !list.some((d) => d.id === cur)) {
                list.push({ id: cur, label: cur === 'communications' ? 'Windows communications microphone' : cur === 'default' ? 'Picked when voice commands start' : `${(S && S.voice.settings.inputDeviceLabel) || 'Saved microphone'} (not plugged in)` });
            }
            $('voice-device').replaceChildren(...list.map((d) => el('option', { value: d.id, text: d.label })));
            if (cur) $('voice-device').value = cur;
            micsLoaded = list.length > 0;
        } catch (e) { /* audio window not ready */ }
    }
    const VOICE_LABEL = { off: 'Off', starting: 'Starting', listening: 'Listening', error: 'Not working' };
    const MB = (n) => `${Math.round(n / 1048576)} MB`;
    function engineLine(v) {
        const st = v.status || {};
        if (!v.settings.enabled) return '';
        if (v.engine === 'windows') return 'Using Windows speech recognition.';
        if (st.progress && st.state === 'starting') {
            const what = st.progress.what === 'cuda' ? 'the graphics card files' : 'the speech model';
            return `Downloading ${what}: ${MB(st.progress.got)} of ${MB(st.progress.total || 0)}. This happens once.`;
        }
        if (st.state === 'starting') return 'Starting Whisper.';
        if (st.device === 'cuda') return `Using your graphics card${st.gpuName ? ` (${st.gpuName})` : ''} with Whisper ${st.model || ''}.`;
        if (st.device === 'cpu' && st.gpuFailed) return `Using the processor with Whisper ${st.model || ''}, because the graphics card files could not be used (${st.gpuFailed.message}). Studio tries the graphics card again the next time voice commands start.`;
        if (st.device === 'cpu') return `Using the processor with Whisper ${st.model || ''}.`;
        return '';
    }
    function renderVoice() {
        const v = S.voice;
        if (!v) return;
        const whisper = v.engine !== 'windows';
        $('voice-unavailable').hidden = v.available;
        $('voice-enabled').checked = !!v.settings.enabled;
        $('voice-enabled').disabled = !v.available;
        let label = VOICE_LABEL[v.status.state] || 'Off';
        if (v.settings.enabled && v.status.state === 'listening' && v.settings.mode === 'ptt') label = v.held ? 'Listening (key held)' : 'Waiting for the key';
        if (v.settings.enabled && v.status.state === 'listening' && v.settings.mode === 'wake' && whisper) label = v.status.wakeOpen ? 'Listening for a command' : 'Waiting for the wake phrase';
        $('voice-pill').textContent = label;
        $('voice-pill').className = `pill ${v.status.state === 'listening' ? 'ok' : v.status.state === 'error' || v.mic === 'error' ? 'bad' : v.status.state === 'starting' ? 'warn' : ''}`;
        $('voice-engine-line').textContent = engineLine(v);
        $('voice-error').textContent = v.micError || (v.status.state === 'error' ? v.status.error : '') || '';
        // Whisper stood down for Windows speech recognition this session
        $('voice-fallback').hidden = !v.fallback;
        $('voice-fallback-text').textContent = v.fallback ? `Whisper could not start, so Studio is using Windows speech recognition for now. It reacts to clicks and game sounds more easily. The reason: ${v.fallback.reason}` : '';
        // the input looks like a mix or virtual bus
        const inp = v.input || {};
        $('voice-input-warn').hidden = !(v.settings.enabled && inp.bus);
        $('voice-input-warn-text').textContent = inp.bus ? `"${inp.label}" looks like a mix or a virtual input, not a microphone. It can carry game sound and music, which sets commands off when nobody said them.${inp.suggestion ? '' : ' Pick your microphone below.'}` : '';
        $('voice-input-fix').hidden = !inp.suggestion;
        $('voice-input-fix').textContent = inp.suggestion ? `Use ${inp.suggestion.label}` : '';
        const last = v.status.lastHeard;
        $('voice-last').textContent = !last ? '' : last.outcome === 'noise' || last.outcome === 'nowake' ? 'Last heard: something that is not one of your commands.'
            : last.outcome === 'wake' ? 'Last heard: the wake phrase. Say a command.'
                : `Last heard: "${last.text || last.phrase}", ${Math.round((last.confidence || 0) * 100)}% sure${last.accepted ? '' : ` (not run: ${(OUTCOME_TEXT[last.outcome] || 'not counted').toLowerCase()})`}`;
        if (document.activeElement !== $('voice-mode')) $('voice-mode').value = v.settings.mode;
        if (document.activeElement !== $('voice-engine')) $('voice-engine').value = v.settings.engine || 'auto';
        $('voice-ptt-wrap').hidden = v.settings.mode !== 'ptt';
        $('voice-wake-wrap').hidden = v.settings.mode !== 'wake';
        if (document.activeElement !== $('voice-wake')) $('voice-wake').value = v.settings.wakePhrase || 'hey studio';
        $('voice-mode-help').textContent = v.settings.mode === 'wake' ? (whisper ? `Say "${v.settings.wakePhrase || 'hey studio'}" and then the command, in one go or within a few seconds.` : 'The wake phrase needs Whisper. Windows speech recognition listens all the time.')
            : v.settings.mode === 'ptt' ? 'Hold the key while you speak. A quick press (for example a Stream Deck Hotkey button set to the same key) listens for the next phrase instead.' : '';
        if (document.activeElement !== $('voice-ptt')) $('voice-ptt').value = v.settings.pttKey || '';
        $('voice-match-wrap').hidden = !whisper;
        $('voice-match-help').hidden = !whisper;
        $('voice-threshold-wrap').hidden = whisper;
        $('voice-windows-note').hidden = whisper;
        if (document.activeElement !== $('voice-match')) $('voice-match').value = Math.round((v.settings.matchThreshold || 0.8) * 100);
        $('voice-match-out').textContent = `${$('voice-match').value}%`;
        if (document.activeElement !== $('voice-threshold')) $('voice-threshold').value = Math.round((v.settings.threshold || 0.7) * 100);
        $('voice-threshold-out').textContent = `${$('voice-threshold').value}%`;
        if (!micsLoaded || (v.settings.inputDeviceId && ![...$('voice-device').options].some((o) => o.value === v.settings.inputDeviceId))) loadMicrophones(true);
        else if (document.activeElement !== $('voice-device') && v.settings.inputDeviceId) $('voice-device').value = v.settings.inputDeviceId;
        $('voice-phrases').replaceChildren(...v.phrases.map((p) => el('li', { text: p })));
        const cmds = v.commands || v.phrases.map((text) => ({ text }));
        const globalSure = whisper ? (v.settings.matchThreshold || 0.8) : (v.settings.threshold || 0.7);
        const training = v.training;
        $('voice-commands').tBodies[0].replaceChildren(...cmds.map((c) => el('tr', null,
            el('td', { text: c.text }), el('td', { text: c.automationName || '' }),
            el('td', { text: c.confidence != null ? `${Math.round(c.confidence * 100)}% (its own)` : `${Math.round(globalSure * 100)}%` }),
            el('td', { text: c.cooldownMs != null ? seconds(c.cooldownMs) : '10 s' }),
            el('td', { text: c.aliases && c.aliases.length ? `${c.aliases.length} way${c.aliases.length === 1 ? '' : 's'}${c.trained && c.trained.takes ? ', taught' : ''}` : '', title: (c.aliases || []).join(', ') || null }),
            el('td', { class: 'right' }, whisper && c.automationId ? el('button', { class: 'btn small', type: 'button', text: 'Teach Studio how you say it', disabled: !!(training && training.key === c.key && training.state !== 'off'),
                onclick: () => startTraining(c) }) : null))));
        renderTraining(training);
        $('voice-commands').hidden = !cmds.length;
        $('voice-empty').hidden = cmds.length > 0;
        if (document.activeElement !== $('voice-logall')) $('voice-logall').checked = !!v.settings.logAllSpeech;
        if (document.activeElement !== $('voice-share')) $('voice-share').checked = !!v.settings.shareSpeechText;
        $('voice-share').disabled = !v.settings.logAllSpeech;
        $('voice-privacy').querySelector('summary').textContent = `Log all speech (${v.settings.logAllSpeech ? 'on' : 'off'})`;
        voiceLog = (v.log || []).slice(0, 200);
        renderVoiceLog();
        setMeter(v.settings.enabled ? v.level : 0);
    }
    // ── 0.2.13: Teach Studio how you say it ──
    const pctText = (n) => (n == null ? '' : `${Math.round(n * 100)}%`);
    async function startTraining(c) {
        try {
            const takes = Number($('voice-train-takes').value) || (S.voice.settings.trainTakes || 8);
            await call('voice:train', { action: 'start', key: c.key, takes });
            setMsg('voice-train-note', '', '');
            $('voice-train').scrollIntoView({ block: 'nearest' });
        } catch (err) { setMsg('voice-msg', err.message, 'bad'); }
    }
    function renderTraining(t) {
        const box = $('voice-train');
        const keep = !!(S.voice.settings.keepRecordings);
        if (document.activeElement !== $('voice-train-keep')) $('voice-train-keep').checked = keep;
        if (document.activeElement !== $('voice-train-takes')) $('voice-train-takes').value = S.voice.settings.trainTakes || 8;
        box.hidden = !t;
        if (!t) return;
        $('voice-train-title').textContent = `Teach Studio how you say it: "${t.phrase}"`;
        $('voice-train-pill').textContent = t.state === 'listening' ? `Listening, ${t.good} of ${t.want}` : t.state === 'saving' ? 'Saving' : `${t.good} take${t.good === 1 ? '' : 's'}`;
        $('voice-train-pill').className = `pill ${t.state === 'listening' ? 'ok' : ''}`;
        $('voice-train-help').textContent = t.state === 'listening'
            ? `Say "${t.phrase}" the way you normally say it, with a short pause after each take. ${t.want - t.good} to go. Nothing runs while Studio is learning.`
            : 'Check the takes. Delete any where you said something else or were interrupted, then save. Studio adds each take to how you say this command and sets how sure it needs to be.';
        $('voice-train-setup').hidden = t.state === 'listening' || t.state === 'saving';
        if (t.note) setMsg('voice-train-note', t.note, 'warn');
        const rows = t.takes.map((k, i) => el('tr', null,
            el('td', { class: 'num', text: String(i + 1) }),
            el('td', { class: k.ok ? '' : 'quiet', text: k.ok ? `"${k.text}"${k.kept ? ' (recording kept)' : ''}` : (k.reason || 'No words heard') }),
            el('td', { class: 'num', text: k.ok ? pctText(k.phraseScore) : '' }),
            el('td', { class: 'num', text: k.ok && t.good > 1 ? pctText(k.score) : '' }),
            el('td', { class: 'right' }, el('button', { class: 'btn small ghost', type: 'button', text: 'Delete', disabled: t.state === 'saving',
                onclick: () => call('voice:train', { action: 'delete', id: k.id }).catch((err) => setMsg('voice-train-note', err.message, 'bad')) }))));
        $('voice-train-takes-list').tBodies[0].replaceChildren(...rows);
        $('voice-train-takes-list').hidden = !rows.length;
        const cal = t.calibration;
        $('voice-train-result').textContent = !cal || !cal.enough ? (t.good ? 'Record at least two good takes.' : '')
            : `Lowest take: ${pctText(cal.lowest)}. Studio will run this command at ${pctText(cal.threshold)} and above${cal.raised ? ', a little higher than the takes alone need, so that things you said that were not this command stay below it' : ''}.`;
        const ov = cal && cal.enough ? cal.overlaps || [] : [];
        $('voice-train-overlap').hidden = !ov.length;
        $('voice-train-overlap-text').textContent = ov.length ? `Some things you said that were not this command score ${pctText(ov[0].score)} or more against it, as high as your takes: ${ov.slice(0, 3).map((o) => `"${o.text}" (${pctText(o.score)})`).join(', ')}. Saving now could make it run when you say them. Delete the takes that sound like them, or record more, or mark those lines in the log below if they really were this command.` : '';
        $('voice-train-stop').hidden = t.state !== 'listening';
        $('voice-train-more').hidden = t.state !== 'review';
        $('voice-train-save').hidden = t.state === 'listening';
        $('voice-train-save').disabled = t.state === 'saving' || !(cal && cal.enough);
        $('voice-train-cancel').disabled = t.state === 'saving';
    }
    $('voice-train-stop').addEventListener('click', () => call('voice:train', { action: 'stop' }).catch((err) => setMsg('voice-train-note', err.message, 'bad')));
    $('voice-train-more').addEventListener('click', () => call('voice:train', { action: 'resume' }).catch((err) => setMsg('voice-train-note', err.message, 'bad')));
    $('voice-train-cancel').addEventListener('click', () => call('voice:train', { action: 'cancel' }).then(() => setMsg('voice-msg', 'Nothing was saved.', '')).catch((err) => setMsg('voice-train-note', err.message, 'bad')));
    $('voice-train-save').addEventListener('click', async () => {
        try {
            const r = await call('voice:train', { action: 'save' });
            const s = r.saved || {};
            setMsg('voice-msg', `Saved ${s.aliases} way${s.aliases === 1 ? '' : 's'} you say it${s.threshold != null ? `, and it now runs at ${pctText(s.threshold)} and above` : ''}. The dashboard shows them under Heard as.`, 'ok');
        } catch (err) { setMsg('voice-train-note', err.message, 'bad'); }
    });
    $('voice-train-keep').addEventListener('change', (e) => call('voice:settings', { keepRecordings: e.target.checked }).catch((err) => setMsg('voice-train-note', err.message, 'bad')));
    $('voice-train-takes').addEventListener('change', (e) => call('voice:settings', { trainTakes: Number(e.target.value) }).catch(() => {}));

    // ── 0.2.13: teaching from the voice log ──
    const NEAR_MISS = 0.4;
    async function learn(e, action, automationId) {
        try {
            const r = await call('voice:learn', { id: e.id, action, automationId });
            const l = r.learned;
            setMsg('voice-msg', !l ? 'Undone.' : l.kind === 'alias' ? `Learned: "${l.text}" is how you say "${l.phrase}".` : l.kind === 'negative' ? `Learned: "${l.text}" is not "${l.phrase}".` : `Undone: "${l.phrase}" will not run for these words again.`, 'ok');
        } catch (err) { setMsg('voice-msg', err.message, 'bad'); }
    }
    function teachCell(e) {
        const td = el('td', { class: 'teach' });
        if (!S || !S.voice.canLearn || !['fired', 'cooldown', 'below', 'noise', 'nowake'].includes(e.outcome)) return td;
        if (e.learned) {
            const l = e.learned;
            td.append(el('span', { class: 'quiet', text: l.kind === 'alias' ? `Learned as "${l.phrase}". ` : l.kind === 'negative' ? `Marked not "${l.phrase}". ` : 'Undone. ' }),
                el('button', { class: 'btn small ghost', type: 'button', text: 'Undo', onclick: () => learn(e, 'undo') }));
            return td;
        }
        if (!e.heard) return td;
        const ran = e.outcome === 'fired' || e.outcome === 'cooldown';
        if (ran) { td.append(el('button', { class: 'btn small', type: 'button', text: 'Wrong, undo learning', onclick: () => learn(e, 'wrong') })); return td; }
        const closestId = e.closestAutomationId || e.automationId;
        const closest = e.closest || e.phrase;
        if (closest && closestId && (e.confidence || 0) >= NEAR_MISS) td.append(el('button', { class: 'btn small', type: 'button', text: `This was "${closest}"`, onclick: () => learn(e, 'alias', closestId) }), ' ');
        const cmds = (S.voice.commands || []).filter((c) => c.automationId);
        if (cmds.length) {
            const pick = el('select', { class: 'small', 'aria-label': 'This was a command' }, el('option', { value: '', text: 'This was...' }),
                ...cmds.filter((c, i) => cmds.findIndex((x) => x.automationId === c.automationId) === i).map((c) => el('option', { value: String(c.automationId), text: c.automationName && c.automationName !== c.text ? `${c.text} (${c.automationName})` : c.text })));
            pick.addEventListener('change', () => { if (pick.value) learn(e, 'alias', Number(pick.value)); });
            td.append(pick, ' ');
        }
        if (closestId) td.append(el('button', { class: 'btn small ghost', type: 'button', text: 'Not a command', onclick: () => learn(e, 'negative') }));
        return td;
    }

    function seconds(ms) { const n = Math.round(ms / 1000); return n === 0 ? 'none' : n < 120 ? `${n} s` : `${Math.round(n / 60)} min`; }
    let voiceLog = [];
    const OUTCOME_TEXT = { fired: 'Ran', below: 'Not sure enough', cooldown: 'Waiting (ran recently)', noise: 'Not a command', disabled: 'Automation is off',
        short: 'Ignored: not speech', nowake: 'No wake phrase', wake: 'Wake phrase heard' };
    const secs = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
    function vadText(e) {
        if (!e.vad) return '';
        if (e.outcome === 'short') return `${e.vad.reason === 'unclear' ? 'Not clearly a voice' : `Too short for speech (${secs(e.vad.speechMs || 0)})`}${e.count > 1 ? `, ${e.count} times` : ''}`;
        return `Speech, ${secs(e.vad.speechMs || 0)}`;
    }
    function outcomeText(e) {
        const base = OUTCOME_TEXT[e.outcome] || e.outcome;
        return e.outcome === 'fired' && Number.isFinite(e.latencyMs) ? `${base}, ${secs(e.latencyMs)} after you stopped` : base;
    }
    function renderVoiceLog() {
        $('voice-log').tBodies[0].replaceChildren(...voiceLog.map((e) => el('tr', null,
            el('td', { class: 'num', text: time(e.lastT || e.t) }),
            el('td', { class: e.outcome === 'short' ? 'quiet' : '', text: vadText(e) }),
            el('td', { class: e.heard ? '' : 'quiet', text: e.heard ? `"${e.heard}"` : (e.outcome === 'noise' || e.outcome === 'nowake' || e.outcome === 'below' ? 'Words not kept' : '') }),
            el('td', { class: e.phrase ? '' : 'quiet', text: (e.phrase || e.closest || '') + (e.via === 'alias' && e.phrase ? ' (how you say it)' : '') }),
            el('td', { class: 'num', text: e.confidence == null ? '' : `${Math.round((e.confidence || 0) * 100)}%${e.threshold != null ? ` of ${Math.round(e.threshold * 100)}%` : ''}` }),
            el('td', { class: `out-${e.outcome}`, text: outcomeText(e) }),
            teachCell(e))));
        $('voice-log').hidden = !voiceLog.length;
        $('voice-log-empty').hidden = voiceLog.length > 0;
    }
    // a repeated line (clicks counted on one line) comes again with the same id: replace it
    api.on('voice-log', (e) => { const i = voiceLog.findIndex((x) => x.id === e.id); if (i >= 0) voiceLog[i] = e; else { voiceLog.unshift(e); if (voiceLog.length > 200) voiceLog.length = 200; } renderVoiceLog(); });
    $('voice-log-clear').addEventListener('click', async () => { try { await call('voice:clearLog'); voiceLog = []; renderVoiceLog(); } catch (err) { setMsg('voice-msg', err.message, 'bad'); } });
    $('voice-logall').addEventListener('change', (e) => call('voice:settings', { logAllSpeech: e.target.checked }).catch((err) => setMsg('voice-msg', err.message, 'bad')));
    $('voice-share').addEventListener('change', (e) => call('voice:settings', { shareSpeechText: e.target.checked }).catch((err) => setMsg('voice-msg', err.message, 'bad')));
    function setMeter(level) { $('voice-meter').style.width = `${Math.min(100, Math.round(Math.sqrt(level) * 140))}%`; }
    api.on('voice-level', (x) => { if (S && S.voice.settings.enabled) setMeter(x.level); });
    $('voice-enabled').addEventListener('change', (e) => call('voice:settings', { enabled: e.target.checked }).catch((err) => setMsg('voice-msg', err.message, 'bad')));
    $('voice-device').addEventListener('change', (e) => call('voice:settings', { inputDeviceId: e.target.value }).catch(() => {}));
    $('voice-mode').addEventListener('change', (e) => call('voice:settings', { mode: e.target.value }).catch(() => {}));
    $('voice-engine').addEventListener('change', (e) => call('voice:settings', { engine: e.target.value }).then(() => setMsg('voice-msg', e.target.value === 'windows' ? 'Using Windows speech recognition.' : 'Starting Whisper.', 'ok')).catch((err) => setMsg('voice-msg', err.message, 'bad')));
    $('voice-wake').addEventListener('change', (e) => call('voice:settings', { wakePhrase: e.target.value }).then(() => setMsg('voice-msg', `Say "${e.target.value.trim()}", then the command.`, 'ok')).catch((err) => setMsg('voice-msg', err.message, 'bad')));
    $('voice-match').addEventListener('input', (e) => { $('voice-match-out').textContent = `${e.target.value}%`; });
    $('voice-match').addEventListener('change', (e) => call('voice:settings', { matchThreshold: Number(e.target.value) / 100 }).catch(() => {}));
    $('voice-threshold').addEventListener('input', (e) => { $('voice-threshold-out').textContent = `${e.target.value}%`; });
    $('voice-threshold').addEventListener('change', (e) => call('voice:settings', { threshold: Number(e.target.value) / 100 }).catch(() => {}));
    $('voice-input-fix').addEventListener('click', async () => { try { const r = await call('voice:useMic'); micsLoaded = false; setMsg('voice-msg', `Voice commands now use ${r.label}.`, 'ok'); } catch (err) { setMsg('voice-msg', err.message, 'bad'); } });
    $('voice-retry').addEventListener('click', async () => { try { await call('voice:retryWhisper'); setMsg('voice-msg', 'Starting Whisper.', 'ok'); } catch (err) { setMsg('voice-msg', err.message, 'bad'); } });
    $('voice-ptt').addEventListener('keydown', (e) => {
        if (e.key === 'Tab') return;
        e.preventDefault();
        const key = keyFromEvent(e);
        if (!key) return;
        const name = /^num\d$/.test(key) ? `Num${key.slice(3)}` : key;
        $('voice-ptt').value = name;
        call('voice:settings', { pttKey: name }).then(() => setMsg('voice-msg', `Hold ${name} to talk.`, 'ok')).catch((err) => setMsg('voice-msg', err.message, 'bad'));
    });
    function renderPrograms() {
        const list = S.programs || [];
        $('programs-table').tBodies[0].replaceChildren(...list.map((p) => el('tr', null,
            el('td', { text: p.name }), el('td', { text: p.path }), el('td', { text: (p.args || []).join(' ') }),
            el('td', null, el('button', { class: 'btn small ghost', type: 'button', text: 'Remove', 'aria-label': `Remove ${p.name}`, onclick: async () => {
                try { await call('programs:remove', { id: p.id }); setMsg('programs-msg', `${p.name} removed.`, 'ok'); } catch (err) { setMsg('programs-msg', err.message, 'bad'); }
            } })))));
        $('programs-table').hidden = !list.length;
        $('programs-empty').hidden = !!list.length;
    }
    $('programs-pick').addEventListener('click', async () => {
        try { const r = await call('programs:pick'); if (r.path) $('programs-path').value = r.path; } catch (err) { setMsg('programs-msg', err.message, 'bad'); }
    });
    $('programs-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const r = await call('programs:save', { program: { name: $('programs-name').value, path: $('programs-path').value, args: $('programs-args').value } });
            setMsg('programs-msg', `${r.program.name} added. Automations can now start it by that name.`, 'ok');
            $('programs-name').value = ''; $('programs-path').value = ''; $('programs-args').value = '';
        } catch (err) { setMsg('programs-msg', err.message, 'bad'); }
    });
    function renderAlertAudio() {
        const A = S.alertAudio;
        if (!A) return;
        $('alert-audio-pill').textContent = A.managed ? 'Managed' : 'Not managed';
        $('alert-audio-pill').className = `pill ${A.managed ? 'ok' : ''}`;
        $('alert-audio-undo').hidden = !A.managed;
        $('alert-audio-apply').textContent = A.managed ? 'Check them again' : 'Let CertiFried manage Sound Alerts and Blerp audio';
        if (A.managed && !$('alert-audio-msg').textContent) setMsg('alert-audio-msg', `Managed: ${A.sources.join(', ')}.`);
    }
    $('alert-audio-apply').addEventListener('click', async () => {
        setMsg('alert-audio-msg', 'Looking for Sound Alerts and Blerp sources in OBS...');
        try {
            const r = await call('alertAudio:apply');
            setMsg('alert-audio-msg', `Done: ${r.applied.join(', ') || 'none'} now play through OBS, off the VOD track (track ${r.vodTrack}).${r.skipped.length ? ` Not changed: ${r.skipped.map((x) => `${x.name} (${x.reason})`).join(', ')}.` : ''}`, r.skipped.length ? 'bad' : 'ok');
        } catch (err) { setMsg('alert-audio-msg', err.message, 'bad'); }
    });
    $('alert-audio-undo').addEventListener('click', async () => {
        try {
            const r = await call('alertAudio:undo');
            setMsg('alert-audio-msg', `Put back: ${r.restored.join(', ') || 'none'}.${r.missing.length ? ` No longer in OBS: ${r.missing.join(', ')}.` : ''}`, 'ok');
        } catch (err) { setMsg('alert-audio-msg', err.message, 'bad'); }
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
    api.on('heart', (h) => { if (!S) return; S.heart = h; renderHeart(h); });
    call('state:get').then((r) => { S = r.state; render(); fillCode(r.pendingCode); }).catch(() => {});
})();
