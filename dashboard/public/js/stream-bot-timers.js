/*
 * Stream bot Timers page (/stream/bot/timers, views/stream-bot/timers.ejs). Page data comes from #sb-data; the API is
 * /stream/bot/api/timers (dashboard/routes/stream-bot-timers.js). /js/csrf.js adds the CSRF header to every write.
 * Text from the page data is only ever set with textContent / value.
 */
(function () {
    'use strict';
    var main = document.getElementById('main-content');
    if (!main || main.getAttribute('data-sb-page') !== 'timers') return;
    var node = document.getElementById('sb-data');
    var D = null;
    try { D = JSON.parse(node ? node.textContent : 'null'); } catch (e) { D = null; }
    if (!D) return;

    var all = {};
    (D.own || []).forEach(function (t) { all[t.id] = t; });
    (D.kick || []).forEach(function (t) { all[t.id] = t; });

    function $(id) { return document.getElementById(id); }
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
        if (r.data && r.data.error) return r.data.error;
        if (r.data && Array.isArray(r.data.errors) && r.data.errors.length) return r.data.errors.join(' ');
        return fallback;
    }
    function setStatus(n, text, tone) {
        if (!n) return;
        n.textContent = text || '';
        n.classList.remove('is-ok', 'is-bad', 'is-warn', 'is-busy');
        if (tone) n.classList.add('is-' + tone);
    }

    var editor = $('sb-timer-editor');
    var form = $('sb-timer-form');
    var title = $('sb-timer-form-title');
    var errBox = $('sb-timer-errors');
    var errList = $('sb-timer-errors-list');
    var fields = {
        name: $('sb-t-name'), where: $('sb-t-where'), messages: $('sb-t-messages'), rotation: $('sb-t-rotation'), automation: $('sb-t-automation'),
        interval: $('sb-t-interval'), live: $('sb-t-live'), lines: $('sb-t-lines'), on: $('sb-t-on'),
    };
    var whereRow = $('sb-t-where-row');
    var autoRow = $('sb-t-auto-row');
    var editing = null;   // timer id, or null for a new one

    (D.automations || []).forEach(function (a) {
        var o = document.createElement('option');
        o.value = String(a.id);
        o.textContent = a.name + (a.enabled ? '' : ' (off)');
        fields.automation.appendChild(o);
    });
    // Only offer the platforms that are linked.
    var linked = D.linkedPlatforms || [];
    Array.prototype.forEach.call(fields.where.options, function (o) {
        if (o.value !== 'all' && linked.indexOf(o.value) < 0) o.disabled = true;
    });

    function syncAutomation() {
        var on = !!fields.automation.value;
        fields.messages.disabled = on;
        fields.rotation.disabled = on;
    }
    fields.automation.addEventListener('change', syncAutomation);

    function showErrors(list) {
        while (errList.firstChild) errList.removeChild(errList.firstChild);
        (list || []).forEach(function (t) { var li = document.createElement('li'); li.textContent = t; errList.appendChild(li); });
        errBox.hidden = !(list && list.length);
    }

    function open(t) {
        editing = t ? t.id : null;
        var kickPage = !!(t && t.kind === 'kick_page');
        title.textContent = t ? 'Edit timer' : 'Add a timer';
        fields.name.value = t && t.name ? t.name : '';
        fields.where.value = t ? (t.platforms || 'all') : (linked.length === 1 ? linked[0] : 'all');
        fields.messages.value = t ? (t.messages || []).join('\n') : '';
        fields.rotation.value = t && t.rotation === 'random' ? 'random' : 'rotate';
        fields.automation.value = t && t.automationId ? String(t.automationId) : '';
        fields.interval.value = t ? String(t.intervalMin) : '30';
        fields.live.checked = !!(t && t.onlyLive);
        fields.lines.value = t ? String(t.minChatLines || 0) : '0';
        fields.on.checked = t ? !!t.enabled : true;
        whereRow.hidden = kickPage;
        autoRow.hidden = kickPage;
        syncAutomation();
        showErrors([]);
        setStatus($('sb-t-status'), '');
        editor.hidden = false;
        title.focus();
    }

    $('sb-timer-new').addEventListener('click', function () { open(null); });
    $('sb-t-cancel').addEventListener('click', function () { editor.hidden = true; editing = null; $('sb-timer-new').focus(); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-edit-timer]'), function (b) {
        b.addEventListener('click', function () { var t = all[b.getAttribute('data-edit-timer')]; if (t) open(t); });
    });

    var saving = false;
    form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (saving) return;
        saving = true;
        var status = $('sb-t-status');
        setStatus(status, 'Saving', 'busy');
        var body = {
            name: fields.name.value.trim(),
            platforms: fields.where.value,
            messages: fields.automation.value ? [] : fields.messages.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean),
            rotation: fields.rotation.value,
            automationId: fields.automation.value ? Number(fields.automation.value) : null,
            intervalMin: Number(fields.interval.value),
            onlyLive: fields.live.checked,
            minChatLines: fields.lines.value === '' ? 0 : Number(fields.lines.value),
            enabled: fields.on.checked,
        };
        call(editing ? 'PUT' : 'POST', '/stream/bot/api/timers' + (editing ? '/' + encodeURIComponent(editing) : ''), body).then(function (r) {
            saving = false;
            if (!r.ok) {
                showErrors((r.data && r.data.errors) || [errorText(r, 'Could not save.')]);
                setStatus(status, 'Not saved', 'bad');
                errBox.focus();
                return;
            }
            setStatus(status, 'Saved', 'ok');
            window.location.reload();
        });
    });

    var listStatus = $('sb-timers-status');
    Array.prototype.forEach.call(document.querySelectorAll('[data-toggle-timer]'), function (sw) {
        sw.addEventListener('change', function () {
            var id = sw.getAttribute('data-toggle-timer');
            var want = sw.checked;
            sw.disabled = true;
            call('POST', '/stream/bot/api/timers/' + encodeURIComponent(id) + '/toggle', { enabled: want }).then(function (r) {
                sw.disabled = false;
                if (r.ok) setStatus(listStatus, want ? 'Turned on' : 'Turned off', 'ok');
                else { sw.checked = !want; setStatus(listStatus, errorText(r, 'Could not change it.'), 'bad'); }
            });
        });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-delete-timer]'), function (b) {
        b.addEventListener('click', function () {
            var name = b.getAttribute('data-name') || 'this timer';
            if (!window.confirm('Delete "' + name + '"? This cannot be undone.')) return;
            b.disabled = true;
            call('DELETE', '/stream/bot/api/timers/' + encodeURIComponent(b.getAttribute('data-delete-timer'))).then(function (r) {
                if (r.ok) { window.location.reload(); return; }
                b.disabled = false;
                setStatus(listStatus, errorText(r, 'Could not delete it.'), 'bad');
            });
        });
    });
})();
