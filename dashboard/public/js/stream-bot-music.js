/*
 * /stream/bot/music (views/stream-bot/music.ejs): queue, controls, settings, bans, playlists, commands, player link.
 * Every element is built with createElement and textContent; page data is read from <script id="sbm-data"> as text.
 * /js/csrf.js (loaded first) adds the CSRF header to every state-changing fetch.
 */
(function () {
    'use strict';
    var main = document.getElementById('main-content');
    if (!main || main.getAttribute('data-sb-page') !== 'music') return;

    function $(id) { return document.getElementById(id); }
    function el(tag, props, children) {
        var n = document.createElement(tag);
        props = props || {};
        if (props.className) n.className = props.className;
        if (props.text != null) n.textContent = String(props.text);
        if (props.attrs) Object.keys(props.attrs).forEach(function (k) { if (props.attrs[k] != null && props.attrs[k] !== false) n.setAttribute(k, props.attrs[k] === true ? '' : String(props.attrs[k])); });
        (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
        return n;
    }
    function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
    function setStatus(node, text, tone) {
        if (!node) return;
        node.textContent = text || '';
        node.classList.remove('is-ok', 'is-bad', 'is-warn');
        if (tone) node.classList.add('is-' + tone);
    }
    function send(method, url, body) {
        return fetch(url, { method: method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
            .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok && data && data.ok !== false, status: res.status, data: data || {} }; }); })
            .catch(function () { return { ok: false, status: 0, data: { error: 'Could not reach CertiFried. Check your connection and try again.' } }; });
    }
    function errorText(r, fallback) { return r.status === 401 ? 'You are signed out. Sign in again and retry.' : ((r.data && r.data.error) || fallback); }
    function notice(text, tone) {
        var box = $('sbm-msg');
        if (!box) return;
        $('sbm-msg-text').textContent = text;
        box.hidden = !text;
        box.classList.toggle('cf-notice--danger', tone === 'bad');
    }
    function readData() { try { return JSON.parse(($('sbm-data') || {}).textContent || '{}') || {}; } catch (e) { return {}; } }

    // ── queue ──
    function requestItem(r, actions) {
        var meta = [r.artist || '', r.viewer ? 'requested by ' + r.viewer : '', r.length || '', r.explicit === true ? 'explicit' : '', r.playlist ? 'from ' + r.playlist : ''].filter(Boolean);
        var left = el('div', { className: 'cf-list-main' }, [el('p', { className: 'cf-list-title', text: r.title }), el('p', { className: 'cf-list-meta' }, meta.map(function (m) { return el('span', { text: m }); }))]);
        var right = el('div', { className: 'cf-list-actions' }, actions.map(function (a) {
            var b = el('button', { className: 'btn btn-secondary btn-sm', text: a[1], attrs: { type: 'button' } });
            b.addEventListener('click', function () { decide(r.id, a[0], b); });
            return b;
        }));
        return el('div', { className: 'cf-list-item' }, [left, right]);
    }
    function renderQueue(state) {
        var p = $('sbm-pending'), q = $('sbm-queued');
        clear(p); clear(q);
        if (state.pending && state.pending.length) {
            p.appendChild(el('p', { className: 'cf-row-label', text: 'Waiting for approval (' + state.pending.length + ')' }));
            state.pending.forEach(function (r) { p.appendChild(requestItem(r, [['approve', 'Approve'], ['deny', 'Deny']])); });
        }
        q.appendChild(el('p', { className: 'cf-row-label', text: state.queued && state.queued.length ? 'Up next (' + state.queued.length + ')' : 'Nothing is in the queue.' }));
        (state.queued || []).forEach(function (r) { q.appendChild(requestItem(r, [['remove', 'Remove']])); });
        if (state.vod && $('sbm-vod')) $('sbm-vod').textContent = state.vod.line;
        if ($('sbm-now')) {
            var n = state.now;
            $('sbm-now').textContent = n ? n.title + (n.artist ? ' by ' + n.artist : '') + (n.requester ? ' (requested by ' + n.requester + ')' : '') + (n.paused ? ', paused' : '') : 'Nothing';
        }
        if ($('sbm-player')) $('sbm-player').textContent = state.overlays ? 'Connected.' : 'Not connected. CertiFried Studio adds the "CertiFried Music" browser source to OBS for you; it can also be added by hand with the link below.';
    }
    function refresh() {
        return send('GET', '/stream/bot/api/music/state').then(function (r) { if (r.ok) renderQueue(r.data); });
    }
    function decide(id, action, btn) {
        btn.disabled = true;
        send('POST', '/stream/bot/api/music/requests/' + encodeURIComponent(id) + '/' + action).then(function (r) {
            btn.disabled = false;
            if (!r.ok) return notice(errorText(r, 'That did not work.'), 'bad');
            notice('');
            refresh();
        });
    }

    // ── controls ──
    Array.prototype.forEach.call(document.querySelectorAll('[data-control]'), function (b) {
        b.addEventListener('click', function () {
            var action = b.getAttribute('data-control');
            setStatus($('sbm-status'), 'Working…');
            send('POST', '/stream/bot/api/music/control', { action: action }).then(function (r) {
                if (!r.ok) return setStatus($('sbm-status'), errorText(r, 'That did not work.'), 'bad');
                var res = r.data.result;
                setStatus($('sbm-status'), res === 'held' ? 'Waiting for VOD protection.' : res === 'idle' ? 'Nothing to play.' : res === 'nothing' ? 'Nothing is playing.' : 'Done.', res === 'held' ? 'warn' : 'ok');
                setTimeout(refresh, 600);
            });
        });
    });

    function formPost(form, url, body, statusNode, okText) {
        setStatus(statusNode, 'Working…');
        return send('POST', url, body).then(function (r) {
            if (!r.ok) { setStatus(statusNode, errorText(r, 'That did not work.'), 'bad'); notice(errorText(r, 'That did not work.'), 'bad'); return r; }
            setStatus(statusNode, okText, 'ok');
            return r;
        });
    }

    var add = $('sbm-add-form');
    if (add) add.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = $('sbm-add').value.trim();
        if (!input) return;
        send('POST', '/stream/bot/api/music/requests', { input: input }).then(function (r) {
            notice(r.ok ? (r.data.message || 'Added.') : errorText(r, 'That song could not be added.'), r.ok ? null : 'bad');
            if (r.ok) { $('sbm-add').value = ''; refresh(); }
        });
    });

    var copy = $('sbm-copy');
    if (copy) copy.addEventListener('click', function () {
        var f = $('sbm-overlay-url');
        f.select();
        (navigator.clipboard ? navigator.clipboard.writeText(f.value) : Promise.reject()).then(function () { notice('Copied.'); }, function () { notice('Select the link and copy it.'); });
    });
    var rotate = $('sbm-rotate');
    if (rotate) rotate.addEventListener('click', function () {
        if (!window.confirm('Make a new player link? The old one stops working, so OBS needs the new one (Studio updates it when it next connects).')) return;
        send('POST', '/stream/bot/api/music/overlay-key').then(function (r) {
            if (!r.ok) return notice(errorText(r, 'No new link was made.'), 'bad');
            $('sbm-overlay-url').value = r.data.url;
            notice('New link made. Update the browser source in OBS if Studio does not do it.');
        });
    });

    var cmd = $('sbm-cmd-form');
    if (cmd) cmd.addEventListener('submit', function (e) {
        e.preventDefault();
        send('POST', '/stream/bot/api/music/commands', { enabled: !!$('sbm-cmd-on').checked }).then(function (r) {
            if (!r.ok) return notice(errorText(r, 'The commands were not added.'), 'bad');
            notice(r.data.created + ' commands added.');
            setTimeout(function () { window.location.reload(); }, 800);
        });
    });

    var settings = $('sbm-settings');
    if (settings) settings.addEventListener('submit', function (e) {
        e.preventDefault();
        var f = settings.elements;
        var checks = function (name) { return Array.prototype.filter.call(settings.querySelectorAll('input[name="' + name + '"]'), function (x) { return x.checked; }).map(function (x) { return x.value; }); };
        var messages = {};
        Array.prototype.forEach.call(settings.querySelectorAll('[data-message]'), function (x) { if (x.value.trim()) messages[x.getAttribute('data-message')] = x.value.trim(); });
        var body = {
            open: f.open.checked, approval: f.approval.value, approvalBypass: checks('approvalBypass'), allowExplicit: f.allowExplicit.checked,
            sources: checks('sources'), maxPerUser: f.maxPerUser.value, maxQueue: f.maxQueue.value, limitBypass: checks('limitBypass'),
            maxDurationSec: f.maxDurationSec.value, allowDuplicates: f.allowDuplicates.checked, voteSkip: f.voteSkip.value, skipOwn: f.skipOwn.checked,
            removeOwn: f.removeOwn.checked, volume: f.volume.value, fallbackPlaylistId: f.fallbackPlaylistId.value || null, defaultPlaylistId: f.defaultPlaylistId.value || null,
            card: f.card.checked, mention: f.mention.checked, spotifyDirect: f.spotifyDirect.checked, messages: messages,
        };
        formPost(settings, '/stream/bot/api/music/settings', body, $('sbm-set-status'), 'Saved.');
    });

    var linkStart = $('sbm-link-start');
    if (linkStart) linkStart.addEventListener('click', function () {
        setStatus($('sbm-link-status'), 'Starting…');
        send('POST', '/stream/bot/api/music/spotify/link').then(function (r) {
            if (!r.ok || !/^https:\/\/accounts\.spotify\.com\//.test(String(r.data.url || ''))) return setStatus($('sbm-link-status'), errorText(r, 'Linking could not start.'), 'bad');
            window.open(r.data.url, '_blank', 'noopener');
            setStatus($('sbm-link-status'), 'Agree in the Spotify tab, then paste the address it ends on.');
        });
    });
    var linkForm = $('sbm-link-form');
    if (linkForm) linkForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var url = $('sbm-link-url').value.trim();
        if (!url) return setStatus($('sbm-link-status'), 'Paste the address first.', 'bad');
        send('POST', '/stream/bot/api/music/spotify/link/finish', { redirectUrl: url }).then(function (r) {
            if (!r.ok) return setStatus($('sbm-link-status'), errorText(r, 'Linking did not finish.'), 'bad');
            setStatus($('sbm-link-status'), 'Linked' + (r.data.account ? ' as ' + r.data.account : '') + '.', 'ok');
            setTimeout(function () { window.location.reload(); }, 1000);
        });
    });

    var ban = $('sbm-ban-form');
    if (ban) ban.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = $('sbm-ban').value.trim();
        if (!input) return;
        send('POST', '/stream/bot/api/music/bans', { input: input, kind: $('sbm-ban-kind').value }).then(function (r) {
            if (!r.ok) return notice(errorText(r, 'Nothing was banned.'), 'bad');
            window.location.reload();
        });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-unban]'), function (b) {
        b.addEventListener('click', function () {
            send('DELETE', '/stream/bot/api/music/bans/' + encodeURIComponent(b.getAttribute('data-unban'))).then(function (r) {
                if (!r.ok) return notice(errorText(r, 'That did not work.'), 'bad');
                window.location.reload();
            });
        });
    });

    var imp = $('sbm-import-form');
    if (imp) imp.addEventListener('submit', function (e) {
        e.preventDefault();
        var url = $('sbm-import-url').value.trim();
        if (!url) return setStatus($('sbm-import-status'), 'Paste a playlist link.', 'bad');
        setStatus($('sbm-import-status'), 'Reading the playlist… this can take a minute for long ones.');
        send('POST', '/stream/bot/api/music/playlists', { url: url, name: $('sbm-import-name').value.trim() }).then(function (r) {
            if (!r.ok) return setStatus($('sbm-import-status'), errorText(r, 'The playlist was not imported.'), 'bad');
            setStatus($('sbm-import-status'), r.data.added + ' songs imported into ' + r.data.name + (r.data.full ? ' (it is full)' : '') + '.', 'ok');
            setTimeout(function () { window.location.reload(); }, 1200);
        });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-delete-playlist]'), function (b) {
        b.addEventListener('click', function () {
            if (!window.confirm('Delete the playlist ' + b.getAttribute('data-name') + '?')) return;
            send('DELETE', '/stream/bot/api/music/playlists/' + encodeURIComponent(b.getAttribute('data-delete-playlist'))).then(function (r) {
                if (!r.ok) return notice(errorText(r, 'That did not work.'), 'bad');
                window.location.reload();
            });
        });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-show-items]'), function (b) {
        b.addEventListener('click', function () {
            var id = b.getAttribute('data-show-items');
            var box = document.querySelector('[data-items-for="' + id + '"]');
            if (!box) return;
            if (!box.hidden) { box.hidden = true; return; }
            send('GET', '/stream/bot/api/music/playlists/' + encodeURIComponent(id) + '/items').then(function (r) {
                clear(box);
                if (!r.ok) { box.appendChild(el('p', { className: 'cf-list-meta', text: errorText(r, 'The songs could not be loaded.') })); box.hidden = false; return; }
                if (!r.data.items.length) box.appendChild(el('p', { className: 'cf-list-meta', text: 'No songs yet.' }));
                r.data.items.forEach(function (it) {
                    var rm = el('button', { className: 'btn btn-secondary btn-sm', text: 'Remove', attrs: { type: 'button' } });
                    var row = el('div', { className: 'cf-list-item' }, [el('div', { className: 'cf-list-main' }, [el('p', { className: 'cf-list-title', text: it.title }), el('p', { className: 'cf-list-meta' }, [el('span', { text: it.artist || '' }), el('span', { text: it.length || '' })])]), el('div', { className: 'cf-list-actions' }, [rm])]);
                    rm.addEventListener('click', function () {
                        send('DELETE', '/stream/bot/api/music/playlist-items/' + encodeURIComponent(it.id)).then(function (x) { if (x.ok) row.remove(); else notice(errorText(x, 'That did not work.'), 'bad'); });
                    });
                    box.appendChild(row);
                });
                box.hidden = false;
            });
        });
    });

    renderQueue(readData().state || {});
    setInterval(function () { if (!document.hidden) refresh(); }, 8000);
})();
