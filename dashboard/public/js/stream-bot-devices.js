/*
 * Devices page, Phase 5 (dashboard/views/stream-bot/_hardware.ejs): light tests, "Ask Studio to look again", Govee and LIFX
 * cloud keys, light presets. Talks to /stream/bot/api/devices/*, /stream/bot/api/lights/* (dashboard/routes/stream-bot-devices.js).
 * The DOM is built with createElement and textContent only (light names come from devices and services).
 * /js/csrf.js adds the CSRF header to every state-changing fetch.
 */
(function () {
    'use strict';
    var root = document.getElementById('lights');
    if (!root) return;

    function el(tag, props, children) {
        var n = document.createElement(tag);
        props = props || {};
        if (props.className) n.className = props.className;
        if (props.text != null) n.textContent = String(props.text);
        if (props.attrs) Object.keys(props.attrs).forEach(function (k) { if (props.attrs[k] != null && props.attrs[k] !== false) n.setAttribute(k, props.attrs[k] === true ? '' : String(props.attrs[k])); });
        (children || []).forEach(function (c) { if (c) n.appendChild(c); });
        return n;
    }
    function call(method, url, body) {
        var headers = { Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        return fetch(url, { method: method, credentials: 'same-origin', headers: headers, body: body === undefined ? undefined : JSON.stringify(body) })
            .then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok && data && data.ok !== false, status: res.status, data: data || {} }; });
            })
            .catch(function () { return { ok: false, status: 0, data: { error: 'Could not reach CertiFried. Check your connection and try again.' } }; });
    }
    function errorText(r, fallback) {
        if (r.status === 401) return 'You are signed out. Sign in again and retry.';
        return (r.data && r.data.error) || fallback;
    }
    var statusNode = document.getElementById('sb-hw-status');
    function say(node, text, tone) {
        if (!node) return;
        node.textContent = text || '';
        node.className = 'cf-status-line' + (tone ? ' is-' + tone : '');
    }
    function busy(btn, on) { if (btn) { btn.disabled = !!on; btn.setAttribute('aria-busy', on ? 'true' : 'false'); } }
    function reloadSoon() { setTimeout(function () { window.location.reload(); }, 700); }

    // ── tests and checks ──
    document.addEventListener('click', function (e) {
        var t = e.target.closest('[data-light-test]');
        if (t) {
            busy(t, true);
            say(statusNode, 'Testing ' + (t.getAttribute('data-name') || 'the light') + '...');
            call('POST', '/stream/bot/api/lights/test', { device: t.getAttribute('data-light-test') }).then(function (r) {
                busy(t, false);
                say(statusNode, r.ok ? (t.getAttribute('data-name') || 'The light') + ': ' + (r.data.message || 'done') : errorText(r, 'The test did not work.'), r.ok ? 'ok' : 'bad');
            });
            return;
        }
        var c = e.target.closest('[data-hw-check]');
        if (c) {
            busy(c, true);
            say(statusNode, 'Asking CertiFried Studio...');
            call('POST', '/stream/bot/api/devices/check').then(function (r) {
                busy(c, false);
                if (!r.ok) { say(statusNode, errorText(r, 'Studio did not answer.'), 'bad'); return; }
                var n = r.data.result && r.data.result.lights != null ? r.data.result.lights : null;
                say(statusNode, n == null ? 'Studio looked again.' : 'Studio found ' + n + ' light' + (n === 1 ? '' : 's') + '.', 'ok');
                reloadSoon();
            });
            return;
        }
        var rf = e.target.closest('[data-cloud-refresh]');
        if (rf) {
            busy(rf, true);
            call('POST', '/stream/bot/api/lights/cloud/' + rf.getAttribute('data-cloud-refresh') + '/refresh').then(function (r) {
                busy(rf, false);
                say(statusNode, r.ok ? 'Found ' + r.data.devices + ' light' + (r.data.devices === 1 ? '' : 's') + '.' : errorText(r, 'The service did not answer.'), r.ok ? 'ok' : 'bad');
                if (r.ok) reloadSoon();
            });
            return;
        }
        var ed = e.target.closest('[data-cloud-edit]');
        if (ed) {
            var f = root.querySelector('[data-cloud-form="' + ed.getAttribute('data-cloud-edit') + '"]');
            if (f) { f.hidden = false; f.querySelector('input').focus(); }
            return;
        }
        var rm = e.target.closest('[data-cloud-remove]');
        if (rm) {
            if (!window.confirm('Remove your ' + rm.getAttribute('data-name') + ' key? Automations using those lights stop changing them.')) return;
            busy(rm, true);
            call('DELETE', '/stream/bot/api/lights/cloud/' + rm.getAttribute('data-cloud-remove')).then(function (r) {
                busy(rm, false);
                say(statusNode, r.ok ? 'Removed.' : errorText(r, 'Could not remove it.'), r.ok ? 'ok' : 'bad');
                if (r.ok) reloadSoon();
            });
        }
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-cloud-form]'), function (form) {
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var input = form.querySelector('input');
            var btn = form.querySelector('button[type="submit"]');
            var key = input.value.trim();
            if (!key) { input.focus(); return; }
            busy(btn, true);
            say(statusNode, 'Checking the key...');
            call('POST', '/stream/bot/api/lights/cloud', { provider: form.getAttribute('data-cloud-form'), key: key }).then(function (r) {
                busy(btn, false);
                input.value = '';
                if (r.ok) { say(statusNode, 'Saved. Found ' + r.data.devices + ' light' + (r.data.devices === 1 ? '' : 's') + '.', 'ok'); reloadSoon(); return; }
                say(statusNode, errorText(r, 'The key could not be checked.'), 'bad');
                if (r.data && r.data.saved) reloadSoon();
            });
        });
    });

    // ── presets ──
    var form = document.getElementById('sb-preset-form');
    var rowsBox = document.getElementById('sb-preset-rows');
    var presetStatus = document.getElementById('sb-preset-status');
    var nameInput = document.getElementById('sb-preset-name');
    var choices = null;
    var editing = null;
    var presetData = {};
    try { presetData = JSON.parse((document.getElementById('sb-presets-data') || {}).textContent || '{}'); } catch (e) { presetData = {}; }

    function loadChoices() {
        if (choices) return Promise.resolve(choices);
        return call('GET', '/stream/bot/api/devices/choices').then(function (r) { choices = r.ok ? r.data : { lights: [] }; return choices; });
    }
    function lightSelect(value) {
        var s = el('select');
        s.appendChild(el('option', { text: 'Pick a light', attrs: { value: '' } }));
        (choices.lights || []).filter(function (l) { return l.kind !== 'bridge'; }).forEach(function (l) {
            s.appendChild(el('option', { text: l.label, attrs: { value: l.value } }));
        });
        if (value && !(choices.lights || []).some(function (l) { return l.value === value; })) s.appendChild(el('option', { text: 'A light that is not reported right now', attrs: { value: value } }));
        s.value = value || '';
        return s;
    }
    var rowSeq = 0;
    function addRow(l) {
        l = l || { power: 'on', color: '#b4e04f', brightness: 100 };
        rowSeq += 1;
        var id = 'sb-pr-' + rowSeq;
        var dev = lightSelect(l.device);
        dev.id = id + '-d';
        var mode = el('select', { attrs: { id: id + '-m' } });
        [['color', 'Colour'], ['white', 'White'], ['scene', 'Scene'], ['off', 'Off']].forEach(function (o) { mode.appendChild(el('option', { text: o[1], attrs: { value: o[0] } })); });
        mode.value = l.power === 'off' ? 'off' : l.scene ? 'scene' : l.kelvin ? 'white' : 'color';
        var color = el('input', { attrs: { type: 'color', id: id + '-c', 'aria-label': 'Colour' } });
        color.value = l.color || '#b4e04f';
        var kelvin = el('input', { attrs: { type: 'number', min: 1000, max: 12000, step: 100, id: id + '-k', 'aria-label': 'White in kelvin' } });
        kelvin.value = l.kelvin || 4000;
        var scene = el('input', { attrs: { type: 'text', maxlength: 120, id: id + '-s', 'aria-label': 'Scene name' } });
        scene.value = l.scene || '';
        var bright = el('input', { attrs: { type: 'number', min: 0, max: 100, id: id + '-b' } });
        bright.value = l.brightness != null ? l.brightness : 100;
        var valueBox = el('div');
        var valueLabel = el('label', { text: 'Colour', attrs: { for: id + '-c' } });
        function show() {
            while (valueBox.firstChild) valueBox.removeChild(valueBox.firstChild);
            var m = mode.value;
            if (m === 'off') { valueBox.appendChild(el('label', { text: ' ' })); return; }
            var input = m === 'white' ? kelvin : m === 'scene' ? scene : color;
            valueLabel.textContent = m === 'white' ? 'White (K)' : m === 'scene' ? 'Scene' : 'Colour';
            valueLabel.setAttribute('for', input.id);
            valueBox.appendChild(valueLabel);
            valueBox.appendChild(input);
        }
        mode.addEventListener('change', show);
        var rm = el('button', { className: 'btn btn-secondary btn-sm', text: 'Remove', attrs: { type: 'button' } });
        var row = el('div', { className: 'sb-preset-row' }, [
            el('div', null, [el('label', { text: 'Light', attrs: { for: dev.id } }), dev]),
            el('div', null, [el('label', { text: 'Set to', attrs: { for: mode.id } }), mode]),
            valueBox,
            el('div', null, [el('label', { text: 'Brightness', attrs: { for: bright.id } }), bright]),
            rm,
        ]);
        row._read = function () {
            var m = mode.value;
            var out = { device: dev.value, power: m === 'off' ? 'off' : 'on' };
            if (m === 'color') out.color = color.value;
            if (m === 'white') out.kelvin = Number(kelvin.value);
            if (m === 'scene') out.scene = scene.value.trim();
            if (m !== 'off') out.brightness = Number(bright.value);
            return out;
        };
        rm.addEventListener('click', function () { row.parentNode.removeChild(row); });
        show();
        rowsBox.appendChild(row);
        return row;
    }
    function openForm(preset) {
        loadChoices().then(function () {
            editing = preset ? preset.id : null;
            while (rowsBox.firstChild) rowsBox.removeChild(rowsBox.firstChild);
            nameInput.value = preset ? preset.name : '';
            (preset ? preset.lights : [null]).forEach(function (l) { addRow(l); });
            say(presetStatus, (choices.lights || []).length ? '' : 'No lights yet: find them in Studio or add a cloud key first.', (choices.lights || []).length ? '' : 'warn');
            form.hidden = false;
            nameInput.focus();
        });
    }
    var newBtn = document.querySelector('[data-preset-new]');
    if (newBtn) newBtn.addEventListener('click', function () { openForm(null); });
    document.addEventListener('click', function (e) {
        var a = e.target.closest('[data-preset-addrow]');
        if (a) { addRow(); return; }
        if (e.target.closest('[data-preset-cancel]')) { form.hidden = true; return; }
        var ed = e.target.closest('[data-preset-edit]');
        if (ed) { var p = presetData[ed.getAttribute('data-preset-edit')]; if (p) openForm(p); return; }
        var ap = e.target.closest('[data-preset-apply]');
        if (ap) {
            busy(ap, true);
            call('POST', '/stream/bot/api/lights/presets/' + ap.getAttribute('data-preset-apply') + '/apply').then(function (r) {
                busy(ap, false);
                say(statusNode, r.ok ? r.data.message : errorText(r, 'The preset did not apply.'), r.ok ? 'ok' : 'bad');
            });
            return;
        }
        var del = e.target.closest('[data-preset-delete]');
        if (del) {
            if (!window.confirm('Delete the preset ' + del.getAttribute('data-name') + '? Automations that apply it will fail until you pick another.')) return;
            call('DELETE', '/stream/bot/api/lights/presets/' + del.getAttribute('data-preset-delete')).then(function (r) {
                if (r.ok) reloadSoon(); else say(statusNode, errorText(r, 'Could not delete it.'), 'bad');
            });
        }
    });
    if (form) form.addEventListener('submit', function (e) {
        e.preventDefault();
        var lights = Array.prototype.map.call(rowsBox.children, function (r) { return r._read(); });
        var btn = form.querySelector('button[type="submit"]');
        busy(btn, true);
        call('POST', '/stream/bot/api/lights/presets', { preset: { id: editing, name: nameInput.value, lights: lights } }).then(function (r) {
            busy(btn, false);
            if (!r.ok) { say(presetStatus, errorText(r, 'The preset was not saved.'), 'bad'); return; }
            say(presetStatus, 'Saved.', 'ok');
            reloadSoon();
        });
    });
}());
