/*
 * OBS docks (views/stream-bot/dock.ejs). The dock key comes from this page's address; it is sent in the X-Dock-Key
 * header, except for the live feed (EventSource cannot send headers). Everything from the server is written as text.
 *
 * Chat page: with the 'chat' capability on the key, an input row sends a line as you (POST /stream/bot/dock/api/chat) and
 * each line gets Delete, Timeout and Ban (POST /stream/bot/dock/api/moderate). Controls page: with the 'channel'
 * capability, the title and category forms save through POST /stream/bot/dock/api/channel.
 */
(function () {
    'use strict';
    var page = document.body.getAttribute('data-dock-page');
    var params = new URLSearchParams(location.search);
    var key = params.get('key') || '';
    var MAX = 50;
    var TIMEOUT_SECONDS = 600;

    var sendForm = document.getElementById('dock-send');
    var chatCfg = null;
    if (sendForm) { try { chatCfg = JSON.parse(sendForm.getAttribute('data-chat') || 'null'); } catch (err) { chatCfg = null; } }

    function api(method, path, body) {
        return fetch(path, {
            method: method, headers: Object.assign({ 'X-Dock-Key': key }, body ? { 'Content-Type': 'application/json' } : {}),
            body: body ? JSON.stringify(body) : undefined,
        }).then(function (r) { return r.json().catch(function () { return {}; }); });
    }

    function span(cls, text) { var s = document.createElement('span'); s.className = cls; s.textContent = text; return s; }

    // Per-line actions for the chat page (only when the key has the chat capability).
    function canDelete(platform) { return !!chatCfg && (platform === 'kick' || (platform === 'twitch' && chatCfg.mod && chatCfg.mod.delete)); }
    function canBan(platform) { return !!chatCfg && (platform === 'kick' || (platform === 'twitch' && chatCfg.mod && chatCfg.mod.ban)); }
    function sendStatus(text, bad) {
        var s = document.getElementById('dock-send-status');
        if (!s) return;
        s.textContent = text || '';
        s.classList.toggle('is-bad', !!bad);
    }
    function lineButton(label, act, danger) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'dock-btn' + (danger ? ' is-danger' : ''); b.textContent = label; b.setAttribute('data-act', act);
        return b;
    }
    function decorate(li) {
        if (!chatCfg || li.querySelector('.dock-line-actions')) return;
        var platform = li.getAttribute('data-platform');
        var box = document.createElement('span');
        box.className = 'dock-line-actions';
        if (li.getAttribute('data-message-id') && canDelete(platform)) box.appendChild(lineButton('Delete', 'delete'));
        if (li.getAttribute('data-user-id') && canBan(platform)) {
            box.appendChild(lineButton('Timeout 10m', 'timeout'));
            box.appendChild(lineButton('Ban', 'ban', true));
        }
        if (box.children.length) li.appendChild(box);
    }

    function item(e, kind) {
        var li = document.createElement('li');
        li.className = 'dock-item';
        if (kind === 'chat') {
            li.appendChild(span('dock-meta', e.platformLabel || ''));
            li.appendChild(document.createTextNode(' '));
            li.appendChild(span('dock-name', e.user || 'Someone'));
            li.appendChild(document.createTextNode(' '));
            li.appendChild(span('dock-text', e.message || ''));
            if (chatCfg) {
                li.setAttribute('data-platform', e.platform || '');
                li.setAttribute('data-message-id', e.messageId || '');
                li.setAttribute('data-user-id', e.userId || '');
                decorate(li);
            }
        } else {
            li.appendChild(span('dock-text', e.text || e.typeLabel || ''));
            li.appendChild(document.createTextNode(' '));
            li.appendChild(span('dock-meta', e.platformLabel || ''));
        }
        return li;
    }

    if (page === 'activity' || page === 'chat') {
        var list = document.getElementById('dock-feed');
        var live = document.getElementById('dock-live');
        if (chatCfg) Array.prototype.forEach.call(list.querySelectorAll('.dock-item'), decorate);
        var src = new EventSource('/stream/bot/dock/api/feed?key=' + encodeURIComponent(key) + '&kind=' + page);
        src.onopen = function () { if (live) live.hidden = false; };
        src.onerror = function () { if (live) live.hidden = true; };
        src.addEventListener('closed', function () { src.close(); if (live) live.hidden = true; });
        src.onmessage = function (m) {
            var e;
            try { e = JSON.parse(m.data); } catch (err) { return; }
            var hint = document.getElementById('dock-hint');
            if (hint) hint.remove();
            list.insertBefore(item(e, page), list.firstChild);
            while (list.children.length > MAX) list.removeChild(list.lastChild);
        };
    }

    if (page === 'chat' && sendForm) {
        sendForm.addEventListener('submit', function (ev) {
            ev.preventDefault();
            var input = document.getElementById('dock-send-text');
            var platform = document.getElementById('dock-send-platform');
            if (!input || !platform) return;
            var text = input.value.trim();
            if (!text) { sendStatus('Type a message first.', true); return; }
            input.disabled = true;
            api('POST', '/stream/bot/dock/api/chat', { platform: platform.value, text: text }).then(function (r) {
                if (r && r.ok) { input.value = ''; sendStatus('Sent.'); } else sendStatus((r && r.message) || 'That did not send. Try again.', true);
            }).catch(function () { sendStatus('No connection. Try again.', true); }).then(function () { input.disabled = false; input.focus(); });
        });
        document.addEventListener('click', function (ev) {
            var b = ev.target.closest('[data-act]');
            var li = b && b.closest('.dock-item');
            if (!b || !li) return;
            var act = b.getAttribute('data-act');
            if (act === 'ban' && b.getAttribute('data-armed') !== '1') {
                // A ban asks twice: the second press within 4 seconds does it.
                b.setAttribute('data-armed', '1'); b.textContent = 'Press again to ban';
                setTimeout(function () { b.removeAttribute('data-armed'); b.textContent = 'Ban'; }, 4000);
                return;
            }
            b.disabled = true;
            var body = { platform: li.getAttribute('data-platform'), action: act, messageId: li.getAttribute('data-message-id') || undefined, userId: li.getAttribute('data-user-id') || undefined };
            if (act === 'timeout') body.seconds = TIMEOUT_SECONDS;
            api('POST', '/stream/bot/dock/api/moderate', body).then(function (r) {
                if (r && r.ok) {
                    sendStatus(act === 'delete' ? 'Message deleted.' : act === 'timeout' ? 'Timed out for 10 minutes.' : 'Banned.');
                    if (act === 'delete') li.classList.add('is-gone');
                    var box = li.querySelector('.dock-line-actions');
                    if (box) box.remove();
                } else { sendStatus((r && r.message) || 'That did not work. Try again.', true); b.disabled = false; }
            }).catch(function () { sendStatus('No connection. Try again.', true); b.disabled = false; });
        });
    }

    if (page === 'controls') {
        var status = document.getElementById('dock-status');
        var say = function (text, bad) { status.textContent = text; status.classList.toggle('is-bad', !!bad); };
        document.addEventListener('click', function (ev) {
            var b = ev.target.closest('[data-run]');
            if (!b) return;
            b.disabled = true;
            var name = b.parentNode.querySelector('.dock-name');
            say('Running ' + (name ? name.textContent : '') + '...');
            fetch('/stream/bot/dock/api/run', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dock-Key': key },
                body: JSON.stringify({ automationId: Number(b.getAttribute('data-run')) }),
            }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (r) {
                if (r && r.ok) say((name ? name.textContent : 'It') + ': ' + (r.status === 'ok' ? 'done' : r.status));
                else say((r && r.message) || 'That did not work. Try again.', true);
            }).catch(function () { say('No connection. Try again.', true); }).then(function () { b.disabled = false; });
        });

        // Title and category (only rendered when the key has the 'channel' capability).
        var chStatus = document.getElementById('dock-channel-status');
        var chSay = function (text, bad) { if (chStatus) { chStatus.textContent = text; chStatus.classList.toggle('is-bad', !!bad); } };
        Array.prototype.forEach.call(document.querySelectorAll('[data-channel-form]'), function (form) {
            var platform = form.getAttribute('data-channel-form');
            var cat = form.querySelector('[data-category-input]');
            var dl = form.querySelector('datalist');
            var timer = null;
            var original = { title: form.elements.title.value, category: cat.value };
            cat.addEventListener('input', function () {
                clearTimeout(timer);
                var q = cat.value.trim();
                if (q.length < 2) return;
                timer = setTimeout(function () {
                    api('GET', '/stream/bot/dock/api/categories?platform=' + encodeURIComponent(platform) + '&q=' + encodeURIComponent(q)).then(function (r) {
                        if (!r || !r.ok || !dl) return;
                        while (dl.firstChild) dl.removeChild(dl.firstChild);
                        r.categories.forEach(function (c) { var o = document.createElement('option'); o.value = c.name; dl.appendChild(o); });
                    }).catch(function () {});
                }, 250);
            });
            form.addEventListener('submit', function (ev) {
                ev.preventDefault();
                var body = { platform: platform };
                var t = form.elements.title.value.trim();
                var c = cat.value.trim();
                if (t && t !== original.title) body.title = t;
                if (c && c !== original.category) body.category = c;
                if (!body.title && !body.category) { chSay('Nothing changed.'); return; }
                var btn = form.querySelector('button[type="submit"]');
                btn.disabled = true;
                chSay('Saving...');
                api('POST', '/stream/bot/dock/api/channel', body).then(function (r) {
                    if (r && r.ok) {
                        if (r.title) original.title = r.title;
                        if (r.category) { original.category = r.category; cat.value = r.category; }
                        chSay('Saved on ' + (platform === 'kick' ? 'Kick' : 'Twitch') + '.');
                    } else chSay((r && r.message) || 'That did not save. Try again.', true);
                }).catch(function () { chSay('No connection. Try again.', true); }).then(function () { btn.disabled = false; });
            });
        });

        // Counters change while live: refresh them every 20 seconds.
        setInterval(function () {
            fetch('/stream/bot/dock/api/state', { headers: { 'X-Dock-Key': key } }).then(function (r) { return r.json(); }).then(function (r) {
                var dl = document.getElementById('dock-counters');
                if (!r || !r.ok || !dl) return;
                while (dl.firstChild) dl.removeChild(dl.firstChild);
                r.counters.forEach(function (c) {
                    var dt = document.createElement('dt'); dt.textContent = c.key;
                    var dd = document.createElement('dd'); dd.textContent = c.value;
                    dl.appendChild(dt); dl.appendChild(dd);
                });
            }).catch(function () {});
        }, 20000);
    }
})();
