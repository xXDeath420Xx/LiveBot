/*
 * Stream bot Community pages (views/stream-bot/community-*.ejs). The API is /stream/bot/api/community
 * (dashboard/routes/stream-bot-community.js). /js/csrf.js adds the CSRF header to every write.
 * Text is only ever set with textContent / value; elements are built with createElement.
 */
(function () {
    'use strict';
    var main = document.getElementById('main-content');
    var page = main ? main.getAttribute('data-sb-page') : '';
    if (!/^community-(games|store|quotes|media)$/.test(page || '')) return;
    var node = document.getElementById('sbc-data');
    var D = null;
    try { D = JSON.parse(node ? node.textContent : 'null'); } catch (e) { D = null; }
    if (!D) return;
    var API = '/stream/bot/api/community';

    function $(id) { return document.getElementById(id); }
    function val(id) { var n = $(id); return n ? String(n.value || '').trim() : ''; }
    function checked(id) { var n = $(id); return !!(n && n.checked); }
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
        if (typeof n === 'string') n = $(n);
        if (!n) return;
        n.textContent = text || '';
        n.classList.remove('is-ok', 'is-bad', 'is-warn', 'is-busy');
        if (tone) n.classList.add('is-' + tone);
    }
    function notice(text, tone) {
        var box = $('sbc-msg');
        if (!box) return;
        $('sbc-msg-text').textContent = text;
        box.classList.remove('is-ok', 'is-bad', 'is-warn');
        if (tone) box.classList.add('is-' + tone);
        box.hidden = false;
    }
    function showErrors(list) {
        var box = $('sbc-errors');
        if (!box) return;
        var ul = $('sbc-errors-list');
        while (ul.firstChild) ul.removeChild(ul.firstChild);
        (list || []).forEach(function (t) { var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
        box.hidden = !(list && list.length);
        if (list && list.length) box.focus();
    }
    function num(id) { var v = val(id); return v === '' ? '' : Number(v); }
    function lines(id) { return val(id).split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean); }
    function reloadSoon() { setTimeout(function () { location.reload(); }, 700); }

    // ── "Add the chat commands" (every page) ──
    Array.prototype.forEach.call(document.querySelectorAll('[data-add-commands]'), function (b) {
        b.addEventListener('click', function () {
            var group = b.getAttribute('data-add-commands');
            var st = document.querySelector('[data-commands-status="' + group + '"]');
            b.disabled = true;
            setStatus(st, 'Adding…', 'busy');
            call('POST', API + '/commands', { group: group }).then(function (r) {
                b.disabled = false;
                if (!r.ok) { setStatus(st, errorText(r, 'Not added.'), 'bad'); return; }
                setStatus(st, r.data.created ? 'Added ' + r.data.created + ', switched off. Turn them on under Automations.' : 'They were already there.', 'ok');
                reloadSoon();
            });
        });
    });

    // ── chat games ──
    if (page === 'community-games') {
        var form = $('sbc-games');
        if (form) form.addEventListener('submit', function (e) {
            e.preventDefault();
            showErrors([]);
            setStatus('sbc-save-status', 'Saving…', 'busy');
            call('POST', API + '/games', {
                slots: { enabled: checked('sbc-slots-on'), min: num('sbc-slots-min'), max: num('sbc-slots-max'), payout3: num('sbc-slots-p3'), payout2: num('sbc-slots-p2'), symbols: lines('sbc-slots-symbols') },
                duel: { enabled: checked('sbc-duel-on'), min: num('sbc-duel-min'), max: num('sbc-duel-max'), expirySec: num('sbc-duel-exp') },
                heist: { enabled: checked('sbc-heist-on'), target: val('sbc-heist-target'), min: num('sbc-heist-min'), max: num('sbc-heist-max'), joinSec: num('sbc-heist-join'), cooldownMin: num('sbc-heist-cool') },
                raffle: { ticketCost: num('sbc-raffle-cost'), maxTickets: num('sbc-raffle-max'), winners: num('sbc-raffle-winners'), autoDrawSec: num('sbc-raffle-auto') },
                lineup: { max: num('sbc-lineup-max'), subsFirst: checked('sbc-lineup-subs') },
            }).then(function (r) {
                if (!r.ok) { setStatus('sbc-save-status', 'Not saved.', 'bad'); showErrors(r.data.errors || [errorText(r, 'Not saved.')]); return; }
                setStatus('sbc-save-status', 'Saved.', 'ok');
            });
        });

        var renderLive = function (live) {
            if (!live) return;
            var cur = D.currency || 'points';
            var rf = live.raffle;
            $('sbc-raffle-state').textContent = rf
                ? 'Open: ' + (rf.cost ? rf.cost.toLocaleString('en-US') + ' ' + cur + ' a ticket' : 'free tickets') + ', ' + rf.entries + (rf.entries === 1 ? ' person' : ' people') + ' with ' + rf.tickets + ' ticket' + (rf.tickets === 1 ? '' : 's') + ', ' + rf.winners + ' winner' + (rf.winners === 1 ? '' : 's') + '.'
                : 'No raffle is open.';
            document.querySelector('[data-raffle="open"]').hidden = !!rf;
            document.querySelector('[data-raffle="draw"]').hidden = !rf;
            document.querySelector('[data-raffle="cancel"]').hidden = !rf;
            var lu = live.lineup || { open: false, list: [] };
            $('sbc-lineup-state').textContent = (lu.open ? 'Open' : 'Closed') + ', ' + lu.list.length + (lu.list.length === 1 ? ' person.' : ' people.') + (live.heist ? ' A heist on the ' + live.heist.target + ' is being planned (' + live.heist.crew + ' in the crew).' : '');
            document.querySelector('[data-lineup="open"]').hidden = lu.open;
            document.querySelector('[data-lineup="close"]').hidden = !lu.open;
            var ol = $('sbc-lineup-list');
            while (ol.firstChild) ol.removeChild(ol.firstChild);
            lu.list.forEach(function (p, i) {
                var li = document.createElement('li');
                var name = document.createElement('span');
                name.textContent = p.name + (p.platform !== 'twitch' ? ' (' + (p.platform === 'kick' ? 'Kick' : 'YouTube') + ')' : '') + (p.sub ? ', subscriber' : '');
                var rm = document.createElement('button');
                rm.type = 'button';
                rm.className = 'btn btn-secondary btn-sm';
                rm.textContent = 'Take out';
                rm.setAttribute('aria-label', 'Take ' + p.name + ' out of the line-up');
                rm.addEventListener('click', function () { lineup('remove', i); });
                li.appendChild(name);
                li.appendChild(rm);
                ol.appendChild(li);
            });
        };
        var lineup = function (action, index) {
            setStatus('sbc-live-status', 'Working…', 'busy');
            call('POST', API + '/lineup', { action: action, index: index }).then(function (r) {
                if (!r.ok) { setStatus('sbc-live-status', errorText(r, 'That did not work.'), 'bad'); return; }
                setStatus('sbc-live-status', r.data.note || 'Done.', 'ok');
                renderLive(r.data);
            });
        };
        Array.prototype.forEach.call(document.querySelectorAll('[data-lineup]'), function (b) {
            b.addEventListener('click', function () {
                var a = b.getAttribute('data-lineup');
                if (a === 'clear' && !window.confirm('Empty the line-up? Everyone in it is taken out.')) return;
                lineup(a);
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-raffle]'), function (b) {
            b.addEventListener('click', function () {
                var a = b.getAttribute('data-raffle');
                if (a === 'cancel' && !window.confirm('Cancel the raffle? Nobody pays and nobody wins.')) return;
                setStatus('sbc-live-status', a === 'draw' ? 'Drawing…' : 'Working…', 'busy');
                call('POST', API + '/raffle', { action: a }).then(function (r) {
                    if (!r.ok) { setStatus('sbc-live-status', errorText(r, 'That did not work.'), 'bad'); return; }
                    setStatus('sbc-live-status', r.data.note || 'Done.', 'ok');
                    renderLive(r.data);
                });
            });
        });
        var refresh = $('sbc-live-refresh');
        if (refresh) refresh.addEventListener('click', function () {
            call('GET', API + '/live').then(function (r) { if (r.ok) { renderLive(r.data); setStatus('sbc-live-status', 'Up to date.', 'ok'); } else setStatus('sbc-live-status', errorText(r, 'Could not refresh.'), 'bad'); });
        });
        renderLive(D.live);
    }

    // ── the store ──
    if (page === 'community-store') {
        var itemForm = $('sbc-item-form');
        var editing = null;
        var fill = function (it) {
            editing = it ? it.id : null;
            $('sbc-item-id').value = it ? it.id : '';
            $('sbc-item-name').value = it ? it.name : '';
            $('sbc-item-desc').value = it ? (it.description || '') : '';
            $('sbc-item-cost').value = it ? it.cost : 100;
            $('sbc-item-stock').value = it && it.stock != null ? it.stock : '';
            $('sbc-item-limit').value = it && it.perUserLimit ? it.perUserLimit : '';
            $('sbc-item-window').value = it ? it.limitWindow : 'day';
            $('sbc-item-cool').value = it ? it.cooldownSec : 0;
            $('sbc-item-automation').value = it && it.automationId ? String(it.automationId) : '';
            $('sbc-item-on').checked = it ? !!it.enabled : true;
            $('sbc-item-title').textContent = it ? 'Edit ' + it.name : 'Add an item';
            $('sbc-item-save').textContent = it ? 'Save the item' : 'Add the item';
            $('sbc-item-cancel').hidden = !it;
            showErrors([]);
        };
        Array.prototype.forEach.call(document.querySelectorAll('[data-item-edit]'), function (b) {
            b.addEventListener('click', function () {
                var id = Number(b.getAttribute('data-item-edit'));
                var it = (D.items || []).filter(function (x) { return x.id === id; })[0];
                if (!it) return;
                fill(it);
                $('sbc-item-name').focus();
            });
        });
        $('sbc-item-cancel').addEventListener('click', function () { fill(null); });
        if (itemForm) itemForm.addEventListener('submit', function (e) {
            e.preventDefault();
            showErrors([]);
            setStatus('sbc-item-status', 'Saving…', 'busy');
            var body = { name: val('sbc-item-name'), description: val('sbc-item-desc'), cost: val('sbc-item-cost'), stock: val('sbc-item-stock'), perUserLimit: val('sbc-item-limit'),
                limitWindow: val('sbc-item-window'), cooldownSec: val('sbc-item-cool'), automationId: val('sbc-item-automation'), enabled: checked('sbc-item-on') };
            call(editing ? 'PUT' : 'POST', API + '/store/items' + (editing ? '/' + encodeURIComponent(editing) : ''), body).then(function (r) {
                if (!r.ok) { setStatus('sbc-item-status', 'Not saved.', 'bad'); showErrors(r.data.errors || [errorText(r, 'Not saved.')]); return; }
                setStatus('sbc-item-status', 'Saved.', 'ok');
                reloadSoon();
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-item-delete]'), function (b) {
            b.addEventListener('click', function () {
                if (!window.confirm('Delete ' + b.getAttribute('data-name') + '? Its past redemptions stay in the list.')) return;
                call('DELETE', API + '/store/items/' + encodeURIComponent(b.getAttribute('data-item-delete'))).then(function (r) {
                    if (!r.ok) { notice(errorText(r, 'Not deleted.'), 'bad'); return; }
                    reloadSoon();
                });
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-refund]'), function (b) {
            b.addEventListener('click', function () {
                if (!window.confirm('Give the points back for this redemption?')) return;
                b.disabled = true;
                call('POST', API + '/store/redemptions/' + encodeURIComponent(b.getAttribute('data-refund')) + '/refund').then(function (r) {
                    if (!r.ok) { b.disabled = false; notice(errorText(r, 'Not refunded.'), 'bad'); return; }
                    notice(r.data.note || 'Refunded.', r.data.note ? 'warn' : 'ok');
                    reloadSoon();
                });
            });
        });
    }

    // ── quotes ──
    if (page === 'community-quotes') {
        var qf = $('sbc-quote-form');
        var editingQ = null;
        if (qf) qf.addEventListener('submit', function (e) {
            e.preventDefault();
            showErrors([]);
            setStatus('sbc-quote-status', 'Saving…', 'busy');
            var body = { text: val('sbc-quote-text'), saidBy: val('sbc-quote-by'), game: val('sbc-quote-game') };
            call(editingQ ? 'PUT' : 'POST', API + '/quotes' + (editingQ ? '/' + encodeURIComponent(editingQ) : ''), body).then(function (r) {
                if (!r.ok) { setStatus('sbc-quote-status', 'Not saved.', 'bad'); showErrors(r.data.errors || [errorText(r, 'Not saved.')]); return; }
                setStatus('sbc-quote-status', editingQ ? 'Saved.' : 'Added quote #' + r.data.number + '.', 'ok');
                reloadSoon();
            });
        });
        var byId = function (id) { return (D.quotes || []).filter(function (x) { return x.id === id; })[0]; };
        Array.prototype.forEach.call(document.querySelectorAll('[data-quote-edit]'), function (b) {
            b.addEventListener('click', function () {
                var x = byId(Number(b.getAttribute('data-quote-edit')));
                if (!x) return;
                editingQ = x.id;
                $('sbc-quote-text').value = x.text;
                $('sbc-quote-by').value = x.saidBy || '';
                $('sbc-quote-game').value = x.game || '';
                $('sbc-qadd-title').textContent = 'Edit quote #' + x.number;
                qf.querySelector('button[type="submit"]').textContent = 'Save the quote';
                $('sbc-quote-text').focus();
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-quote-toggle]'), function (b) {
            b.addEventListener('click', function () {
                var x = byId(Number(b.getAttribute('data-quote-toggle')));
                if (!x) return;
                call('PUT', API + '/quotes/' + x.id, { text: x.text, saidBy: x.saidBy || '', game: x.game || '', enabled: !x.enabled }).then(function (r) {
                    if (!r.ok) { notice(errorText(r, 'Not changed.'), 'bad'); return; }
                    reloadSoon();
                });
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-quote-delete]'), function (b) {
            b.addEventListener('click', function () {
                if (!window.confirm('Delete quote #' + b.getAttribute('data-number') + '? The numbers of the others stay as they are.')) return;
                call('DELETE', API + '/quotes/' + encodeURIComponent(b.getAttribute('data-quote-delete'))).then(function (r) {
                    if (!r.ok) { notice(errorText(r, 'Not deleted.'), 'bad'); return; }
                    reloadSoon();
                });
            });
        });
        var en = $('sbc-quotes-enable');
        if (en) en.addEventListener('click', function () {
            en.disabled = true;
            call('POST', API + '/quotes/enable-imported').then(function (r) {
                if (!r.ok) { en.disabled = false; notice(errorText(r, 'Not changed.'), 'bad'); return; }
                notice('Turned on ' + r.data.enabled + ' imported quote' + (r.data.enabled === 1 ? '' : 's') + '.', 'ok');
                reloadSoon();
            });
        });
    }

    // ── media share and text to speech ──
    if (page === 'community-media') {
        var mf = $('sbc-media-form');
        if (mf) mf.addEventListener('submit', function (e) {
            e.preventDefault();
            showErrors([]);
            setStatus('sbc-media-status', 'Saving…', 'busy');
            call('POST', API + '/media', { open: checked('sbc-media-open'), approval: val('sbc-media-approval'), maxSeconds: num('sbc-media-len'), maxPerUser: num('sbc-media-per'),
                maxQueue: num('sbc-media-queue'), cost: num('sbc-media-cost'), showCard: checked('sbc-media-card') }).then(function (r) {
                if (!r.ok) { setStatus('sbc-media-status', 'Not saved.', 'bad'); showErrors(r.data.errors || [errorText(r, 'Not saved.')]); return; }
                setStatus('sbc-media-status', 'Saved.', 'ok');
            });
        });
        var tf = $('sbc-tts-form');
        if (tf) tf.addEventListener('submit', function (e) {
            e.preventDefault();
            setStatus('sbc-tts-status', 'Saving…', 'busy');
            call('POST', API + '/tts', { voice: val('sbc-tts-voice'), mask: checked('sbc-tts-mask'), words: lines('sbc-tts-words'), maxChars: num('sbc-tts-max'), volume: num('sbc-tts-vol') }).then(function (r) {
                if (!r.ok) { setStatus('sbc-tts-status', errorText(r, 'Not saved.'), 'bad'); return; }
                setStatus('sbc-tts-status', 'Saved.', 'ok');
            });
        });
        var test = $('sbc-tts-test');
        if (test) test.addEventListener('click', function () {
            test.disabled = true;
            setStatus('sbc-tts-status', 'Sending…', 'busy');
            call('POST', API + '/tts/test', { text: val('sbc-tts-test-text') }).then(function (r) {
                test.disabled = false;
                if (!r.ok) { setStatus('sbc-tts-status', errorText(r, 'Could not read it.'), 'bad'); return; }
                setStatus('sbc-tts-status', r.data.status === 'queued' ? 'Waiting for the Media Share source to open in OBS (up to 2 minutes).' : 'Playing on the Media Share source.', r.data.status === 'queued' ? 'warn' : 'ok');
            });
        });
        var copy = $('sbc-page-copy');
        if (copy) copy.addEventListener('click', function () {
            var input = $('sbc-page-url');
            var done = function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy'; }, 1500); };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value).then(done, function () { input.select(); });
            else { input.select(); }
        });
        var nk = $('sbc-page-new');
        if (nk) nk.addEventListener('click', function () {
            if (!window.confirm('Make a new address? The old one stops working at once, so update the source in OBS.')) return;
            call('POST', API + '/media/key').then(function (r) {
                if (!r.ok) { notice(errorText(r, 'No new address.'), 'bad'); return; }
                $('sbc-page-url').value = r.data.url;
                notice('New address made. Paste it into the CertiFried Media Share source in OBS.', 'ok');
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-media]'), function (b) {
            b.addEventListener('click', function () {
                var a = b.getAttribute('data-media');
                b.disabled = true;
                call('POST', API + '/media/requests/' + encodeURIComponent(b.getAttribute('data-id')) + '/' + a).then(function (r) {
                    if (!r.ok) { b.disabled = false; notice(errorText(r, 'That did not work.'), 'bad'); return; }
                    reloadSoon();
                });
            });
        });
        var add = $('sbc-mq-add');
        if (add) add.addEventListener('submit', function (e) {
            e.preventDefault();
            var url = val('sbc-mq-url');
            if (!url) { $('sbc-mq-url').focus(); return; }
            call('POST', API + '/media/requests', { url: url }).then(function (r) {
                if (!r.ok) { notice(errorText(r, 'Not added.'), 'bad'); return; }
                notice(r.data.note || 'Added.', 'ok');
                reloadSoon();
            });
        });
        var mqr = $('sbc-mq-refresh');
        if (mqr) mqr.addEventListener('click', function () { location.reload(); });
    }
})();
