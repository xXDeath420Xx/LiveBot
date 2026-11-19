/*
 * The Overlays tab (views/stream-bot/overlays.ejs and overlay-edit.ejs): add and delete overlays, upload media, save an
 * overlay's settings (every control with data-cfg="<path>"), variations, Test alerts, goal progress, copy and new address,
 * and the scaled live preview. Elements are built with createElement / cloneNode and filled with textContent only.
 */
(function () {
    'use strict';
    var msgBox = document.getElementById('sbo-msg');
    function csrf() {
        var m = document.querySelector('meta[name="csrf-token"]');
        return (m && m.getAttribute('content')) || (window.CSRF_TOKEN || '');
    }
    function call(method, url, body, raw) {
        var headers = { 'X-CSRF-Token': csrf() };
        var opts = { method: method, credentials: 'same-origin', headers: headers };
        if (raw) { opts.body = raw; headers['Content-Type'] = 'application/octet-stream'; }
        else if (body !== undefined) { opts.body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
        return fetch(url, opts).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok && d.ok !== false, status: r.status, data: d }; });
        }).catch(function () { return { ok: false, status: 0, data: { error: 'The connection failed. Try again.' } }; });
    }
    function say(id, text, kind) {
        var n = document.getElementById(id);
        if (!n) return;
        n.textContent = text || '';
        n.className = 'cf-status-line' + (kind ? ' is-' + kind : '');
    }
    function notice(text) {
        if (!msgBox) return;
        document.getElementById('sbo-msg-text').textContent = text;
        msgBox.hidden = !text;
    }
    function errorOf(r, fallback) { return (r.data && r.data.error) || fallback; }

    // ── list page ──
    var addForm = document.getElementById('sbo-add-form');
    if (addForm) {
        addForm.addEventListener('submit', function (e) {
            e.preventDefault();
            var picked = addForm.querySelector('input[name="type"]:checked');
            say('sbo-add-status', 'Adding…');
            call('POST', '/stream/bot/api/overlays', { type: picked ? picked.value : '', name: document.getElementById('sbo-add-name').value }).then(function (r) {
                if (!r.ok) { say('sbo-add-status', errorOf(r, 'Could not add it.'), 'bad'); return; }
                window.location.href = '/stream/bot/overlays/' + encodeURIComponent(r.data.id);
            });
        });
    }
    document.querySelectorAll('[data-delete-overlay]').forEach(function (b) {
        b.addEventListener('click', function () {
            if (!window.confirm('Delete ' + b.getAttribute('data-name') + '? Its address stops working at once.')) return;
            call('DELETE', '/stream/bot/api/overlays/' + encodeURIComponent(b.getAttribute('data-delete-overlay'))).then(function (r) {
                if (r.ok) window.location.reload(); else notice(errorOf(r, 'Could not delete it.'));
            });
        });
    });
    var mediaForm = document.getElementById('sbo-media-form');
    if (mediaForm) {
        mediaForm.addEventListener('submit', function (e) {
            e.preventDefault();
            var file = document.getElementById('sbo-media-file').files[0];
            if (!file) { say('sbo-up-status', 'Choose a file first.', 'bad'); return; }
            var name = document.getElementById('sbo-media-name').value.trim() || file.name;
            say('sbo-up-status', 'Uploading…');
            call('POST', '/stream/bot/api/overlays/media?name=' + encodeURIComponent(name), undefined, file).then(function (r) {
                if (!r.ok) { say('sbo-up-status', errorOf(r, 'The upload failed.'), 'bad'); return; }
                window.location.reload();
            });
        });
    }
    document.querySelectorAll('[data-delete-media]').forEach(function (b) {
        b.addEventListener('click', function () {
            if (!window.confirm('Delete ' + b.getAttribute('data-name') + '? Alerts that use it will show no image.')) return;
            call('DELETE', '/stream/bot/api/overlays/media/' + encodeURIComponent(b.getAttribute('data-delete-media'))).then(function (r) {
                if (r.ok) window.location.reload(); else say('sbo-media-status', errorOf(r, 'Could not delete it.'), 'bad');
            });
        });
    });

    // ── one overlay ──
    var dataEl = document.getElementById('sbo-edit-data');
    if (!dataEl) return;
    var D;
    try { D = JSON.parse(dataEl.textContent); } catch (e) { return; }
    var api = '/stream/bot/api/overlays/' + encodeURIComponent(D.id);

    // preview: a 1920×1080 frame scaled to the column, loaded once it is near the screen
    var frame = document.getElementById('sbo-frame');
    var wrap = document.getElementById('sbo-preview');
    var soundBox = document.getElementById('sbo-prev-sound');
    function frameSrc() {
        var s = frame.getAttribute('data-src');
        return s ? s + (soundBox && soundBox.checked ? '&sound=1' : '') : '';
    }
    function fit() {
        if (!wrap || !frame) return;
        var scale = wrap.clientWidth / 1920;
        frame.style.transform = 'scale(' + scale + ')';
        wrap.style.height = Math.round(1080 * scale) + 'px';
    }
    function reloadFrame() { if (frame && frameSrc()) frame.src = frameSrc(); }
    if (frame) {
        fit();
        window.addEventListener('resize', fit);
        reloadFrame();
        if (soundBox) soundBox.addEventListener('change', reloadFrame);
    }

    // copy and new address
    var urlIn = document.getElementById('sbo-url');
    var copyBtn = document.getElementById('sbo-copy');
    if (copyBtn) copyBtn.addEventListener('click', function () {
        urlIn.select();
        (navigator.clipboard ? navigator.clipboard.writeText(urlIn.value) : Promise.reject()).then(function () { notice('Address copied.'); }).catch(function () { document.execCommand('copy'); notice('Address copied.'); });
    });
    var rotBtn = document.getElementById('sbo-rotate');
    if (rotBtn) rotBtn.addEventListener('click', function () {
        if (!window.confirm('Make a new address? The current one stops working at once, so OBS needs the new one.')) return;
        call('POST', api + '/key').then(function (r) {
            if (!r.ok) { notice(errorOf(r, 'Could not make a new address.')); return; }
            urlIn.value = r.data.url;
            frame.setAttribute('data-src', r.data.url + '?preview=1');
            reloadFrame();
            notice('New address made. Paste it into OBS, or add the overlay again from CertiFried Studio.');
        });
    });

    // Test buttons
    document.querySelectorAll('[data-test-alert]').forEach(function (b) {
        b.addEventListener('click', function () {
            var amt = document.getElementById('sbo-test-amount');
            say('sbo-test-status', 'Sending…');
            call('POST', api + '/test', { alert: b.getAttribute('data-test-alert'), amount: amt && amt.value !== '' ? Number(amt.value) : null }).then(function (r) {
                say('sbo-test-status', r.ok ? r.data.message : errorOf(r, 'Could not send the test.'), r.ok && r.data.sent ? 'ok' : (r.ok ? 'warn' : 'bad'));
            });
        });
    });

    // goal progress
    function goal(mode, value) {
        say('sbo-goal-status', 'Saving…');
        call('POST', api + '/goal', { mode: mode, value: value }).then(function (r) {
            if (!r.ok) { say('sbo-goal-status', errorOf(r, 'Could not change it.'), 'bad'); return; }
            document.getElementById('sbo-goal-value').value = r.data.current;
            say('sbo-goal-status', 'Now ' + r.data.current + ' of ' + r.data.target + '.', 'ok');
        });
    }
    var gs = document.getElementById('sbo-goal-set');
    if (gs) gs.addEventListener('click', function () { goal('set', document.getElementById('sbo-goal-value').value); });
    var gr = document.getElementById('sbo-goal-reset');
    if (gr) gr.addEventListener('click', function () { if (window.confirm('Start the goal again at 0?')) goal('set', 0); });

    // variations
    var seq = 0;
    function cloneOptions(templateId, select) {
        var t = document.getElementById(templateId);
        if (!t) return;
        Array.prototype.forEach.call(t.content.children, function (o) { select.appendChild(o.cloneNode(true)); });
        select.value = '';
    }
    function varField(labelText, control, wide) {
        var f = document.createElement('div');
        f.className = 'sb-field' + (wide ? ' is-wide' : '');
        var id = 'sbo-nv-' + (++seq);
        control.id = id;
        var l = document.createElement('label');
        l.setAttribute('for', id);
        l.textContent = labelText;
        f.appendChild(l);
        f.appendChild(control);
        return f;
    }
    function input(type, key, attrs) {
        var i = document.createElement('input');
        i.type = type;
        i.setAttribute('data-var', key);
        Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); });
        return i;
    }
    function select(key, templateId) {
        var s = document.createElement('select');
        s.setAttribute('data-var', key);
        cloneOptions(templateId, s);
        return s;
    }
    function renumber(box) {
        Array.prototype.forEach.call(box.querySelectorAll('.sbo-var'), function (v, i) {
            v.querySelector('.sbo-var-title').textContent = 'Variation ' + (i + 1);
            var rm = v.querySelector('[data-remove-variation]');
            if (rm) rm.textContent = 'Remove variation ' + (i + 1);
        });
    }
    function bindRemove(box, fs) {
        var rm = fs.querySelector('[data-remove-variation]');
        if (rm) rm.addEventListener('click', function () { fs.parentNode.removeChild(fs); renumber(box); });
    }
    document.querySelectorAll('[data-variations]').forEach(function (box) {
        Array.prototype.forEach.call(box.querySelectorAll('.sbo-var'), function (fs) { bindRemove(box, fs); });
    });
    document.querySelectorAll('[data-add-variation]').forEach(function (b) {
        b.addEventListener('click', function () {
            var box = document.querySelector('[data-variations="' + b.getAttribute('data-add-variation') + '"]');
            if (!box) return;
            if (box.querySelectorAll('.sbo-var').length >= 10) { notice('An alert can have at most 10 variations.'); return; }
            var fs = document.createElement('fieldset');
            fs.className = 'sbo-var';
            var lg = document.createElement('legend');
            lg.className = 'sbo-var-title';
            fs.appendChild(lg);
            var grid = document.createElement('div');
            grid.className = 'sb-fields';
            grid.appendChild(varField(box.getAttribute('data-amount-label') || 'At least', input('number', 'min', { min: '0', step: 'any' })));
            grid.appendChild(varField('Text', input('text', 'message', { maxlength: '300' }), true));
            grid.appendChild(varField('Second line', input('text', 'detail', { maxlength: '300' }), true));
            grid.appendChild(varField('Image or video', select('media', 'sbo-media-options')));
            grid.appendChild(varField('Sound', select('sound', 'sbo-sound-options')));
            grid.appendChild(varField('Layout', select('layout', 'sbo-layout-options')));
            grid.appendChild(varField('Show for (ms)', input('number', 'durationMs', { min: '2000', max: '30000', step: '500' })));
            fs.appendChild(grid);
            var tools = document.createElement('div');
            tools.className = 'sbo-var-tools';
            var rm = document.createElement('button');
            rm.type = 'button';
            rm.className = 'btn btn-secondary btn-sm';
            rm.setAttribute('data-remove-variation', '');
            tools.appendChild(rm);
            fs.appendChild(tools);
            box.appendChild(fs);
            bindRemove(box, fs);
            renumber(box);
            fs.querySelector('input').focus();
        });
    });

    // collect and save
    function setPath(obj, path, value) {
        var parts = path.split('.');
        var o = obj;
        for (var i = 0; i < parts.length - 1; i++) { if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {}; o = o[parts[i]]; }
        o[parts[parts.length - 1]] = value;
    }
    function collect() {
        var cfg = JSON.parse(JSON.stringify(D.config || {}));
        var multi = {};
        document.querySelectorAll('[data-cfg]').forEach(function (n) {
            var path = n.getAttribute('data-cfg');
            if (n.hasAttribute('data-multi')) { if (!multi[path]) multi[path] = []; if (n.checked) multi[path].push(n.value); return; }
            var v = n.type === 'checkbox' ? n.checked : n.type === 'number' ? (n.value === '' ? '' : Number(n.value)) : n.value;
            setPath(cfg, path, v);
        });
        Object.keys(multi).forEach(function (p) { setPath(cfg, p, multi[p]); });
        document.querySelectorAll('[data-variations]').forEach(function (box) {
            var list = [];
            Array.prototype.forEach.call(box.querySelectorAll('.sbo-var'), function (fs) {
                var v = {};
                Array.prototype.forEach.call(fs.querySelectorAll('[data-var]'), function (n) { v[n.getAttribute('data-var')] = n.type === 'number' ? (n.value === '' ? '' : Number(n.value)) : n.value; });
                list.push(v);
            });
            setPath(cfg, 'alerts.' + box.getAttribute('data-variations') + '.variations', list);
        });
        return cfg;
    }
    var form = document.getElementById('sbo-form');
    if (form) form.addEventListener('submit', function (e) {
        e.preventDefault();
        say('sbo-save-status', 'Saving…');
        call('PUT', api, { name: document.getElementById('sbo-name').value, config: collect() }).then(function (r) {
            if (!r.ok) { say('sbo-save-status', errorOf(r, 'Could not save.'), 'bad'); return; }
            say('sbo-save-status', 'Saved. Open overlays show it now.', 'ok');
            document.querySelectorAll('[data-alert]').forEach(function (body) {
                var key = body.getAttribute('data-alert');
                var on = body.querySelector('[data-cfg="alerts.' + key + '.enabled"]');
                var n = body.querySelectorAll('.sbo-var').length;
                var st = document.querySelector('[data-state-for="' + key + '"]');
                if (st && on) st.textContent = (on.checked ? 'On' : 'Off') + (n ? ', ' + n + ' variation' + (n === 1 ? '' : 's') : '');
            });
        });
    });

    var del = document.getElementById('sbo-delete');
    if (del) del.addEventListener('click', function () {
        if (!window.confirm('Delete ' + del.getAttribute('data-name') + '? Its address stops working at once.')) return;
        call('DELETE', api).then(function (r) { if (r.ok) window.location.href = '/stream/bot/overlays'; else notice(errorOf(r, 'Could not delete it.')); });
    });
})();
