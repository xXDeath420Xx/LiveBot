/*
 * Stream bot Viewers pages (views/stream-bot/viewer.ejs and viewers-settings.ejs; the list page needs no script). The API is
 * /stream/bot/api/viewers (dashboard/routes/stream-bot-viewers.js). /js/csrf.js adds the CSRF header to every write.
 * Text is only ever set with textContent / value; elements are built with createElement.
 */
(function () {
    'use strict';
    var main = document.getElementById('main-content');
    var page = main ? main.getAttribute('data-sb-page') : '';
    if (page !== 'viewer' && page !== 'viewer-settings') return;
    var node = document.getElementById('sbv-data');
    var D = null;
    try { D = JSON.parse(node ? node.textContent : 'null'); } catch (e) { D = null; }
    if (!D) return;

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
    function notice(text, tone) {
        var box = $('sbv-msg');
        if (!box) return;
        $('sbv-msg-text').textContent = text;
        box.classList.remove('is-ok', 'is-bad', 'is-warn');
        if (tone) box.classList.add('is-' + tone);
        box.hidden = false;
    }
    var fmt = function (n) { return Number(n || 0).toLocaleString('en-US'); };

    // ── one viewer ──
    if (page === 'viewer') {
        var base = '/stream/bot/api/viewers/' + encodeURIComponent(D.id);
        var pf = $('sbv-points-form');
        if (pf) pf.addEventListener('submit', function (e) {
            e.preventDefault();
            var st = $('sbv-points-status');
            var amount = String($('sbv-amount').value || '').trim();
            if (!/^\d{1,12}$/.test(amount)) { setStatus(st, 'Enter a whole number of 0 or more.', 'bad'); $('sbv-amount').focus(); return; }
            setStatus(st, 'Saving…', 'busy');
            call('POST', base + '/points', { mode: $('sbv-mode').value, amount: amount, note: $('sbv-note').value }).then(function (r) {
                if (!r.ok) { setStatus(st, errorText(r, 'Not saved.'), 'bad'); return; }
                $('sbv-points').textContent = fmt(r.data.balance);
                setStatus(st, 'Saved. Reload to see it in the history.', 'ok');
                $('sbv-amount').value = '';
                $('sbv-note').value = '';
            });
        });
        var lf = $('sbv-link-form');
        if (lf) lf.addEventListener('submit', function (e) {
            e.preventDefault();
            var login = String($('sbv-link-login').value || '').trim();
            if (!login) { notice('Enter their name as it shows in chat.', 'bad'); $('sbv-link-login').focus(); return; }
            call('POST', base + '/link', { login: login }).then(function (r) {
                if (!r.ok) { notice(errorText(r, 'The accounts could not be linked.'), 'bad'); return; }
                window.location.assign('/stream/bot/viewers/' + encodeURIComponent(r.data.primaryId));
            });
        });
        var ub = $('sbv-unlink');
        if (ub) ub.addEventListener('click', function () {
            if (!window.confirm('Unlink these accounts? The points stay with this one.')) return;
            call('POST', base + '/unlink').then(function (r) {
                if (!r.ok) { notice(errorText(r, 'The accounts could not be unlinked.'), 'bad'); return; }
                window.location.reload();
            });
        });
        var db = $('sbv-delete');
        if (db) db.addEventListener('click', function () {
            if (!window.confirm('Delete ' + D.name + '\'s record and history? This cannot be undone.')) return;
            var ids = (D.accounts || [D.id]).slice();
            (function next() {
                if (!ids.length) { window.location.assign('/stream/bot/viewers'); return; }
                call('DELETE', '/stream/bot/api/viewers/' + encodeURIComponent(ids.shift())).then(function (r) {
                    if (!r.ok && r.status !== 404) { notice(errorText(r, 'Not deleted.'), 'bad'); return; }
                    next();
                });
            })();
        });
        return;
    }

    // ── settings ──
    var list = $('sbv-ranks');
    var basis = $('sbv-rank-basis');
    var unitText = function () { return basis.value === 'watch' ? 'hours' : (String($('sbv-currency').value || '').trim() || 'points'); };
    var seq = list ? list.querySelectorAll('[data-rank]').length : 0;
    function renumber() {
        Array.prototype.forEach.call(list.querySelectorAll('[data-rank]'), function (li, i) {
            var labels = li.querySelectorAll('label');
            if (labels[0]) labels[0].textContent = 'Rank ' + (i + 1) + ' name';
            if (labels[1]) labels[1].textContent = 'Rank ' + (i + 1) + ' from';
            var rm = li.querySelector('[data-rank-remove]');
            if (rm) rm.setAttribute('aria-label', 'Remove rank ' + (i + 1));
            var u = li.querySelector('[data-rank-unit]');
            if (u) u.textContent = unitText();
        });
        var empty = $('sbv-ranks-empty');
        if (empty) empty.hidden = !!list.querySelector('[data-rank]');
        $('sbv-rank-add').disabled = list.querySelectorAll('[data-rank]').length >= 20;
    }
    function addRank(name, min) {
        var i = seq++;
        var li = document.createElement('li');
        li.className = 'sbv-rank';
        li.setAttribute('data-rank', '');
        var l1 = document.createElement('label'); l1.className = 'sr-only'; l1.htmlFor = 'sbv-rank-name-' + i;
        var n = document.createElement('input'); n.type = 'text'; n.id = 'sbv-rank-name-' + i; n.maxLength = 40; n.autocomplete = 'off'; n.setAttribute('data-rank-name', ''); n.value = name || '';
        var l2 = document.createElement('label'); l2.className = 'sr-only'; l2.htmlFor = 'sbv-rank-min-' + i;
        var m = document.createElement('input'); m.type = 'number'; m.id = 'sbv-rank-min-' + i; m.min = '0'; m.step = 'any'; m.inputMode = 'decimal'; m.setAttribute('data-rank-min', ''); m.value = min == null ? '' : String(min);
        var u = document.createElement('span'); u.className = 'cf-muted'; u.setAttribute('data-rank-unit', '');
        var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'btn btn-secondary btn-sm'; rm.setAttribute('data-rank-remove', ''); rm.textContent = 'Remove';
        [l1, n, l2, m, u, rm].forEach(function (x) { li.appendChild(x); });
        list.appendChild(li);
        renumber();
        n.focus();
    }
    if (list) {
        list.addEventListener('click', function (e) {
            var b = e.target.closest ? e.target.closest('[data-rank-remove]') : null;
            if (!b) return;
            var li = b.closest('[data-rank]');
            var prev = li.previousElementSibling || li.nextElementSibling;
            li.remove();
            renumber();
            (prev ? prev.querySelector('[data-rank-name]') : $('sbv-rank-add')).focus();
        });
        $('sbv-rank-add').addEventListener('click', function () { addRank('', ''); });
        basis.addEventListener('change', renumber);
        $('sbv-currency').addEventListener('input', renumber);
        renumber();
    }

    var num = function (id) { var v = String($(id).value || '').trim(); return v === '' ? '' : Number(v); };
    var form = $('sbv-settings');
    form.addEventListener('submit', function (e) {
        e.preventDefault();
        var st = $('sbv-save-status');
        var errBox = $('sbv-errors');
        errBox.hidden = true;
        var hours = basis.value === 'watch';
        var ranks = Array.prototype.map.call(list.querySelectorAll('[data-rank]'), function (li) {
            var raw = String(li.querySelector('[data-rank-min]').value || '').trim();
            var v = raw === '' ? '' : Number(raw);
            return { name: li.querySelector('[data-rank-name]').value, min: v === '' || !isFinite(v) ? '' : (hours ? Math.round(v * 60) : Math.round(v)) };
        });
        var earn = { minutes: Number($('sbv-earn-minutes').value), points: num('sbv-earn-points'), subMultiplier: num('sbv-earn-mult') };
        Array.prototype.forEach.call(document.querySelectorAll('[data-earn]'), function (inp) { earn[inp.getAttribute('data-earn')] = num(inp.id); });
        var body = {
            tracking: $('sbv-tracking').checked, currency: $('sbv-currency').value, earn: earn, ranks: { basis: basis.value, list: ranks },
            give: { enabled: $('sbv-give').checked, min: num('sbv-give-min') },
            gamble: { enabled: $('sbv-gamble').checked, min: num('sbv-gamble-min'), max: num('sbv-gamble-max'), winChance: num('sbv-gamble-chance') },
            ignore: String($('sbv-ignore').value || '').split(/[\s,]+/).filter(Boolean),
        };
        setStatus(st, 'Saving…', 'busy');
        call('POST', '/stream/bot/api/viewers/settings', body).then(function (r) {
            if (r.ok) { setStatus(st, 'Saved', 'ok'); return; }
            setStatus(st, 'Not saved', 'bad');
            var ul = $('sbv-errors-list');
            while (ul.firstChild) ul.removeChild(ul.firstChild);
            var errs = (r.data && r.data.errors) || [errorText(r, 'Not saved.')];
            errs.forEach(function (m) { var li = document.createElement('li'); li.textContent = m; ul.appendChild(li); });
            errBox.hidden = false;
            errBox.focus();
        });
    });

    var add = $('sbv-add-commands');
    if (add) add.addEventListener('click', function () {
        add.disabled = true;
        call('POST', '/stream/bot/api/viewers/commands').then(function (r) {
            if (!r.ok) { add.disabled = false; notice(errorText(r, 'The commands could not be added.'), 'bad'); return; }
            notice(r.data.created ? fmt(r.data.created) + ' command' + (r.data.created === 1 ? '' : 's') + ' added, switched off. Reloading…' : 'They were already there.', 'ok');
            window.setTimeout(function () { window.location.reload(); }, 800);
        });
    });
})();
