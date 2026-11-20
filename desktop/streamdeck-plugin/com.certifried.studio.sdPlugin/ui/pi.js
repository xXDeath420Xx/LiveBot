/*
 * Shared property inspector script for every CertiFried action page (no libraries).
 *
 * A page marks its fields:
 *   data-setting="name"         the action setting the field edits (select or input)
 *   data-list="scenes"          a select filled from Studio through the plugin (automations, scenes, sources, inputs,
 *                               counters, sounds, presets)
 *   data-needs="scene"          the list depends on another setting (sources of a scene)
 *   data-label-setting="x"      also save the chosen option's label in setting x (for display only)
 * and includes <div id="connection"></div>, which becomes the shared port/token section.
 *
 * Talks to Stream Deck with the documented UI socket messages: setSettings, getGlobalSettings, setGlobalSettings,
 * sendToPlugin (with action and context); receives didReceiveSettings, didReceiveGlobalSettings, sendToPropertyInspector.
 */
(function () {
    'use strict';
    let socket = null;
    let uuid = null;
    let action = null;
    let settings = {};
    let globals = {};
    const lists = {};

    const $ = (sel) => document.querySelector(sel);
    const fields = () => Array.from(document.querySelectorAll('[data-setting]'));
    const send = (msg) => { if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg)); };
    const toPlugin = (payload) => send({ event: 'sendToPlugin', action, context: uuid, payload });

    function el(tag, attrs, text) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (k === 'class') e.className = v; else if (k in e && typeof v !== 'string') e[k] = v; else e.setAttribute(k, v);
        }
        if (text != null) e.textContent = text;
        return e;
    }

    // ---- connection section -----------------------------------------------------------------------------------------
    function buildConnection() {
        const host = $('#connection');
        if (!host) return;
        const d = el('details');
        d.appendChild(el('summary', {}, 'Studio connection'));
        const status = el('div', { class: 'row' });
        status.appendChild(el('span', { class: 'label' }, 'Status'));
        const sv = el('span', { class: 'value status' });
        sv.appendChild(el('span', { class: 'dot', id: 'status-dot' }));
        sv.appendChild(el('span', { id: 'status-text' }, 'Checking'));
        status.appendChild(sv);
        d.appendChild(status);

        const portRow = el('div', { class: 'row' });
        portRow.appendChild(el('label', { for: 'cf-port' }, 'Port'));
        portRow.appendChild(el('input', { id: 'cf-port', type: 'number', min: '1', max: '65535', placeholder: '39720' }));
        d.appendChild(portRow);

        const tokenRow = el('div', { class: 'row' });
        tokenRow.appendChild(el('label', { for: 'cf-token' }, 'Pairing token'));
        tokenRow.appendChild(el('input', { id: 'cf-token', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'sdk_...' }));
        d.appendChild(tokenRow);
        d.appendChild(el('p', { class: 'hint', id: 'token-hint' }, 'In CertiFried Studio, open Settings, turn on the Stream Deck bridge and copy the pairing token.'));

        const btnRow = el('div', { class: 'row' });
        btnRow.appendChild(el('span', { class: 'label' }, ''));
        const btns = el('span', { class: 'value buttons' });
        const save = el('button', { type: 'button', id: 'cf-save' }, 'Save');
        const refresh = el('button', { type: 'button', id: 'cf-refresh' }, 'Refresh lists');
        btns.appendChild(save);
        btns.appendChild(refresh);
        btnRow.appendChild(btns);
        d.appendChild(btnRow);
        host.appendChild(d);

        save.addEventListener('click', () => {
            const port = Number($('#cf-port').value) || 39720;
            const typed = $('#cf-token').value.trim();
            globals = { port: Math.max(1, Math.min(65535, Math.round(port))), token: typed || globals.token || '' };
            send({ event: 'setGlobalSettings', context: uuid, payload: globals });
            $('#cf-token').value = '';
            showGlobals();
            setTimeout(requestLists, 1500);
        });
        refresh.addEventListener('click', () => requestLists());
    }

    function showGlobals() {
        const port = $('#cf-port');
        if (!port) return;
        port.value = globals.port || 39720;
        $('#cf-token').placeholder = globals.token ? 'Saved. Paste a new token to replace it.' : 'sdk_...';
    }

    function showStatus(p) {
        const t = $('#status-text');
        if (!t) return;
        t.textContent = p.text || (p.connected ? 'Connected.' : 'Not connected.');
        $('#status-dot').classList.toggle('on', !!p.connected);
        // Open the section by itself when there is something to fix.
        if (!p.connected && p.status !== 'connecting') { const d = $('#connection details'); if (d) d.open = true; }
    }

    // ---- fields -----------------------------------------------------------------------------------------------------
    function fillSelect(select, items, error) {
        const current = settings[select.dataset.setting] != null ? String(settings[select.dataset.setting]) : '';
        while (select.firstChild) select.removeChild(select.firstChild);
        const placeholder = el('option', { value: '' }, error ? 'Not available' : (select.dataset.placeholder || 'Choose one'));
        placeholder.disabled = true;
        select.appendChild(placeholder);
        let found = false;
        for (const it of items) {
            const o = el('option', { value: it.value }, it.label);
            if (it.value === current) { o.selected = true; found = true; }
            select.appendChild(o);
        }
        if (current && !found) {
            const label = select.dataset.labelSetting && settings[select.dataset.labelSetting] ? settings[select.dataset.labelSetting] : current;
            const o = el('option', { value: current }, `${label} (not found in Studio)`);
            o.selected = true;
            select.appendChild(o);
        }
        if (!current) placeholder.selected = true;
        const hint = document.getElementById(`${select.id}-hint`);
        if (hint) { hint.textContent = error || ''; hint.classList.toggle('warn', !!error); }
    }

    function requestList(select) {
        const kind = select.dataset.list;
        const needs = select.dataset.needs;
        const payload = { event: 'list', kind };
        if (needs) {
            payload[needs] = settings[needs] || '';
            if (!payload[needs]) { fillSelect(select, [], null); return; }
        }
        toPlugin(payload);
    }

    function requestLists() {
        for (const s of document.querySelectorAll('select[data-list]')) requestList(s);
        toPlugin({ event: 'status' });
    }

    function showSettings() {
        for (const f of fields()) {
            const v = settings[f.dataset.setting];
            if (f.tagName === 'SELECT' && f.dataset.list) { fillSelect(f, lists[f.dataset.list + (f.dataset.needs ? `:${settings[f.dataset.needs] || ''}` : '')] || [], null); continue; }
            if (v != null) f.value = String(v);
            else if (f.dataset.default != null) f.value = f.dataset.default;
        }
    }

    function onFieldChange(f) {
        const key = f.dataset.setting;
        let v = f.value;
        if (f.type === 'number') {
            const n = Number(v);
            const min = Number(f.min || -Infinity);
            const max = Number(f.max || Infinity);
            v = Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : Number(f.dataset.default || 1);
            f.value = String(v);
        }
        settings[key] = v;
        if (f.dataset.labelSetting && f.selectedOptions && f.selectedOptions[0]) settings[f.dataset.labelSetting] = f.selectedOptions[0].textContent;
        send({ event: 'setSettings', action, context: uuid, payload: settings });
        for (const dep of document.querySelectorAll(`select[data-needs="${key}"]`)) {
            settings[dep.dataset.setting] = '';
            requestList(dep);
        }
    }

    // ---- Stream Deck connection -------------------------------------------------------------------------------------
    window.connectElgatoStreamDeckSocket = function (port, inUuid, registerEvent, info, actionInfo) {
        uuid = inUuid;
        let ai = {};
        try { ai = JSON.parse(actionInfo) || {}; } catch { ai = {}; }
        action = ai.action;
        settings = (ai.payload && ai.payload.settings) || {};
        buildConnection();
        // Fill defaults for fields with one (and save them, so the key works without touching anything).
        let defaulted = false;
        for (const f of fields()) {
            if (settings[f.dataset.setting] == null && f.dataset.default != null) { settings[f.dataset.setting] = f.type === 'number' ? Number(f.dataset.default) : f.dataset.default; defaulted = true; }
            f.addEventListener('change', () => onFieldChange(f));
        }
        showSettings();

        socket = new WebSocket(`ws://127.0.0.1:${port}`);
        socket.addEventListener('open', () => {
            send({ event: registerEvent, uuid });
            send({ event: 'getGlobalSettings', context: uuid });
            if (defaulted) send({ event: 'setSettings', action, context: uuid, payload: settings });
            requestLists();
        });
        socket.addEventListener('message', (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.event === 'didReceiveGlobalSettings') { globals = (msg.payload && msg.payload.settings) || {}; showGlobals(); return; }
            if (msg.event === 'didReceiveSettings') { settings = (msg.payload && msg.payload.settings) || {}; showSettings(); return; }
            if (msg.event !== 'sendToPropertyInspector') return;
            const p = msg.payload || {};
            if (p.event === 'status') { showStatus(p); return; }
            if (p.event === 'list') {
                for (const s of document.querySelectorAll(`select[data-list="${p.kind}"]`)) {
                    if (s.dataset.needs && String(p[s.dataset.needs] || '') !== String(settings[s.dataset.needs] || '')) continue;
                    lists[p.kind + (s.dataset.needs ? `:${settings[s.dataset.needs] || ''}` : '')] = p.items || [];
                    fillSelect(s, p.items || [], p.error);
                }
            }
        });
    };
}());
