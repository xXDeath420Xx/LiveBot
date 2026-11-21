/*
 * Stream bot live tools (dashboard/routes/stream-bot-live.js):
 *   Overview: the title and category editor (#sb-chan-forms) and the Redemptions list (#sb-redeem-list)
 *   Devices:  the per-dock-key switches for chat and for title and category ([data-dock-access])
 * /js/csrf.js (loaded by the page frame) adds the CSRF header to every state-changing fetch. Text from the server is
 * always written with textContent.
 */
(function () {
    'use strict';

    function el(tag, opts) {
        var n = document.createElement(tag);
        opts = opts || {};
        if (opts.cls) n.className = opts.cls;
        if (opts.text != null) n.textContent = opts.text;
        Object.keys(opts.attrs || {}).forEach(function (k) { n.setAttribute(k, opts.attrs[k]); });
        return n;
    }
    function status(node, text, tone) {
        if (!node) return;
        node.textContent = text || '';
        node.classList.remove('is-ok', 'is-bad', 'is-warn', 'is-busy');
        if (tone) node.classList.add('is-' + tone);
    }
    function call(method, url, body) {
        return fetch(url, {
            method: method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.httpStatus = r.status; return j; }); });
    }
    function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
    function message(r, fallback) { return (r && (r.message || (typeof r.error === 'string' && r.error.indexOf(' ') > 0 ? r.error : ''))) || fallback; }

    // ── Overview: title and category ──────────────────────────────────────────────────────────
    function initChannels() {
        var box = document.getElementById('sb-chan-forms');
        var st = document.getElementById('sb-chan-status');
        if (!box) return;
        call('GET', '/stream/bot/api/channel/info').then(function (r) {
            clear(box);
            if (!r || !r.ok || !r.channels.length) { box.appendChild(el('div', { cls: 'cf-state cf-state--compact', text: '' })).appendChild(el('p', { cls: 'cf-state-title', text: 'No Twitch or Kick channel to edit.' })); return; }
            r.channels.forEach(function (c, i) { box.appendChild(channelForm(c, i, st)); });
        }).catch(function () { clear(box); box.appendChild(el('p', { cls: 'cf-muted', text: 'Could not load the channels. Reload the page.' })); });
    }

    function channelForm(c, i, st) {
        var form = el('form', { attrs: { novalidate: '' } });
        var original = { title: c.title || '', category: c.category || '' };
        function row(label, input, id, desc) {
            var wrap = el('div', { cls: 'cf-row' });
            var text = el('div', { cls: 'cf-row-text' });
            text.appendChild(el('label', { cls: 'cf-row-label', text: label, attrs: { 'for': id } }));
            if (desc) text.appendChild(el('p', { cls: 'cf-row-desc', text: desc }));
            wrap.appendChild(text);
            var ctl = el('div', { cls: 'cf-row-control' });
            ctl.appendChild(input);
            wrap.appendChild(ctl);
            return wrap;
        }
        var tid = 'sb-chan-title-' + i, cid = 'sb-chan-cat-' + i, lid = 'sb-chan-list-' + i;
        var title = el('input', { attrs: { type: 'text', id: tid, maxlength: '140', autocomplete: 'off', value: original.title } });
        var cat = el('input', { attrs: { type: 'text', id: cid, maxlength: '100', autocomplete: 'off', list: lid, value: original.category } });
        var list = el('datalist', { attrs: { id: lid } });
        form.appendChild(el('h3', { cls: 'sb-secret-label', text: c.label + ': ' + (c.login || '') }));
        form.appendChild(row('Title', title, tid, 'Up to 140 characters.'));
        var catRow = row('Category', cat, cid, 'Start typing to search ' + c.label + ' categories.');
        catRow.appendChild(list);
        form.appendChild(catRow);
        var foot = el('div', { cls: 'cf-section-foot' });
        var save = el('button', { cls: 'btn btn-primary btn-sm', text: 'Save on ' + c.label, attrs: { type: 'submit' } });
        foot.appendChild(save);
        form.appendChild(foot);

        var timer = null;
        cat.addEventListener('input', function () {
            clearTimeout(timer);
            var q = cat.value.trim();
            if (q.length < 2) return;
            timer = setTimeout(function () {
                call('GET', '/stream/bot/api/channel/categories?platform=' + encodeURIComponent(c.platform) + '&q=' + encodeURIComponent(q)).then(function (r) {
                    if (!r || !r.ok) return;
                    clear(list);
                    r.categories.forEach(function (x) { list.appendChild(el('option', { attrs: { value: x.name } })); });
                }).catch(function () {});
            }, 250);
        });
        form.addEventListener('submit', function (ev) {
            ev.preventDefault();
            var body = { platform: c.platform };
            var t = title.value.trim(), g = cat.value.trim();
            if (t && t !== original.title) body.title = t;
            if (g && g !== original.category) body.category = g;
            if (!body.title && !body.category) { status(st, 'Nothing changed.'); return; }
            save.disabled = true;
            status(st, 'Saving', 'busy');
            call('POST', '/stream/bot/api/channel/update', body).then(function (r) {
                if (r && r.ok) {
                    if (r.title) original.title = r.title;
                    if (r.category) { original.category = r.category; cat.value = r.category; }
                    status(st, 'Saved on ' + c.label + '.', 'ok');
                } else status(st, message(r, 'That did not save. Try again.'), 'bad');
            }).catch(function () { status(st, 'No connection. Try again.', 'bad'); }).then(function () { save.disabled = false; });
        });
        return form;
    }

    // ── Overview: redemptions ─────────────────────────────────────────────────────────────────
    function initRedemptions() {
        var box = document.getElementById('sb-redeem-list');
        var st = document.getElementById('sb-redeem-status');
        var refresh = document.getElementById('sb-redeem-refresh');
        if (!box) return;

        function render(r) {
            clear(box);
            if (r.needScope) {
                box.appendChild(note(r.needScope === 'reconnect' ? 'Twitch no longer accepts the Stream bot grant.' : 'The Stream bot grant does not include channel point management.', 'Reconnect Twitch on the Connections page.', '/stream/bot/connections'));
                return;
            }
            if (!r.rows.length) {
                var s = el('div', { cls: 'cf-state cf-state--compact' });
                s.appendChild(el('p', { cls: 'cf-state-title', text: 'No redemptions in the last 7 days.' }));
                box.appendChild(s);
                return;
            }
            var list = el('div', { cls: 'cf-list' });
            r.rows.forEach(function (x) { list.appendChild(redemptionRow(x, r.importUrl)); });
            box.appendChild(list);
        }
        function note(title, text, href) {
            var s = el('div', { cls: 'cf-state cf-state--compact' });
            s.appendChild(el('p', { cls: 'cf-state-title', text: title }));
            var p = el('p', { cls: 'cf-state-text' });
            p.appendChild(el('a', { text: text, attrs: { href: href } }));
            s.appendChild(p);
            return s;
        }
        function redemptionRow(x, importUrl) {
            var item = el('div', { cls: 'cf-list-item cf-list-item--multi' });
            var main = el('div', { cls: 'cf-list-main' });
            var t = el('p', { cls: 'cf-list-title', text: x.reward + ' ' });
            if (x.state === 'pending') t.appendChild(el('span', { cls: 'cf-pill is-warn', text: 'Waiting' }));
            else if (x.state === 'done') t.appendChild(el('span', { cls: 'cf-pill', text: 'Done' }));
            else t.appendChild(el('span', { cls: 'cf-pill', text: 'Not managed by CertiFried' }));
            main.appendChild(t);
            var meta = el('p', { cls: 'cf-list-meta' });
            meta.appendChild(el('span', { text: x.user }));
            if (x.cost != null) meta.appendChild(el('span', { text: Number(x.cost).toLocaleString('en-US') + ' points' }));
            var when = new Date(x.at);
            meta.appendChild(el('span', { text: isNaN(when.getTime()) ? '' : when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }));
            main.appendChild(meta);
            if (x.message) main.appendChild(el('p', { cls: 'cf-list-body', text: x.message }));
            if (x.manageable === false) {
                var why = el('p', { cls: 'cf-list-meta' });
                why.appendChild(el('span', { text: 'Twitch only lets CertiFried change rewards it created. ' }));
                why.appendChild(el('a', { text: 'Recreate under CertiFried', attrs: { href: importUrl || '/stream/bot/import' } }));
                main.appendChild(why);
            }
            item.appendChild(main);
            var actions = el('div', { cls: 'cf-list-actions' });
            if (x.state === 'pending') {
                [['fulfil', 'Fulfil', 'btn btn-primary btn-sm'], ['refund', 'Refund', 'btn btn-secondary btn-sm']].forEach(function (a) {
                    var b = el('button', { cls: a[2], text: a[1], attrs: { type: 'button' } });
                    b.addEventListener('click', function () { act(x, a[0], b); });
                    actions.appendChild(b);
                });
            }
            item.appendChild(actions);
            return item;
        }
        function act(x, action, btn) {
            if (action === 'refund' && !window.confirm('Refund ' + x.reward + ' for ' + x.user + '? They get their points back.')) return;
            btn.disabled = true;
            status(st, action === 'fulfil' ? 'Marking done' : 'Refunding', 'busy');
            call('POST', '/stream/bot/api/redemptions/update', { rewardId: x.rewardId, redemptionId: x.redemptionId, action: action }).then(function (r) {
                if (r && r.ok) { status(st, action === 'fulfil' ? 'Marked done.' : 'Refunded.', 'ok'); load(); } else { status(st, message(r, 'That did not work. Try again.'), 'bad'); btn.disabled = false; }
            }).catch(function () { status(st, 'No connection. Try again.', 'bad'); btn.disabled = false; });
        }
        function load() {
            call('GET', '/stream/bot/api/redemptions').then(function (r) {
                if (r && r.ok) render(r); else { clear(box); box.appendChild(el('p', { cls: 'cf-muted', text: message(r, 'Could not load redemptions.') })); }
            }).catch(function () { clear(box); box.appendChild(el('p', { cls: 'cf-muted', text: 'Could not load redemptions. Reload the page.' })); });
        }
        if (refresh) refresh.addEventListener('click', function () { status(st, ''); load(); });
        load();
    }

    // ── Devices: per-dock-key switches ────────────────────────────────────────────────────────
    function initDockAccess() {
        var st = document.getElementById('sb-dev-status');
        document.addEventListener('change', function (ev) {
            var cb = ev.target;
            var box = cb && cb.closest && cb.closest('[data-dock-access]');
            if (!box || !cb.getAttribute('data-access')) return;
            var chat = box.querySelector('[data-access="chat"]');
            var channel = box.querySelector('[data-access="channel"]');
            status(st, 'Saving', 'busy');
            call('POST', '/stream/bot/api/devices/dock-access', { id: Number(box.getAttribute('data-dock-access')), chat: !!(chat && chat.checked), channel: !!(channel && channel.checked) }).then(function (r) {
                if (r && r.ok) { if (chat) chat.checked = !!r.chat; if (channel) channel.checked = !!r.channel; status(st, 'Saved. Reload the dock in OBS to use it.', 'ok'); }
                else { cb.checked = !cb.checked; status(st, message(r, 'That did not save. Try again.'), 'bad'); }
            }).catch(function () { cb.checked = !cb.checked; status(st, 'No connection. Try again.', 'bad'); });
        });
    }

    var main = document.querySelector('main[data-sb-page]');
    var page = main && main.getAttribute('data-sb-page');
    if (page === 'overview') { initChannels(); initRedemptions(); }
    if (page === 'devices') initDockAccess();
})();
