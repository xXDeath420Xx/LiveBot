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
    var VOICE_STATE = { off: 'off', starting: 'starting', listening: 'listening', error: 'not working' };

    // ── fixing a held item here: the automation PUT, then "fixed" so the item stays in the plan ──
    function eachStep(list, fn) {
        (Array.isArray(list) ? list : []).forEach(function (s) {
            if (!s || typeof s !== 'object') return;
            if (s.type) fn(s);
            ['actions', 'then', 'else', 'steps'].forEach(function (k) { if (Array.isArray(s[k])) eachStep(s[k], fn); });
            if (Array.isArray(s.branches)) s.branches.forEach(function (b) { eachStep(b && b.actions, fn); });
        });
    }
    /** Read the automation, let `edit` change it, save it with the automation PUT, tell the plan it was fixed, draw the plan again. */
    function saveFix(a, edit, statusNode, opts) {
        statusNode.textContent = 'Saving…';
        return call('GET', '/stream/bot/api/automations/' + encodeURIComponent(a.id)).then(function (r) {
            if (!r.ok || !r.data.automation) throw new Error((r.data && r.data.error) || 'Could not read the automation.');
            var cur = r.data.automation;
            var body = { name: cur.name, enabled: !!cur.enabled, trigger_type: cur.trigger_type, trigger_config: cur.trigger_config || {}, conditions: cur.conditions || [], actions: cur.actions || [] };
            var changed = edit(body);
            if (!changed) { statusNode.textContent = 'Nothing to change.'; return null; }
            return call('PUT', '/stream/bot/api/automations/' + encodeURIComponent(a.id), body).then(function (p) {
                if (!p.ok) throw new Error(((p.data && p.data.errors) || []).join(' ') || (p.data && p.data.error) || 'The automation was not saved.');
                return call('POST', '/stream/bot/api/switchover/fixed', { id: a.id, phrase: !!(opts && opts.phrase) });
            }).then(function (f) { if (f) { statusNode.textContent = 'Saved.'; load(); } });
        }).catch(function (err) { statusNode.textContent = (err && err.message) || 'Could not save.'; statusNode.className = 'cf-status-line is-bad'; });
    }
    /** Phrase box and OBS source pickers for a held voice command, and Change to start for a Go Live that stops the stream. */
    function fixPanel(a, sources) {
        var wrap = el('div', 'sbs-fix');
        var status = el('span', 'cf-status-line');
        status.setAttribute('role', 'status');
        var phraseBox = null;
        var pickers = [];
        if (a.voice) {
            var pl = el('label', 'sbs-fix-label', (a.phrases.length > 1 ? 'Phrases you say, one per line' : 'Phrase you say'));
            phraseBox = document.createElement('textarea');
            phraseBox.rows = Math.max(1, Math.min(4, a.phrases.length));
            phraseBox.maxLength = 2100;
            phraseBox.value = a.phrases.join('\n');
            phraseBox.setAttribute('aria-label', 'Phrase for ' + a.name);
            phraseBox.spellcheck = false;
            pl.appendChild(phraseBox);
            wrap.appendChild(pl);
        }
        (a.unknownSources || []).forEach(function (name) {
            var lab = el('label', 'sbs-fix-label', 'OBS has no source called "' + name + '". Use');
            var ctl;
            if (sources.length) {
                ctl = document.createElement('select');
                var keep = document.createElement('option'); keep.value = ''; keep.textContent = 'Pick a source'; ctl.appendChild(keep);
                sources.forEach(function (s) { var o = document.createElement('option'); o.value = s; o.textContent = s; ctl.appendChild(o); });
            } else {
                ctl = document.createElement('input'); ctl.type = 'text'; ctl.placeholder = 'Source name in OBS'; ctl.maxLength = 120;
            }
            ctl.setAttribute('aria-label', 'OBS source to use instead of ' + name);
            lab.appendChild(ctl);
            wrap.appendChild(lab);
            pickers.push({ from: name, ctl: ctl });
        });
        var row = el('div', 'sbs-fix-actions');
        if (phraseBox || pickers.length) {
            var save = el('button', 'btn btn-secondary btn-sm', 'Save');
            save.type = 'button';
            save.addEventListener('click', function () {
                var phrases = phraseBox ? phraseBox.value.split(/\r?\n/).map(function (x) { return x.replace(/\s+/g, ' ').trim(); }).filter(Boolean) : null;
                if (phraseBox && !phrases.length) { status.textContent = 'Type the phrase you say.'; status.className = 'cf-status-line is-bad'; return; }
                var picks = pickers.map(function (x) { return { from: x.from, to: String(x.ctl.value || '').trim() }; }).filter(function (x) { return x.to; });
                saveFix(a, function (body) {
                    var did = false;
                    if (phrases) { body.trigger_config = Object.assign({}, body.trigger_config, { phrases: phrases.slice(0, 20) }); did = true; }
                    picks.forEach(function (x) { eachStep(body.actions, function (s) { if (s.source === x.from) { s.source = x.to; did = true; } }); });
                    return did;
                }, status, { phrase: !!phrases });
            });
            row.appendChild(save);
        }
        if (a.streamStop) {
            var start = el('button', 'btn btn-secondary btn-sm', 'Change to start');
            start.type = 'button';
            start.title = 'Makes the stream step start the stream instead of stopping it';
            start.addEventListener('click', function () {
                saveFix(a, function (body) {
                    var did = false;
                    eachStep(body.actions, function (s) { if (s.type === 'obs.stream' && s.state === 'stop') { s.state = 'start'; did = true; } });
                    return did;
                }, status, {});
            });
            row.appendChild(start);
        }
        row.appendChild(status);
        wrap.appendChild(row);
        return (phraseBox || pickers.length || a.streamStop) ? wrap : null;
    }

    function draw(p) {
        while (box.firstChild) box.removeChild(box.firstChild);
        box.setAttribute('aria-busy', 'false');
        var all = p.automations.concat(p.commands, p.timers);
        var on = all.filter(function (x) { return x.state === 'turn_on'; });
        var attn = p.automations.filter(function (x) { return x.state === 'attention'; });
        var edited = all.filter(function (x) { return x.state === 'edited'; });
        var already = all.filter(function (x) { return x.state === 'already_on'; });
        var srcOff = all.filter(function (x) { return x.state === 'source_off'; });
        var counts = el('p', 'sbs-counts', 'Turns on ' + plural(on.filter(function (x) { return x.key[0] === 'a'; }).length, 'automation', 'automations') + ' (' + plural(p.counts.songs || 0, 'song request command', 'song request commands') + '), '
            + plural(on.filter(function (x) { return x.key[0] === 'c'; }).length, 'chat command', 'chat commands') + ' and ' + plural(on.filter(function (x) { return x.key[0] === 't'; }).length, 'timer', 'timers')
            + (p.channelSwitches.length ? ', and the Chat commands switch for ' + plural(p.channelSwitches.filter(function (x) { return x.state === 'turn_on'; }).length, 'channel', 'channels') : '')
            + '; ' + plural(p.counts.obsChanges || 0, 'OBS overlay swap', 'OBS overlay swaps') + '. ' + plural(attn.length, 'item needs', 'items need') + ' a look'
            + (srcOff.length ? '; ' + plural(srcOff.length, 'item was', 'items were') + ' off in Firebot or Streamer.bot and stays off' : '') + '.');
        var cg = el('div', 'sbs-group'); cg.appendChild(counts); box.appendChild(cg);

        var v = p.voice || {};
        if (v.blocking) {
            var gb = group('Voice commands cannot be turned on yet', v.blocking);
            gb.className += ' sbs-blocking';
            gb.setAttribute('role', 'alert');
        } else if (v.step === 'enable') {
            var gv = group('Voice commands', plural(v.on, 'voice command goes', 'voice commands go') + ' on. Switch over also turns on Voice commands in CertiFried Studio'
                + (v.studio.state ? ' (it is ' + (VOICE_STATE[v.studio.state] || v.studio.state) + ' now)' : '') + ' and loads your phrases. Streamer.bot is only closed once Studio says it is listening.');
            if (v.streamerbotThreshold != null) {
                // Never copied (2026-11-20): Studio's recogniser scores speech differently from Streamer.bot's.
                gv.appendChild(el('p', null, 'Streamer.bot was set to ' + Math.round(v.streamerbotThreshold * 100) + '% sure. That number is not copied: Studio scores speech differently, and at a Streamer.bot-style setting it runs commands nobody said. Studio keeps its own setting'
                    + (v.studio.threshold != null ? ' (' + Math.round(v.studio.threshold * 100) + '% now)' : ' (' + Math.round((v.studioDefault || 0.7) * 100) + '% unless you changed it)') + '. Change it in Studio, Voice.'));
            }
        }
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
                var fix = fixPanel(a, v.obsSources || []);
                if (fix) li.appendChild(fix);
                ul.appendChild(li);
            });
            ga.appendChild(ul);
        }
        if (srcOff.length) {
            var gs = group('Off in Firebot or Streamer.bot (stays off unless you tick it)', 'You had these switched off there, so the switchover keeps them off. Tick one to turn it on as well.');
            var uls = el('ul', 'sbs-attn');
            srcOff.forEach(function (a) {
                var li = el('li');
                var lab = el('label');
                var cb = document.createElement('input');
                cb.type = 'checkbox'; cb.setAttribute('data-include', a.key);
                lab.appendChild(cb);
                if (a.key[0] === 'a') { var lk = el('a', null, nameOf(a)); lk.href = '/stream/bot/automations/' + encodeURIComponent(a.id); lab.appendChild(lk); }
                else lab.appendChild(document.createTextNode(' ' + nameOf(a) + (a.key[0] === 't' ? ' (timer)' : ' (chat command)')));
                li.appendChild(lab);
                uls.appendChild(li);
            });
            gs.appendChild(uls);
        }
        if (on.length || p.channelSwitches.some(function (x) { return x.state === 'turn_on'; })) {
            var details = el('details', 'cf-expand');
            details.appendChild(el('summary', null, 'Turned on (' + (on.length + p.channelSwitches.filter(function (x) { return x.state === 'turn_on'; }).length) + ')'));
            var body = el('div', 'cf-expand-body');
            var ul2 = el('ul', 'sbs-list');
            on.forEach(function (x) { ul2.appendChild(el('li', null, nameOf(x) + (x.songs ? ', song requests' : ''))); });
            p.channelSwitches.filter(function (x) { return x.state === 'turn_on'; }).forEach(function (x) { ul2.appendChild(el('li', null, x.name + (x.platform ? ' (' + (x.platform === 'kick' ? 'Kick' : 'Twitch') + ')' : ''))); });
            body.appendChild(ul2);
            details.appendChild(body);
            var gon = group('What it turns on', p.counts.songs ? 'Song request commands make CertiFried Studio keep the music off your Twitch VOD while they are on.' : '');
            gon.appendChild(details);
        }
        if ((p.rewrites || []).length) {
            var gr = group('Steps pointed at the CertiFried overlay', 'These steps show or hide a source the switchover replaces. They are changed to the CertiFried source; Undo puts them back.');
            list(gr, p.rewrites, function (r) { return r.name + ': ' + r.hits.map(function (h) { return h.from + ' to ' + h.to; }).join(', '); });
        }
        if (p.channelSwitches.some(function (x) { return x.state === 'held'; })) {
            list(group('Chat commands stay off for a channel until you tick one of its held commands', ''), p.channelSwitches.filter(function (x) { return x.state === 'held'; }), function (x) { return x.name; });
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
        var vt = document.getElementById('sbs-vthresh');
        call('POST', '/stream/bot/api/switchover/apply', { include: include, obs: document.getElementById('sbs-obs').checked, closeApps: document.getElementById('sbs-close').checked, voiceThreshold: !!(vt && vt.checked) }).then(function (r) {
            if (!r.ok) { say('sbs-go-status', (r.data && r.data.error) || 'The switchover failed.', 'bad'); goBtn.disabled = false; return; }
            var res = r.data.result || {};
            var text = 'Done: ' + plural(res.automations || 0, 'automation', 'automations') + ', ' + plural(res.commands || 0, 'command', 'commands') + ' and ' + plural(res.timers || 0, 'timer', 'timers') + ' on.';
            if (res.channels) text += ' Chat commands on for ' + plural(res.channels, 'channel', 'channels') + '.';
            if (res.steps) text += ' ' + plural(res.steps, 'OBS step', 'OBS steps') + ' pointed at the CertiFried overlay.';
            if (res.voice) text += res.voice.status === 'acked' ? ' Voice commands in Studio: ' + (VOICE_STATE[res.voice.state] || res.voice.state || 'no answer') + (res.voice.state === 'error' && res.voice.detail ? ' (' + res.voice.detail + ')' : '') + '.' : ' ' + (res.voice.error || 'Studio did not turn on voice commands.');
            if (res.apps && res.apps.status === 'refused') text += ' ' + res.apps.error;
            if (res.stepsSkipped) text += ' The OBS steps were left as they were because the OBS swap did not complete.';
            if (res.error) text += ' It stopped part way (' + res.error + '). Undo puts back what it did.';
            if (res.obs) {
                var bad = (res.obs.changes || []).filter(function (c) { return !c.ok; }).length;
                text += res.obs.status !== 'acked' ? ' OBS did not confirm the swap (' + (res.obs.error || 'no answer') + '), so it was not recorded: check your scenes in OBS.'
                    : bad ? ' OBS swapped, but ' + plural(bad, 'change', 'changes') + ' failed.' : ' OBS overlays swapped.';
            }
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
