/*
 * /stream/bot/import (views/stream-bot/import.ejs): upload, preview, import, recreate a saved reward.
 * Every element is built with createElement and textContent; page data is read from <script id="sbi-data"> as text.
 * /js/csrf.js (loaded first) adds the CSRF header to every state-changing fetch.
 */
(function () {
    'use strict';
    var main = document.getElementById('main-content');
    if (!main || main.getAttribute('data-sb-page') !== 'import') return;

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
    function $(id) { return document.getElementById(id); }
    function setStatus(node, text, tone) {
        if (!node) return;
        node.textContent = text || '';
        node.classList.remove('is-ok', 'is-bad', 'is-warn', 'is-busy');
        if (tone) node.classList.add('is-' + tone);
    }
    function readData() {
        var n = $('sbi-data');
        if (!n) return {};
        try { return JSON.parse(n.textContent) || {}; } catch (e) { return {}; }
    }
    function send(method, url, body, contentType) {
        var headers = { Accept: 'application/json' };
        if (contentType) headers['Content-Type'] = contentType;
        return fetch(url, { method: method, credentials: 'same-origin', headers: headers, body: body })
            .then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok && data && data.ok !== false, status: res.status, data: data || {} }; });
            })
            .catch(function () { return { ok: false, status: 0, data: { error: 'Could not reach CertiFried. Check your connection and try again.' } }; });
    }
    function errorText(r, fallback) {
        if (r.status === 401) return 'You are signed out. Sign in again and retry.';
        if (r.status === 413) return (r.data && r.data.error) || 'That file is too large.';
        return (r.data && r.data.error) || fallback;
    }
    function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

    var data = readData();
    var categories = data.categories || [];
    var preview = data.preview || null;
    var SRC = { firebot: 'Firebot', streamerbot: 'Streamer.bot' };
    var KIND = { 'firebot-profile': 'Firebot profile', 'firebot-setup': 'Firebot setup', 'streamerbot-data': 'Streamer.bot data folder', 'streamerbot-export': 'Streamer.bot export' };
    var PHASE = { '2b': 'CertiFried Studio update', '3': 'Phase 3 (overlays)', '4': 'Phase 4 (chat and stream tools)', '5': 'Phase 5 (lights)', '6': 'Phase 6', never: 'Not planned', done: 'Available now', importer: 'Available, not imported yet', '-': 'Under review' };

    function item(title, meta, body) {
        var main2 = el('div', { className: 'cf-list-main' }, [el('p', { className: 'cf-list-title', text: title })]);
        if (meta && meta.length) main2.appendChild(el('p', { className: 'cf-list-meta' }, meta.map(function (m) { return el('span', { text: m }); })));
        (body || []).forEach(function (b) { main2.appendChild(el('p', { className: 'cf-list-body', text: b })); });
        return el('div', { className: 'cf-list-item cf-list-item--multi' }, [main2]);
    }

    // ── preview ───────────────────────────────────────────────────────────────────────────────
    function renderPreview(p) {
        preview = p;
        var box = $('sbi-preview');
        $('sbi-clear').hidden = !p;
        if (!p) { box.hidden = true; return; }
        box.hidden = false;
        var rep = p.report || {};

        var files = $('sbi-files');
        clear(files);
        Object.keys(p.files || {}).forEach(function (src) {
            var f = p.files[src];
            var st = (p.stripped || {})[src] || {};
            var removed = (st.fields || 0) + (st.values || 0);
            var meta = [KIND[f.kind] || f.kind];
            if (removed) meta.push(plural(removed, 'password, token or key', 'passwords, tokens or keys') + ' removed');
            if (f.skipped && f.skipped.length) meta.push(plural(f.skipped.length, 'file') + ' skipped unread');
            files.appendChild(item(SRC[src] + (f.name ? ': ' + f.name : ''), meta));
        });

        var tbody = $('sbi-counts');
        clear(tbody);
        categories.forEach(function (c) {
            var n = (rep.counts || {})[c.key];
            if (!n) return;
            var importable = n.as_is + n.changed;
            var id = 'sbi-cat-' + c.key;
            var box2 = el('input', { attrs: { type: 'checkbox', id: id, 'data-cat': c.key } });
            box2.checked = importable > 0 && !c.optIn;
            box2.disabled = importable === 0;
            tbody.appendChild(el('tr', {}, [
                el('td', {}, [box2]),
                el('td', {}, [el('label', { text: c.label, attrs: { for: id } })]),
                el('td', { text: String(n.as_is) }), el('td', { text: String(n.changed) }), el('td', { text: String(n.skipped) }),
            ]));
        });

        var vRow = $('sbi-viewers-row');
        var vSrc = Object.keys(p.viewers || {}).filter(function (k) { return p.viewers[k]; });
        vRow.hidden = !vSrc.length;
        if (vSrc.length) {
            $('sbi-viewers-desc').textContent = vSrc.map(function (k) { return SRC[k] + ': ' + plural(p.viewers[k].count, 'viewer'); }).join('. ')
                + '. Off unless you tick it in the table. When ticked, they go to the Viewers tab: watch time, chat messages and points from Firebot, names and last-seen dates from Streamer.bot. Importing again does not count anything twice. Viewers can see and delete their records through /privacy.';
        }

        [['as_is', 'Imported as they are'], ['changed', 'Imported with changes'], ['skipped', 'Not imported']].forEach(function (g) {
            var d = $('sbi-group-' + g[0]);
            var list = (rep.groups || {})[g[0]] || [];
            d.querySelector('summary').textContent = g[1] + ' (' + list.length + ')';
            var holder = d.querySelector('.cf-list');
            clear(holder);
            d.hidden = !list.length;
            list.forEach(function (it) {
                var meta = [it.sourceLabel, it.categoryLabel];
                if (it.target) meta.push('Becomes: ' + it.target);
                holder.appendChild(item(it.name, meta, it.why));
            });
        });

        var gaps = rep.gaps || [];
        var gd = $('sbi-gaps');
        gd.hidden = !gaps.length;
        gd.querySelector('summary').textContent = 'Not in CertiFried yet (' + gaps.length + ')';
        var gb = gd.querySelector('tbody');
        clear(gb);
        gaps.forEach(function (g) {
            gb.appendChild(el('tr', {}, [
                el('td', { className: 'sb-wrap' }, [el('span', { className: 'cf-em', text: g.label }), el('br'), el('span', { className: 'cf-muted', text: (g.examples || []).join(', ') })]),
                el('td', { text: plural(g.count, 'time') }),
                el('td', { text: PHASE[g.phase] || g.phase }),
            ]));
        });

        var cd = $('sbi-connect');
        var checklist = rep.checklist || [];
        var obs = rep.obs || [];
        cd.hidden = !checklist.length && !obs.length;
        cd.querySelector('summary').textContent = 'Connect these in CertiFried (' + checklist.length + ')';
        var cl = cd.querySelector('.cf-list');
        clear(cl);
        checklist.forEach(function (c) {
            var body = [c.todo];
            if (c.service === 'obs' && obs.length) {
                body.push('Your OBS websocket: ' + obs.map(function (o) { return (o.host === 'localhost' ? '127.0.0.1' : o.host) + ':' + o.port + ' (from ' + SRC[o.source] + ')'; }).join(', ') + '. The password was not imported.');
            }
            cl.appendChild(item(c.label, ['Used in ' + (c.from || []).join(' and '), c.have ? 'Available' : 'Not available yet'], body));
        });

        var md = $('sbi-media');
        var media = rep.media || [];
        md.hidden = !media.length;
        md.querySelector('summary').textContent = 'Media files your effects use (' + media.length + ')';
        var ml = md.querySelector('.cf-list');
        clear(ml);
        media.forEach(function (m) {
            var name = String(m.path || '').split(/[\\/]/).pop();
            ml.appendChild(item(name, [m.kind, 'Used by ' + (m.usedBy || ''), SRC[m.source] || m.source], [m.path]));
        });
        setStatus($('sbi-run-status'), '');
    }

    function chosen() {
        return Array.prototype.map.call(document.querySelectorAll('#sbi-counts input[data-cat]:checked'), function (b) { return b.getAttribute('data-cat'); });
    }

    var form = $('sbi-form');
    form.addEventListener('submit', function (e) {
        e.preventDefault();
        var status = $('sbi-up-status');
        var file = $('sbi-file').files && $('sbi-file').files[0];
        var text = $('sbi-text').value.trim();
        if (!file && !text) { setStatus(status, 'Choose a file or paste an import string.', 'bad'); return; }
        var name = file ? file.name : 'import-string.sb';
        setStatus(status, 'Reading…', 'busy');
        var btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        var body = file || new Blob([text], { type: 'text/plain' });
        send('POST', '/stream/bot/api/import/upload?name=' + encodeURIComponent(name), body, file ? 'application/octet-stream' : 'text/plain').then(function (r) {
            btn.disabled = false;
            if (!r.ok) { setStatus(status, errorText(r, 'That file could not be read.'), 'bad'); return; }
            setStatus(status, 'Read. Check the preview below.', 'ok');
            $('sbi-file').value = '';
            $('sbi-text').value = '';
            renderPreview(r.data.preview);
            $('sbi-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });

    $('sbi-clear').addEventListener('click', function () {
        send('DELETE', '/stream/bot/api/import/preview').then(function (r) {
            if (!r.ok) { setStatus($('sbi-up-status'), errorText(r, 'Could not clear the preview.'), 'bad'); return; }
            renderPreview(null);
            setStatus($('sbi-up-status'), 'Cleared.', 'ok');
        });
    });

    $('sbi-run').addEventListener('click', function () {
        var cats = chosen();
        var status = $('sbi-run-status');
        if (!cats.length) { setStatus(status, 'Tick at least one category.', 'bad'); return; }
        var btn = $('sbi-run');
        btn.disabled = true;
        setStatus(status, 'Importing…', 'busy');
        send('POST', '/stream/bot/api/import/run', JSON.stringify({ categories: cats, viewers: cats.indexOf('viewers') >= 0 }), 'application/json').then(function (r) {
            btn.disabled = false;
            if (!r.ok) { setStatus(status, errorText(r, 'The import did not finish.'), 'bad'); return; }
            setStatus(status, '');
            renderPreview(null);
            showResults(r.data.results || []);
        });
    });

    var RESULT = { created: 'Created, switched off', updated: 'Updated, switched off', already: 'Already imported', skipped: 'Not created', failed: 'Failed' };
    function showResults(results) {
        var sec = $('sbi-result');
        var list = $('sbi-results');
        clear(list);
        sec.hidden = false;
        var made = results.filter(function (x) { return x.result === 'created'; }).length;
        list.appendChild(item(plural(made, 'item') + ' created', [plural(results.filter(function (x) { return x.result === 'already'; }).length, 'item') + ' already there']));
        results.forEach(function (x) {
            var row = item(x.name, [SRC[x.source] || x.source, RESULT[x.result] || x.result], x.detail && x.detail !== RESULT[x.result] ? [x.detail] : []);
            if (x.links && x.links.length) {
                var acts = el('div', { className: 'cf-list-actions' });
                x.links.forEach(function (l) { if (/^\/[a-z]/.test(l.href)) acts.appendChild(el('a', { className: 'btn btn-secondary btn-sm', text: l.label, attrs: { href: l.href } })); });
                row.appendChild(acts);
            }
            list.appendChild(row);
        });
        sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ── saved rewards ─────────────────────────────────────────────────────────────────────────
    Array.prototype.forEach.call(document.querySelectorAll('[data-recreate]'), function (b) {
        b.addEventListener('click', function () {
            var name = b.getAttribute('data-name') || 'this reward';
            if (!window.confirm('Create "' + name + '" on your Twitch channel as a CertiFried reward, switched off? Delete or rename the old one first; two rewards cannot share a title.')) return;
            b.disabled = true;
            var status = $('sbi-rw-status');
            setStatus(status, 'Creating on Twitch…', 'busy');
            send('POST', '/stream/bot/api/import/rewards/' + encodeURIComponent(b.getAttribute('data-recreate')) + '/recreate').then(function (r) {
                if (!r.ok) { b.disabled = false; setStatus(status, errorText(r, 'Twitch did not create it.'), 'bad'); return; }
                var moved = r.data.automationsUpdated || 0;
                setStatus(status, 'Created, switched off.' + (moved ? ' ' + plural(moved, 'automation') + ' moved to it.' : ''), 'ok');
                b.replaceWith(el('span', { className: 'cf-pill is-ok', text: 'Recreated' }));
            });
        });
    });

    // ── saved banned words (H-742): applied to a Kick channel's automod only when the owner presses Apply ──
    Array.prototype.forEach.call(document.querySelectorAll('[data-apply-words]'), function (b) {
        b.addEventListener('click', function () {
            var name = b.getAttribute('data-name') || 'this channel';
            var count = Number(b.getAttribute('data-count')) || 0;
            if (!window.confirm('Add ' + plural(count, 'banned word') + ' to ' + name + "'s Kick automod? The word rule starts removing messages with these words straight away. You can edit or remove words on the Kick channel page.")) return;
            b.disabled = true;
            var status = $('sbi-words-status');
            setStatus(status, 'Applying…', 'busy');
            send('POST', '/stream/bot/api/import/words/' + encodeURIComponent(b.getAttribute('data-apply-words')) + '/apply', JSON.stringify({ channelBotId: Number(b.getAttribute('data-channel-bot')) }), 'application/json').then(function (r) {
                if (!r.ok) { b.disabled = false; setStatus(status, errorText(r, 'The words were not added.'), 'bad'); return; }
                setStatus(status, r.data.added ? plural(r.data.added, 'word') + ' added to ' + name + "'s Kick automod." : 'They were already in ' + name + "'s Kick automod.", 'ok');
                var done = el('span', { className: 'cf-pill is-ok', text: 'In ' + name + "'s Kick automod" });
                b.replaceWith(done);
            });
        });
    });

    // ── saved banned words → Twitch blocked terms (H-763): only when the owner presses the button and confirms ──
    Array.prototype.forEach.call(document.querySelectorAll('[data-twitch-terms]'), function (b) {
        b.addEventListener('click', function () {
            var count = Number(b.getAttribute('data-count')) || 0;
            if (!window.confirm('Add ' + plural(count, 'banned word') + " to your Twitch channel's blocked terms? Twitch starts holding back messages with these words straight away. Words already there are skipped; nothing is removed. You can remove terms on Twitch (Creator Dashboard, Settings, Moderation, Blocked terms).")) return;
            b.disabled = true;
            var status = $('sbi-words-status');
            setStatus(status, 'Sending to Twitch…', 'busy');
            send('POST', '/stream/bot/api/import/words/' + encodeURIComponent(b.getAttribute('data-twitch-terms')) + '/twitch', '{}', 'application/json').then(function (r) {
                if (!r.ok) { b.disabled = false; setStatus(status, errorText(r, 'Twitch did not add the words.'), 'bad'); return; }
                var d = r.data || {};
                var parts = [plural(d.added || 0, 'word') + ' added to Twitch blocked terms'];
                if (d.skipped) parts.push(plural(d.skipped, 'word') + ' already there');
                if (d.invalid) parts.push(plural(d.invalid, 'word') + ' too short or too long for Twitch');
                if (d.failed) parts.push(plural(d.failed, 'word') + ' not added' + (d.failures && d.failures[0] ? ' (' + d.failures[0] + ')' : ''));
                setStatus(status, parts.join(', ') + '.', d.failed ? 'bad' : 'ok');
                b.disabled = !!(!d.failed);
            });
        });
    });

    Array.prototype.forEach.call(document.querySelectorAll('main time[datetime]'), function (t) {
        var d = new Date(t.getAttribute('datetime'));
        if (!isNaN(d.getTime())) { try { t.textContent = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { /* keep UTC */ } }
    });

    renderPreview(preview);
})();
