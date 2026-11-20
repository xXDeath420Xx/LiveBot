/*
 * "Switch over from Firebot or Streamer.bot" (views/stream-bot/switchover.ejs): loads the plan from
 * /stream/bot/api/switchover/preview, draws it (createElement and textContent only), sends Switch over with the ticked
 * "needs a look" items and the two tick-boxes, and Undo.
 */
(function () {
    'use strict';
    var box = document.getElementById('sbs-plan');
    if (!box) return;
    var goBtn = document.getElementById('sbs-go');
    var undoBtn = document.getElementById('sbs-undo');
    var plan = null;

    function csrf() {
        var m = document.querySelector('meta[name="csrf-token"]');
        return (m && m.getAttribute('content')) || (window.CSRF_TOKEN || '');
    }
    function call(method, url, body) {
        var opts = { method: method, credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf() } };
        if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
        return fetch(url, opts).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok && d.ok !== false, data: d }; });
        }).catch(function () { return { ok: false, data: { error: 'The connection failed. Try again.' } }; });
    }
    function say(id, text, kind) {
        var n = document.getElementById(id);
        if (!n) return;
        n.textContent = text || '';
        n.className = 'cf-status-line' + (kind ? ' is-' + kind : '');
    }
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null && text !== '') n.textContent = String(text);
        return n;
    }
    function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
    var SRC = { firebot: 'Firebot', streamerbot: 'Streamer.bot', music: 'Music page' };

    function group(title, desc) {
        var g = el('div', 'sbs-group');
        g.appendChild(el('p', 'sbs-group-title', title));
        if (desc) g.appendChild(el('p', 'sbs-group-desc', desc));
        box.appendChild(g);
        return g;
    }
    function list(g, items, label) {
        var ul = el('ul', 'sbs-list');
        items.forEach(function (it) {
            var li = el('li', null, label(it));
            ul.appendChild(li);
        });
        g.appendChild(ul);
    }
    function nameOf(it) { return it.name + (it.source && SRC[it.source] ? ' (' + SRC[it.source] + ')' : '') + (it.platform ? ' on ' + (it.platform === 'kick' ? 'Kick' : 'Twitch') : ''); }

    function draw(p) {
        while (box.firstChild) box.removeChild(box.firstChild);
        box.setAttribute('aria-busy', 'false');
        var all = p.automations.concat(p.commands, p.timers);
        var on = all.filter(function (x) { return x.state === 'turn_on'; });
        var attn = p.automations.filter(function (x) { return x.state === 'attention'; });
        var edited = all.filter(function (x) { return x.state === 'edited'; });
        var already = all.filter(function (x) { return x.state === 'already_on'; });
        var counts = el('p', 'sbs-counts', 'Turns on ' + plural(on.filter(function (x) { return x.key[0] === 'a'; }).length, 'automation', 'automations') + ' (' + plural(p.counts.songs || 0, 'song request command', 'song request commands') + '), '
            + plural(on.filter(function (x) { return x.key[0] === 'c'; }).length, 'chat command', 'chat commands') + ' and ' + plural(on.filter(function (x) { return x.key[0] === 't'; }).length, 'timer', 'timers')
            + '; ' + plural(p.counts.obsChanges || 0, 'OBS overlay swap', 'OBS overlay swaps') + '. ' + plural(attn.length, 'item needs', 'items need') + ' a look.');
        var cg = el('div', 'sbs-group'); cg.appendChild(counts); box.appendChild(cg);

        if (attn.length) {
            var ga = group('Needs a look first (stays off unless you tick it)', 'These were imported with something CertiFried could not settle for you. Tick one to turn it on anyway, or fix it in the automation first.');
            var ul = el('ul', 'sbs-attn');
            attn.forEach(function (a) {
                var li = el('li');
                var lab = el('label');
                var cb = document.createElement('input');
                cb.type = 'checkbox'; cb.setAttribute('data-include', a.key);
                lab.appendChild(cb);
                var link = el('a', null, nameOf(a));
                link.href = '/stream/bot/automations/' + encodeURIComponent(a.id);
                lab.appendChild(link);
                li.appendChild(lab);
                var why = el('ul');
                a.reasons.forEach(function (r) { why.appendChild(el('li', null, r)); });
                li.appendChild(why);
                ul.appendChild(li);
            });
            ga.appendChild(ul);
        }
        if (on.length) {
            var details = el('details', 'cf-expand');
            details.appendChild(el('summary', null, 'Turned on (' + on.length + ')'));
            var body = el('div', 'cf-expand-body');
            var ul2 = el('ul', 'sbs-list');
            on.forEach(function (x) { ul2.appendChild(el('li', null, nameOf(x) + (x.songs ? ', song requests' : ''))); });
            body.appendChild(ul2);
            details.appendChild(body);
            var gon = group('What it turns on', p.counts.songs ? 'Song request commands make CertiFried Studio keep the music off your Twitch VOD while they are on.' : '');
            gon.appendChild(details);
        }
        if (edited.length) list(group('You changed these after the import, so they are left as they are', ''), edited, nameOf);
        if (already.length) group('Already on: ' + already.length, '');

        var go = group('OBS', '');
        if (!p.obs.available) {
            go.appendChild(el('p', 'sbs-group-desc', p.obs.reason === 'studio_offline'
                ? 'CertiFried Studio is not connected, so OBS is left alone. Open Studio with OBS running and press Look again.'
                : 'CertiFried Studio did not answer about OBS. Check that OBS is connected in Studio, then press Look again.'));
        } else if (!p.obs.pairs.length) {
            go.appendChild(el('p', 'sbs-group-desc', 'No CertiFried overlay sources that replace another source were found in OBS. Add them from the Overlays tab with CertiFried Studio first.'));
        } else {
            var wrap = el('div', 'sbs-obs-wrap');
            var t = el('table', 'sbs-obs');
            var cap = el('caption', 'sbs-sr', 'OBS changes per scene');
            t.appendChild(cap);
            var thead = el('thead'); var hr = el('tr');
            ['Scene', 'Shows', 'Hides'].forEach(function (h) { var th = el('th', null, h); th.scope = 'col'; hr.appendChild(th); });
            thead.appendChild(hr); t.appendChild(thead);
            var tb = el('tbody');
            p.obs.pairs.forEach(function (x) {
                var tr = el('tr');
                tr.appendChild(el('td', null, x.scene));
                tr.appendChild(el('td', null, x.change === 'swap' ? x.newSource : x.change === 'hide_old' ? x.newSource + ' (already showing)' : 'Nothing: ' + x.oldSource + ' is hidden here, so ' + x.newSource + ' stays hidden too'));
                tr.appendChild(el('td', null, x.change === 'none' ? '' : x.oldSource));
                tb.appendChild(tr);
            });
            t.appendChild(tb); wrap.appendChild(t); go.appendChild(wrap);
        }
        if (p.obs.kept && p.obs.kept.length) go.appendChild(el('p', 'sbs-group-desc', 'Never touched: ' + p.obs.kept.join(', ') + ' (viewer-paid sounds CertiFried cannot replace yet).'));
        goBtn.disabled = false;
    }

    function load() {
        say('sbs-plan-status', 'Looking at your setup…');
        box.setAttribute('aria-busy', 'true');
        goBtn.disabled = true;
        call('GET', '/stream/bot/api/switchover/preview').then(function (r) {
            if (!r.ok) { say('sbs-plan-status', (r.data && r.data.error) || 'Could not read your setup.', 'bad'); return; }
            plan = r.data.plan;
            say('sbs-plan-status', 'Up to date.', 'ok');
            draw(plan);
        });
    }
    document.getElementById('sbs-refresh').addEventListener('click', load);
    goBtn.addEventListener('click', function () {
        if (!plan) return;
        if (!window.confirm('Switch over now? Your imported items go on and OBS swaps to the CertiFried overlays. You can undo it.')) return;
        var include = Array.prototype.map.call(document.querySelectorAll('[data-include]:checked'), function (c) { return c.getAttribute('data-include'); });
        goBtn.disabled = true;
        say('sbs-go-status', 'Switching over…');
        call('POST', '/stream/bot/api/switchover/apply', { include: include, obs: document.getElementById('sbs-obs').checked, closeApps: document.getElementById('sbs-close').checked }).then(function (r) {
            if (!r.ok) { say('sbs-go-status', (r.data && r.data.error) || 'The switchover failed.', 'bad'); goBtn.disabled = false; return; }
            var res = r.data.result || {};
            var text = 'Done: ' + plural(res.automations || 0, 'automation', 'automations') + ', ' + plural(res.commands || 0, 'command', 'commands') + ' and ' + plural(res.timers || 0, 'timer', 'timers') + ' on.';
            if (res.obs) text += res.obs.status === 'acked' ? ' OBS overlays swapped.' : ' OBS did not answer, so nothing in OBS changed (' + (res.obs.error || 'no answer') + ').';
            (res.apps && res.apps.apps || []).forEach(function (a) { text += ' ' + (a.app === 'firebot' ? 'Firebot' : 'Streamer.bot') + (a.closed ? ' closed.' : a.stillRunning ? ' is still open: quit it from the tray.' : ' was not running.'); });
            say('sbs-go-status', text, r.data.status === 'applied' ? 'ok' : 'warn');
            undoBtn.disabled = false;
            load();
        });
    });
    undoBtn.addEventListener('click', function () {
        if (!window.confirm('Undo the last switchover? What it turned on goes off again and OBS goes back as it was.')) return;
        undoBtn.disabled = true;
        say('sbs-undo-status', 'Putting it back…');
        call('POST', '/stream/bot/api/switchover/undo').then(function (r) {
            say('sbs-undo-status', r.ok ? 'Put back as it was.' : (r.data && r.data.error) || 'Undo failed.', r.ok ? 'ok' : 'bad');
            if (!r.ok) undoBtn.disabled = false;
            load();
        });
    });
    load();
})();
