/*
 * OBS docks (views/stream-bot/dock.ejs). The dock key comes from this page's address; it is sent in the X-Dock-Key
 * header, except for the live feed (EventSource cannot send headers). Everything from the server is written as text.
 */
(function () {
    'use strict';
    var page = document.body.getAttribute('data-dock-page');
    var params = new URLSearchParams(location.search);
    var key = params.get('key') || '';
    var MAX = 50;

    function item(e, kind) {
        var li = document.createElement('li');
        li.className = 'dock-item';
        function span(cls, text) { var s = document.createElement('span'); s.className = cls; s.textContent = text; return s; }
        if (kind === 'chat') {
            li.appendChild(span('dock-meta', e.platformLabel || ''));
            li.appendChild(document.createTextNode(' '));
            li.appendChild(span('dock-name', e.user || 'Someone'));
            li.appendChild(document.createTextNode(' '));
            li.appendChild(span('dock-text', e.message || ''));
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
