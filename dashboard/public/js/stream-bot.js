/*
 * Stream bot pages (/stream/bot, dashboard/views/stream-bot/). One script; <main data-sb-page> says which part runs.
 *
 *   overview     live feed from GET /stream/bot/api/feed (Server-Sent Events)
 *   automations  on/off switches
 *   editor       the automation editor: trigger, conditions, actions (with nested choices), save, delete, test
 *   connections  link / unlink channels, tip sources, settings
 *   devices      pairing codes, overlay tokens, revoke and delete
 *   sounds       the sound library: upload, play here, delete (Phase 2)
 *
 * The DOM is built with createElement and textContent only: event text, names and messages come from viewers
 * and are never parsed as markup. Page data is read from <script type="application/json" id="sb-data">.
 * /js/csrf.js (loaded first) adds the CSRF header to every state-changing fetch.
 */
(function () {
    'use strict';
    var main = document.getElementById('main-content');
    if (!main) return;
    var page = main.getAttribute('data-sb-page') || '';

    // ── helpers ────────────────────────────────────────────────────────────────────────────
    var seq = 0;
    function uid(p) { seq += 1; return 'sb-' + p + '-' + seq; }

    /** el('div', { className, id, text, attrs: {}, on: { click: fn } }, [children]) */
    function el(tag, props, children) {
        var n = document.createElement(tag);
        props = props || {};
        if (props.className) n.className = props.className;
        if (props.id) n.id = props.id;
        if (props.text != null) n.textContent = String(props.text);
        if (props.attrs) Object.keys(props.attrs).forEach(function (k) { if (props.attrs[k] != null && props.attrs[k] !== false) n.setAttribute(k, props.attrs[k] === true ? '' : String(props.attrs[k])); });
        if (props.on) Object.keys(props.on).forEach(function (k) { n.addEventListener(k, props.on[k]); });
        (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
        return n;
    }
    function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
    function readData() {
        var n = document.getElementById('sb-data');
        if (!n) return null;
        try { return JSON.parse(n.textContent); } catch (e) { return null; }
    }
    function call(method, url, body) {
        var headers = { Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        return fetch(url, { method: method, credentials: 'same-origin', headers: headers, body: body === undefined ? undefined : JSON.stringify(body) })
            .then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (data) {
                    return { ok: res.ok && data && data.ok !== false, status: res.status, data: data || {} };
                });
            })
            .catch(function () { return { ok: false, status: 0, data: { error: 'Could not reach CertiFried. Check your connection and try again.' } }; });
    }
    function errorText(r, fallback) {
        if (r.status === 401) return 'You are signed out. Sign in again and retry.';
        if (r.data && r.data.error) return r.data.error;
        if (r.data && Array.isArray(r.data.errors) && r.data.errors.length) return r.data.errors.join(' ');
        return fallback;
    }
    function setStatus(node, text, tone) {
        if (!node) return;
        node.textContent = text || '';
        node.classList.remove('is-ok', 'is-bad', 'is-warn', 'is-busy');
        if (tone) node.classList.add('is-' + tone);
    }
    function localTime(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        try { return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return d.toLocaleString(); }
    }
    /** Server-rendered times are UTC; show them in the reader's own time zone. */
    function localTimes(root) {
        Array.prototype.forEach.call((root || document).querySelectorAll('main time[datetime]'), function (t) {
            var s = localTime(t.getAttribute('datetime'));
            if (s) t.textContent = s;
        });
    }
    function options(select, list, value) {
        list.forEach(function (o) {
            var opt = el('option', { text: o.label, attrs: { value: o.value } });
            if (String(o.value) === String(value)) opt.selected = true;
            select.appendChild(opt);
        });
        return select;
    }

    localTimes(document);

    // ── overview: live feed ────────────────────────────────────────────────────────────────
    function initOverview() {
        var list = document.getElementById('sb-feed');
        var state = document.getElementById('sb-feed-state');
        if (!list) return;
        if (!window.EventSource) { setStatus(state, 'Live updates need a newer browser'); return; }
        var es = new EventSource('/stream/bot/api/feed');
        es.onopen = function () { setStatus(state, 'Live', 'ok'); };
        es.onerror = function () {
            if (es.readyState === 2) setStatus(state, 'Disconnected. Reload the page to reconnect.', 'warn');
            else setStatus(state, 'Reconnecting', 'warn');
        };
        es.addEventListener('closed', function () {
            es.close();
            setStatus(state, 'Paused: the feed is open in too many tabs. Reload to resume.', 'warn');
        });
        es.onmessage = function (m) {
            var ev;
            try { ev = JSON.parse(m.data); } catch (e) { return; }
            if (!ev || !ev.type) return;
            var meta = [ev.typeLabel || ev.type, ev.platformLabel || ev.platform, ev.test ? 'test' : null, localTime(ev.occurredAt)].filter(Boolean).join(' · ');
            var li = el('li', { className: 'sb-feed-item is-new' }, [
                el('span', { className: 'sb-feed-text', text: ev.text || ev.type }),
                el('span', { className: 'sb-feed-meta', text: meta }),
            ]);
            list.insertBefore(li, list.firstChild);
            while (list.children.length > 100) list.removeChild(list.lastChild);
            var empty = document.getElementById('sb-feed-empty');
            if (empty) empty.hidden = true;
            setTimeout(function () { li.classList.remove('is-new'); }, 5000);
        };
        window.addEventListener('pagehide', function () { es.close(); });
    }

    // ── automations list ───────────────────────────────────────────────────────────────────
    function initAutomations() {
        var status = document.getElementById('sb-auto-status');
        initVoiceLog();
        Array.prototype.forEach.call(document.querySelectorAll('[data-toggle-automation]'), function (sw) {
            sw.addEventListener('change', function () {
                var id = sw.getAttribute('data-toggle-automation');
                var want = sw.checked;
                sw.disabled = true;
                call('POST', '/stream/bot/api/automations/' + encodeURIComponent(id) + '/toggle', { enabled: want }).then(function (r) {
                    sw.disabled = false;
                    if (r.ok) setStatus(status, want ? 'Turned on' : 'Turned off', 'ok');
                    else { sw.checked = !want; setStatus(status, errorText(r, 'Could not change it.'), 'bad'); }
                });
            });
        });
    }

    // ── voice log (Studio 0.2.10): what CertiFried Studio heard, as Studio sent it; refreshed every 10 s ─────────────
    var VOICE_OUTCOME = { fired: 'Ran', below: 'Not sure enough', cooldown: 'Waiting (ran recently)', noise: 'Not a command', disabled: 'Automation is off' };
    var VOICE_TONE = { fired: 'is-ok', below: 'is-warn', cooldown: 'is-warn', disabled: 'is-warn', noise: '' };
    function initVoiceLog() {
        var box = document.getElementById('sb-voice-log');
        if (!box) return;
        var body = document.getElementById('sb-voice-log-rows');
        var empty = document.getElementById('sb-voice-log-empty');
        var table = document.getElementById('sb-voice-log-table');
        var note = document.getElementById('sb-voice-log-note');
        var st = document.getElementById('sb-voice-log-status');
        function pct(v) { return Math.round((Number(v) || 0) * 100) + '%'; }
        function when(t) { var d = new Date(t); return isNaN(d) ? '' : d.toLocaleTimeString(); }
        // Studio 0.2.13: teach from a line. "This was <closest>" and "This was..." add the words as how you say a command;
        // "Not a command" stores them as not it; "Wrong, undo learning" forgets the alias that matched and stores the words
        // as not it; Undo takes back what was learned from the line.
        var NEAR_MISS = 0.4;
        var names = {};
        function teach(e, url, payload, done) {
            if (e.id) payload.entryId = e.id;
            call('POST', url, payload).then(function (r) {
                if (r.ok) { setStatus(st, done, 'ok'); load(); }
                else setStatus(st, errorText(r, 'Could not save that.'), 'bad');
            });
        }
        function cmdName(id) { return names[id] || 'that command'; }
        function teachCell(e) {
            var td = el('td', { className: 'sb-voice-teach' });
            var b = function (label, fn, secondary) { var x = el('button', { className: 'btn btn-sm ' + (secondary ? 'btn-ghost' : 'btn-secondary'), text: label, attrs: { type: 'button' } }); x.addEventListener('click', fn); td.appendChild(x); td.appendChild(document.createTextNode(' ')); };
            var L = e.learned;
            if (L) {
                td.appendChild(el('span', { className: 'cf-list-meta', text: (L.kind === 'alias' ? 'Learned as ' + cmdName(L.automationId) : 'Marked not ' + cmdName(L.automationId)) + '. ' }));
                b('Undo', function () {
                    if (L.undid) teach(e, '/stream/bot/api/voice/learn', { automationId: L.automationId, kind: L.undid.kind, text: L.undid.text, undo: { kind: L.kind, text: L.text } }, 'Undone.');
                    else teach(e, '/stream/bot/api/voice/unlearn', { automationId: L.automationId, kind: L.kind, text: L.text }, 'Undone.');
                }, true);
                return td;
            }
            if (!e.heard) return td;
            var ran = e.outcome === 'fired' || e.outcome === 'cooldown';
            if (ran) {
                if (e.automationId) b('Wrong, undo learning', function () {
                    teach(e, '/stream/bot/api/voice/learn', { automationId: e.automationId, kind: 'negative', text: e.heard, undo: e.via === 'alias' && e.alias ? { kind: 'alias', text: e.alias } : null },
                        'Undone: ' + cmdName(e.automationId) + ' will not run for these words again.');
                });
                return td;
            }
            var cid = e.closestAutomationId || e.automationId;
            if (cid && (Number(e.confidence) || 0) >= NEAR_MISS) b('This was ' + cmdName(cid), function () { teach(e, '/stream/bot/api/voice/learn', { automationId: cid, kind: 'alias', text: e.heard }, 'Learned: this is how you say ' + cmdName(cid) + '.'); });
            var ids = Object.keys(names);
            if (ids.length) {
                var pick = el('select', { className: 'sb-voice-pick', attrs: { 'aria-label': 'This was a voice command' } }, [el('option', { text: 'This was...', attrs: { value: '' } })].concat(ids.map(function (id) { return el('option', { text: names[id], attrs: { value: id } }); })));
                pick.addEventListener('change', function () { if (pick.value) teach(e, '/stream/bot/api/voice/learn', { automationId: Number(pick.value), kind: 'alias', text: e.heard }, 'Learned: this is how you say ' + cmdName(pick.value) + '.'); });
                td.appendChild(pick);
                td.appendChild(document.createTextNode(' '));
            }
            if (cid) b('Not a command', function () { teach(e, '/stream/bot/api/voice/learn', { automationId: cid, kind: 'negative', text: e.heard }, 'Learned: this is not ' + cmdName(cid) + '.'); }, true);
            return td;
        }
        function load() {
            call('GET', '/stream/bot/api/voice/log').then(function (r) {
                if (!r.ok) { setStatus(st, errorText(r, 'Could not load the voice log.'), 'bad'); return; }
                var d = r.data;
                names = d.names || {};
                clear(body);
                (d.entries || []).forEach(function (e) {
                    var cmdId = e.automationId || e.closestAutomationId;
                    var name = cmdId ? names[cmdId] : '';
                    var phrase = e.phrase || e.closest || '';
                    body.appendChild(el('tr', null, [
                        el('td', { text: when(e.t) }),
                        el('td', { text: e.heard ? '"' + e.heard + '"' : (e.outcome === 'noise' ? 'Not a command (words not shared)' : '') }),
                        el('td', { text: phrase + (name && name !== phrase ? ' (' + name + ')' : '') + (e.via === 'alias' && e.phrase ? ', how you say it' : '') }),
                        el('td', { text: pct(e.confidence) + (e.threshold != null ? ' of ' + pct(e.threshold) : '') }),
                        el('td', null, [el('span', { className: 'cf-pill ' + (VOICE_TONE[e.outcome] || ''), text: VOICE_OUTCOME[e.outcome] || e.outcome })]),
                        teachCell(e),
                    ]));
                });
                var n = (d.entries || []).length;
                table.hidden = !n;
                empty.hidden = !!n;
                note.textContent = d.studio && d.studio.connected
                    ? (d.studio.voiceLog ? 'CertiFried Studio ' + (d.studio.version || '') + ' is connected' + (d.studio.threshold != null ? ', set to ' + pct(d.studio.threshold) + ' sure' : '') + '.' : 'Update CertiFried Studio to 0.2.10 or later to see what it heard here.')
                    : 'CertiFried Studio is not connected. The list fills while it is open and listening.';
            });
        }
        var clearBtn = document.getElementById('sb-voice-log-clear');
        if (clearBtn) clearBtn.addEventListener('click', function () {
            call('DELETE', '/stream/bot/api/voice/log').then(function (r) {
                if (r.ok) { setStatus(st, 'Cleared here. Studio keeps its own list until you clear it there.', 'ok'); load(); }
                else setStatus(st, errorText(r, 'Could not clear it.'), 'bad');
            });
        });
        load();
        setInterval(function () { if (!document.hidden) load(); }, 10000);
    }

    // ── editor ─────────────────────────────────────────────────────────────────────────────
    var PLATFORM = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', streamelements: 'StreamElements', streamlabs: 'Streamlabs', kofi: 'Ko-fi', bmac: 'Buy Me a Coffee', throne: 'Throne', fourthwall: 'Fourthwall', studio: 'CertiFried Studio', bot: 'Stream bot', test: 'Test' };
    // Power-up or Bits trigger, Counter changed trigger, If checks (2026-11-19 stream actions).
    var BITS_KIND = { any: 'Any use of Bits', cheer: 'Cheers only', power_up: 'Any power-up', custom_power_up: 'Your own (custom) power-ups', combo: 'Combos', message_effect: 'Power-up: message effect', celebration: 'Power-up: celebration', gigantify_an_emote: 'Power-up: giant emote' };
    var CHECK_LABEL = { role: 'The viewer\'s role', amount: 'The amount', text: 'The message, name or reward', metadata: 'An event detail or argument' };
    var MODE = { command: 'A command, like !hello', contains: 'Message contains', exact: 'Message is exactly', starts: 'Message starts with', word: 'Message has the word', regex: 'Message matches a pattern' };
    var ROLE = { everyone: 'Everyone', broadcaster: 'Broadcaster', moderator: 'Moderator', vip: 'VIP', subscriber: 'Subscriber' };
    var OPTION = {
        platform: { event: 'Where the event came from', twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube (while you are live)', all: 'All your linked channels' },
        scope: { channel: 'Your channel', user: 'The viewer' },
        visible: { show: 'Show', hide: 'Hide', toggle: 'Switch' },
        state: {
            start: 'Start', stop: 'Stop', toggle: 'Switch', pause: 'Pause', resume: 'Resume', toggle_pause: 'Pause or resume',
            save: 'Save the replay', mute: 'Mute', unmute: 'Unmute', enable: 'Turn on', disable: 'Turn off',
        },
        mode: { overlap: 'Play at the same time', queue: 'Play after it' },
        length: { 30: '30 seconds', 60: '1 minute', 90: '1 minute 30', 120: '2 minutes', 150: '2 minutes 30', 180: '3 minutes' },
        show: { show: 'End it and show the result', archive: 'End it and hide the result' },
        action: { resolve: 'Resolve: pick the winner', lock: 'Lock: no new predictions', cancel: 'Cancel: give the points back' },
        color: { primary: 'Your channel colour', blue: 'Blue', green: 'Green', orange: 'Orange', purple: 'Purple' },
    };
    var COND_DEFAULT = {
        role: function () { return { type: 'role', roles: ['subscriber'], mode: 'any' }; },
        amount: function () { return { type: 'amount', min: '', max: '', currency: '' }; },
        text: function () { return { type: 'text', field: 'message', mode: 'contains', text: '', caseSensitive: false }; },
        metadata: function () { return { type: 'metadata', path: '', op: 'eq', value: '' }; },
        cooldown: function () { return { type: 'cooldown', scope: 'global', seconds: 30 }; },
        rate_limit: function () { return { type: 'rate_limit', scope: 'global', count: 3, windowSeconds: 60 }; },
    };
    var MAX_CONDITIONS = 10, MAX_STEPS = 25, MAX_DEPTH = 3, MAX_BRANCHES = 10;

    function initEditor() {
        var D = readData();
        if (!D || !D.catalog) return;
        var C = D.catalog;
        var ACT = {};
        C.actions.forEach(function (a) { ACT[a.type] = a; });
        var EVT = {};
        C.events.forEach(function (e) { EVT[e.type] = e; });
        var CONDLABEL = {};
        C.conditions.forEach(function (c) { CONDLABEL[c.type] = c; });
        var channelCache = Object.assign({}, D.guildChannels || {});
        var ST = D.studio || null;

        // Overlays and media (Phase 3) for the overlay actions, read once from /stream/bot/api/overlays/choices.
        var OVL = { overlays: null, media: [], loading: null };
        function overlayChoices() {
            if (OVL.loading) return OVL.loading;
            OVL.loading = call('GET', '/stream/bot/api/overlays/choices').then(function (r) {
                OVL.overlays = r.ok ? (r.data.overlays || []) : [];
                OVL.media = r.ok ? (r.data.media || []) : [];
                return OVL;
            });
            return OVL.loading;
        }
        // Lights, presets and Voicemeeter (Phase 5) for the light and Voicemeeter actions, read once from /stream/bot/api/devices/choices.
        var DEV = { data: null, loading: null };
        function deviceChoices() {
            if (DEV.loading) return DEV.loading;
            DEV.loading = call('GET', '/stream/bot/api/devices/choices').then(function (r) {
                DEV.data = r.ok ? r.data : { lights: [], presets: [], vm: { targets: [], profiles: [] } };
                return DEV.data;
            });
            return DEV.loading;
        }
        /** A select filled from deviceChoices(); keeps a saved value that is not reported now. */
        function deviceSelect(step, f, list, emptyText, missingText, allText) {
            var s = el('select');
            function fill() {
                clear(s);
                var items = list() || [];
                if (allText) s.appendChild(el('option', { text: allText, attrs: { value: '' } }));
                else s.appendChild(el('option', { text: DEV.data ? (items.length ? 'Pick one' : emptyText) : 'Loading', attrs: { value: '' } }));
                options(s, items, step[f.name]);
                if (step[f.name] && !items.some(function (x) { return String(x.value) === String(step[f.name]); })) {
                    s.appendChild(el('option', { text: missingText + ' (' + step[f.name] + ')', attrs: { value: String(step[f.name]) } }));
                    s.value = String(step[f.name]);
                }
            }
            fill();
            deviceChoices().then(fill);
            s.addEventListener('change', function () { step[f.name] = s.value; });
            return s;
        }
        /** Names CertiFried Studio reported for a suggest kind (scenes, sources, inputs ...), given the step's other fields. */
        function suggestions(kind, step) {
            var obs = ST && ST.obs;
            var uniq = function (list) { var seen = {}; return list.filter(function (x) { if (!x || seen[x]) return false; seen[x] = true; return true; }); };
            if (kind === 'sounds') return uniq((ST && ST.sounds) || []);
            if (kind === 'media') { overlayChoices(); return uniq(OVL.media || []); }
            if (kind === 'lightScenes') {
                deviceChoices();
                var lt = ((DEV.data && DEV.data.lights) || []).filter(function (x) { return x.value === step.device; })[0];
                return uniq(lt ? lt.scenes || [] : []);
            }
            if (!obs) return [];
            var src = obs.sources || {};
            var allItems = function () { var out = []; Object.keys(src).forEach(function (k) { out = out.concat(src[k] || []); }); return out; };
            var inputs = obs.inputs || [];
            var filters = obs.filters || {};
            switch (kind) {
                case 'scenes': return uniq(obs.scenes || []);
                case 'sources': return uniq(step.scene && src[step.scene] ? src[step.scene] : allItems());
                case 'scenesAndSources': return uniq((obs.scenes || []).concat(allItems()));
                case 'inputs': return uniq(inputs.map(function (i) { return i.name; }));
                case 'textSources': return uniq(inputs.filter(function (i) { return /^text_/.test(i.kind || ''); }).map(function (i) { return i.name; }));
                case 'browserSources': return uniq(inputs.filter(function (i) { return i.kind === 'browser_source'; }).map(function (i) { return i.name; }));
                case 'filterSources': return uniq(Object.keys(filters));
                case 'filters': {
                    if (step.source && filters[step.source]) return uniq(filters[step.source]);
                    var all = [];
                    Object.keys(filters).forEach(function (k) { all = all.concat(filters[k] || []); });
                    return uniq(all);
                }
                default: return [];
            }
        }
        /** A text input with a <datalist> of reported names, refreshed on focus (it follows the scene or source picked). */
        function suggestInput(step, f, set) {
            var listId = uid('dl');
            var dl = el('datalist', { id: listId });
            var i = textInput(step[f.name], set, { maxlength: 300, spellcheck: 'false', list: listId });
            function fill() {
                clear(dl);
                suggestions(f.suggest, step).slice(0, 500).forEach(function (n) { dl.appendChild(el('option', { attrs: { value: n } })); });
            }
            fill();
            i.addEventListener('focus', fill);
            return { input: i, list: dl };
        }

        var src = D.automation || { id: null, name: '', enabled: true, trigger_type: 'follow', trigger_config: {}, conditions: [], actions: [] };
        var cfg = src.trigger_config || {};
        var S = {
            id: src.id, name: src.name || '', enabled: src.enabled !== false, trigger: EVT[src.trigger_type] ? src.trigger_type : 'follow',
            platforms: Array.isArray(cfg.platforms) ? cfg.platforms.slice() : [],
            match: { mode: (cfg.match && cfg.match.mode) || 'command', text: (cfg.match && cfg.match.text) || '', caseSensitive: !!(cfg.match && cfg.match.caseSensitive) },
            phrases: Array.isArray(cfg.phrases) ? cfg.phrases.join('\n') : '',
            // Studio 0.2.10: this voice command's own confidence (percent; empty = Studio's setting) and wait before it runs again.
            voiceConf: cfg.confidence != null ? String(Math.round(Number(cfg.confidence) * 100)) : '',
            voiceWait: cfg.cooldownSec != null ? String(cfg.cooldownSec) : '',
            bitsKind: cfg.bitsKind || 'any', varKey: cfg.key || '', varScope: cfg.scope || 'any',
            // Wave 2 (core/stream-bot/control): trigger settings from the catalogue (viewer step, ad minutes …) and the action queue.
            extra: Object.assign({}, cfg), queueName: (cfg.queue && cfg.queue.name) || '', queueBlocking: !(cfg.queue && cfg.queue.blocking === false),
            conditions: JSON.parse(JSON.stringify(src.conditions || [])),
            actions: JSON.parse(JSON.stringify(src.actions || [])),
        };
        var dirty = false;
        // Studio 0.2.13: what Studio learned about how you say this command. Removing one saves at once (not with the form).
        var learned = { aliases: Array.isArray(cfg.aliases) ? cfg.aliases.slice() : [], negatives: Array.isArray(cfg.negatives) ? cfg.negatives.slice() : [], trained: cfg.trained || null };
        function heardAsBlock() {
            var box = el('div', { className: 'sb-block sb-heard-as' });
            var msg = el('span', { className: 'cf-status-line', attrs: { role: 'status', 'aria-live': 'polite' } });
            function list(kind, items, empty) {
                var ul = el('ul', { className: 'sb-heard-list' });
                if (!items.length) ul.appendChild(el('li', { className: 'cf-list-meta', text: empty }));
                items.forEach(function (x) {
                    var rm = el('button', { className: 'btn btn-secondary btn-sm', text: 'Remove', attrs: { type: 'button', 'aria-label': 'Remove "' + x.text + '"' } });
                    rm.addEventListener('click', function () {
                        rm.disabled = true;
                        call('POST', '/stream/bot/api/voice/unlearn', { automationId: S.id, kind: kind, text: x.text }).then(function (r) {
                            if (!r.ok) { rm.disabled = false; setStatus(msg, errorText(r, 'Could not remove it.'), 'bad'); return; }
                            learned.aliases = r.data.aliases || [];
                            learned.negatives = r.data.negatives || [];
                            var fresh = heardAsBlock();
                            box.parentNode.replaceChild(fresh, box);
                        });
                    });
                    ul.appendChild(el('li', null, [el('span', { text: '"' + x.text + '"' + (kind === 'alias' && x.count > 1 ? ' (' + x.count + ' times)' : '') }), ' ', rm]));
                });
                return ul;
            }
            var t = learned.trained;
            box.appendChild(el('h3', { className: 'sb-block-title', text: 'Heard as' }));
            box.appendChild(el('p', { className: 'cf-list-meta', text: 'How Whisper writes this command when you say it. CertiFried Studio learns these when you use "Teach Studio how you say it" or "This was ..." in the voice log, and counts them as this command.' + (t && t.at ? ' Taught in Studio on ' + new Date(t.at).toLocaleDateString() + (t.takes ? ' from ' + t.takes + ' takes' : '') + '.' : '') }));
            box.appendChild(list('alias', learned.aliases, 'Nothing yet.'));
            box.appendChild(el('h3', { className: 'sb-block-title', text: 'Not this command' }));
            box.appendChild(el('p', { className: 'cf-list-meta', text: 'Things you said that were marked "Not a command". Studio is less sure when it hears words close to these.' }));
            box.appendChild(list('negative', learned.negatives, 'Nothing yet.'));
            box.appendChild(msg);
            return box;
        }
        var focusKey = null;

        var form = document.getElementById('sb-editor');
        var nameIn = document.getElementById('sb-name');
        var enabledIn = document.getElementById('sb-enabled');
        var trigBox = document.getElementById('sb-trigger');
        var condBox = document.getElementById('sb-conditions');
        var actBox = document.getElementById('sb-actions');
        var saveStatus = document.getElementById('sb-save-status');
        var errBox = document.getElementById('sb-errors');
        var errList = document.getElementById('sb-errors-list');
        var warnBox = document.getElementById('sb-warnings');
        var warnList = document.getElementById('sb-warnings-list');
        var delBtn = document.getElementById('sb-delete');
        var testSec = document.getElementById('sb-test');
        var titleEl = document.getElementById('sb-editor-title');

        nameIn.value = S.name;
        enabledIn.checked = S.enabled;
        nameIn.addEventListener('input', function () { S.name = nameIn.value; dirty = true; });
        enabledIn.addEventListener('change', function () { S.enabled = enabledIn.checked; dirty = true; });
        form.addEventListener('input', function () { dirty = true; });

        function restoreFocus(root) {
            if (!focusKey) return;
            var n = root.querySelector('[data-focus="' + focusKey + '"]');
            focusKey = null;
            if (n) n.focus();
        }

        /** A labelled field. `control` is an input/select/textarea (an id is given to it) or a fieldset body. */
        function field(label, control, opts) {
            opts = opts || {};
            var id = control.id || uid('f');
            control.id = id;
            var hintId = opts.hint ? uid('h') : null;
            if (hintId) control.setAttribute('aria-describedby', hintId);
            return el('div', { className: 'sb-field' + (opts.wide ? ' is-wide' : '') }, [
                el('label', { text: label, attrs: { for: id } }),
                control,
                opts.hint ? el('p', { className: 'sb-field-hint', id: hintId, text: opts.hint }) : null,
            ]);
        }
        function checkGroup(legend, items, hint) {
            var fs = el('fieldset', { className: 'sb-field is-wide' }, [el('legend', { text: legend })]);
            var box = el('div', { className: 'sb-checks' });
            items.forEach(function (it) {
                var id = uid('c');
                var cb = el('input', { id: id, attrs: { type: 'checkbox' } });
                cb.checked = !!it.checked;
                cb.addEventListener('change', function () { it.onChange(cb.checked); dirty = true; });
                box.appendChild(el('label', { className: 'sb-check', attrs: { for: id } }, [cb, it.label]));
            });
            fs.appendChild(box);
            if (hint) fs.appendChild(el('p', { className: 'sb-field-hint', text: hint }));
            return fs;
        }
        function textInput(value, onInput, attrs) {
            var i = el('input', { attrs: Object.assign({ type: 'text', autocomplete: 'off' }, attrs || {}) });
            i.value = value == null ? '' : String(value);
            i.addEventListener('input', function () { onInput(i.value); });
            return i;
        }
        function numberInput(value, onInput, attrs) {
            var i = el('input', { attrs: Object.assign({ type: 'number', step: 'any', inputmode: 'decimal' }, attrs || {}) });
            i.value = value == null ? '' : String(value);
            i.addEventListener('input', function () { onInput(i.value); });
            return i;
        }
        function selectInput(list, value, onChange) {
            var s = options(el('select'), list, value);
            s.addEventListener('change', function () { onChange(s.value); });
            return s;
        }
        function headingTag(depth, extra) { return 'h' + Math.min(6, 3 + depth * 2 + (extra || 0)); }

        // ── trigger ──
        function renderTrigger() {
            clear(trigBox);
            var def = EVT[S.trigger];
            var groups = [];
            var byGroup = {};
            C.events.forEach(function (e) {
                if (!byGroup[e.group]) { byGroup[e.group] = []; groups.push(e.group); }
                byGroup[e.group].push(e);
            });
            var sel = el('select', { id: 'sb-trigger-type', attrs: { 'data-focus': 'trigger' } });
            groups.forEach(function (g) {
                var og = el('optgroup', { attrs: { label: g } });
                byGroup[g].forEach(function (e) {
                    var o = el('option', { text: e.label, attrs: { value: e.type } });
                    if (e.type === S.trigger) o.selected = true;
                    og.appendChild(o);
                });
                sel.appendChild(og);
            });
            sel.addEventListener('change', function () {
                S.trigger = sel.value;
                var allowed = EVT[S.trigger].platforms;
                S.platforms = S.platforms.filter(function (p) { return allowed.indexOf(p) >= 0; });
                dirty = true;
                focusKey = 'trigger';
                renderTrigger();
                renderActions();
            });
            var linked = (D.linkedPlatforms || []).filter(function (p) { return def.platforms.indexOf(p) >= 0; });
            var TIPS = ['streamelements', 'streamlabs', 'kofi', 'bmac', 'throne', 'fourthwall'];
            var tip = def.platforms.every(function (p) { return TIPS.indexOf(p) >= 0; });
            var hint = tip ? 'Comes from the tip services you add on the Connections page.'
                : def.platforms.indexOf('studio') >= 0 ? 'Comes from CertiFried Studio on your PC.'
                : def.platforms.indexOf('bot') >= 0 ? 'Raised by the stream bot itself when one of your stored values changes.'
                : (linked.length ? null : 'None of your linked channels sends this event yet. Link one on the Connections page.');
            var row = el('div', { className: 'sb-block' }, [el('div', { className: 'sb-fields' }, [field('Event', sel, { hint: hint })])]);
            trigBox.appendChild(row);

            if (def.platforms.length > 1) {
                var fs = checkGroup('Only from', def.platforms.map(function (p) {
                    return { label: PLATFORM[p] || p, checked: S.platforms.indexOf(p) >= 0, onChange: function (on) {
                        S.platforms = S.platforms.filter(function (x) { return x !== p; });
                        if (on) S.platforms.push(p);
                    } };
                }), 'Leave all unticked to take it from anywhere.');
                trigBox.appendChild(el('div', { className: 'sb-block' }, [el('div', { className: 'sb-fields' }, [fs])]));
            }

            if (S.trigger === 'chat') {
                var mode = selectInput(C.matchModes.map(function (m) { return { value: m, label: MODE[m] || m }; }), S.match.mode, function (v) { S.match.mode = v; dirty = true; });
                var txt = textInput(S.match.text, function (v) { S.match.text = v; }, { maxlength: 200 });
                var cs = el('input', { id: uid('c'), attrs: { type: 'checkbox' } });
                cs.checked = S.match.caseSensitive;
                cs.addEventListener('change', function () { S.match.caseSensitive = cs.checked; dirty = true; });
                trigBox.appendChild(el('div', { className: 'sb-block' }, [el('div', { className: 'sb-fields' }, [
                    field('Listen for', mode),
                    field('Text', txt, { hint: 'For a command, the word after the ! (with or without it). Patterns are limited to 200 characters.' }),
                    el('div', { className: 'sb-field' }, [el('span', { className: 'sb-field-label', text: 'Case' }), el('label', { className: 'sb-check', attrs: { for: cs.id } }, [cs, 'Match capital letters exactly'])]),
                ])]));
            }
            if (S.trigger === 'voice.phrase') {
                var ph = el('textarea', { id: uid('v'), attrs: { rows: '4', maxlength: '2200', spellcheck: 'false' } });
                ph.value = S.phrases;
                ph.addEventListener('input', function () { S.phrases = ph.value; dirty = true; });
                var vc = numberInput(S.voiceConf, function (v) { S.voiceConf = v; dirty = true; }, { min: '20', max: '95', step: '5', placeholder: 'Studio setting' });
                var vw = numberInput(S.voiceWait, function (v) { S.voiceWait = v; dirty = true; }, { min: '0', max: '3600', step: '1', placeholder: '10' });
                trigBox.appendChild(el('div', { className: 'sb-block' }, [el('div', { className: 'sb-fields' }, [
                    field('Phrases, one per line (up to 20)', ph, { hint: 'Say one of these near your microphone while CertiFried Studio is listening. Recognised on your PC; no audio leaves it.' }),
                    field('How sure, in % (optional)', vc, { hint: 'Leave empty to use the setting in Studio (70% unless you changed it). Raise it if this command runs when you did not say it; lower it a little if it is often missed. Needs Studio 0.2.10.' }),
                    field('Wait before it can run again, in seconds', vw, { hint: 'Empty means 10 seconds. Saying it again sooner is shown in the voice log as waiting. Needs Studio 0.2.10.' }),
                ])]));
                if (S.id) trigBox.appendChild(heardAsBlock());
            }
            if (S.trigger === 'bits.used') {
                var bk = selectInput(Object.keys(BITS_KIND).map(function (k) { return { value: k, label: BITS_KIND[k] }; }), S.bitsKind, function (v) { S.bitsKind = v; dirty = true; });
                trigBox.appendChild(el('div', { className: 'sb-block' }, [el('div', { className: 'sb-fields' }, [
                    field('Which uses', bk, { hint: 'Add an Amount range condition to react only to bigger uses.' }),
                ])]));
            }
            if (S.trigger === 'variable.changed') {
                var vk = textInput(S.varKey, function (v) { S.varKey = v; }, { maxlength: 64, spellcheck: 'false' });
                var vs = selectInput([{ value: 'any', label: 'Channel and viewer values' }, { value: 'channel', label: 'Channel values ({sdb:})' }, { value: 'viewer', label: 'Viewer values ({db:})' }], S.varScope, function (v) { S.varScope = v; dirty = true; });
                trigBox.appendChild(el('div', { className: 'sb-block' }, [el('div', { className: 'sb-fields' }, [
                    field('Name', vk, { hint: 'Such as deaths. Empty: any value. Changes made by this kind of automation count up to three in a row, then stop, so a loop cannot run away.' }),
                    field('Which values', vs),
                ])]));
            }
            // Trigger settings from the catalogue (core/stream-bot/control): number, select and text fields.
            if (def.config && def.config.length) {
                var cfgFields = def.config.map(function (fd) {
                    if (S.extra[fd.name] === undefined && fd.default !== undefined) S.extra[fd.name] = fd.default;
                    var setX = function (v) { S.extra[fd.name] = v; dirty = true; };
                    var ctl = fd.kind === 'number' ? numberInput(S.extra[fd.name], setX, { min: fd.min, max: fd.max, step: 1 })
                        : fd.kind === 'select' ? selectInput(fd.options.map(function (o) { return { value: o, label: (fd.optionLabels || {})[o] || o }; }), S.extra[fd.name], setX)
                            : textInput(S.extra[fd.name], setX, { maxlength: 200 });
                    return field(fd.label, ctl, { hint: fd.help || null });
                });
                trigBox.appendChild(el('div', { className: 'sb-block' }, [el('div', { className: 'sb-fields' }, cfgFields)]));
            }
            // Action queue: runs of automations in the same "one at a time" queue wait for each other, in order.
            (function () {
                var qn = textInput(S.queueName, function (v) { S.queueName = v; dirty = true; }, { maxlength: 40, spellcheck: 'false' });
                var qb = el('input', { id: uid('c'), attrs: { type: 'checkbox' } });
                qb.checked = S.queueBlocking;
                qb.addEventListener('change', function () { S.queueBlocking = qb.checked; dirty = true; });
                var det = el('details', { className: 'cf-expand' }, [
                    el('summary', { text: S.queueName ? 'Queue: ' + S.queueName : 'Queue (optional)' }),
                    el('div', { className: 'cf-expand-body' }, [el('div', { className: 'sb-fields' }, [
                        field('Queue name', qn, { hint: 'Automations with the same queue name share a queue. Pause, resume or clear it with the queue actions. Empty: no queue.' }),
                        el('div', { className: 'sb-field' }, [el('span', { className: 'sb-field-label', text: 'One at a time' }), el('label', { className: 'sb-check', attrs: { for: qb.id } }, [qb, 'Wait for the run before it to finish'])]),
                    ])]),
                ]);
                if (S.queueName) det.open = true;
                trigBox.appendChild(el('div', { className: 'sb-block' }, [det]));
            })();
            restoreFocus(trigBox);
        }

        // ── conditions ──
        function conditionFields(c) {
            var out = [];
            var set = function (k) { return function (v) { c[k] = v; }; };
            var scopeList = [{ value: 'global', label: 'Everyone together' }, { value: 'user', label: 'Each person' }];
            switch (c.type) {
                case 'role':
                    out.push(checkGroup('Roles', ['everyone'].concat(C.roles).map(function (r) {
                        return { label: ROLE[r] || r, checked: (c.roles || []).indexOf(r) >= 0, onChange: function (on) {
                            c.roles = (c.roles || []).filter(function (x) { return x !== r; });
                            if (on) c.roles.push(r);
                        } };
                    })));
                    out.push(field('The person', selectInput([{ value: 'any', label: 'Has one of these roles' }, { value: 'none', label: 'Has none of these roles' }], c.mode, set('mode'))));
                    break;
                case 'amount':
                    out.push(field('At least', numberInput(c.min, set('min'))));
                    out.push(field('At most', numberInput(c.max, set('max'))));
                    out.push(field('Currency', textInput(c.currency, set('currency'), { maxlength: 12 }), { hint: 'Optional: USD, bits, viewers, months, subs or points.' }));
                    break;
                case 'text':
                    out.push(field('Look in', selectInput([{ value: 'message', label: 'The message' }, { value: 'user', label: 'The name' }, { value: 'reward', label: 'The reward title' }], c.field, set('field'))));
                    out.push(field('How', selectInput(C.matchModes.map(function (m) { return { value: m, label: (MODE[m] || m).replace(/^Message /, '').replace(/^A command, like !hello$/, 'A command') }; }), c.mode, set('mode'))));
                    out.push(field('Text', textInput(c.text, set('text'), { maxlength: 200 })));
                    (function () {
                        var cs = el('input', { id: uid('c'), attrs: { type: 'checkbox' } });
                        cs.checked = !!c.caseSensitive;
                        cs.addEventListener('change', function () { c.caseSensitive = cs.checked; });
                        out.push(el('div', { className: 'sb-field' }, [el('span', { className: 'sb-field-label', text: 'Case' }), el('label', { className: 'sb-check', attrs: { for: cs.id } }, [cs, 'Match capital letters exactly'])]));
                    })();
                    break;
                case 'metadata':
                    out.push(field('Detail', textInput(c.path, set('path'), { maxlength: 100 }), { hint: 'Such as tier, reward, months or isGift.' }));
                    out.push(field('Test', selectInput([{ value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' }, { value: 'contains', label: 'contains' }, { value: 'in', label: 'is one of (separate with |)' }, { value: 'gt', label: 'is more than' }, { value: 'lt', label: 'is less than' }], c.op, set('op'))));
                    out.push(field('Value', textInput(c.value, set('value'), { maxlength: 200 })));
                    break;
                case 'cooldown':
                    out.push(field('Counted for', selectInput(scopeList, c.scope, set('scope'))));
                    out.push(field('Seconds', numberInput(c.seconds, set('seconds'), { min: 1, max: 86400, step: 1 })));
                    break;
                case 'rate_limit':
                    out.push(field('Counted for', selectInput(scopeList, c.scope, set('scope'))));
                    out.push(field('At most', numberInput(c.count, set('count'), { min: 1, max: 1000, step: 1 }), { hint: 'Runs' }));
                    out.push(field('Within seconds', numberInput(c.windowSeconds, set('windowSeconds'), { min: 1, max: 86400, step: 1 })));
                    break;
                default: {
                    // Registered conditions (viewer points, watch time, messages): number fields from the catalogue.
                    var fl = (CONDLABEL[c.type] || {}).fields || [];
                    if (!fl.length) { out.push(el('p', { className: 'sb-field-hint', text: 'Unknown condition; remove it.' })); break; }
                    fl.forEach(function (fd) {
                        if (fd.kind === 'number') out.push(field(fd.label, numberInput(c[fd.name], set(fd.name), { min: fd.min, max: fd.max, step: fd.step || 1 })));
                        // Wave 2 conditions (core/stream-bot/control): choices and short text.
                        else if (fd.kind === 'select') out.push(field(fd.label, selectInput((fd.options || []).map(function (o) { return { value: o, label: (fd.optionLabels || {})[o] || o }; }), c[fd.name] != null ? c[fd.name] : fd.default, set(fd.name))));
                        else if (fd.kind === 'text') out.push(field(fd.label, textInput(c[fd.name], set(fd.name), { maxlength: 300 })));
                    });
                }
            }
            return out;
        }

        function renderConditions() {
            clear(condBox);
            var list = el('div', { className: 'sb-steps' });
            S.conditions.forEach(function (c, i) {
                var def = CONDLABEL[c.type] || { label: c.type, help: '' };
                var rm = el('button', { className: 'btn btn-secondary btn-sm', text: 'Remove', attrs: { type: 'button', 'aria-label': 'Remove condition ' + (i + 1) + ', ' + def.label } });
                rm.addEventListener('click', function () {
                    S.conditions.splice(i, 1);
                    dirty = true;
                    focusKey = S.conditions.length ? 'cond-' + Math.max(0, i - 1) : 'cond-add';
                    renderConditions();
                });
                var title = el('h3', { className: 'sb-block-title', text: (i + 1) + '. ' + def.label, attrs: { tabindex: '-1', 'data-focus': 'cond-' + i } });
                list.appendChild(el('div', { className: 'sb-block' }, [
                    el('div', { className: 'sb-block-head' }, [title, el('div', { className: 'sb-block-tools' }, [rm])]),
                    def.help ? el('p', { className: 'sb-field-hint', text: def.help }) : null,
                    el('div', { className: 'sb-fields' }, conditionFields(c)),
                ]));
            });
            condBox.appendChild(list);
            if (!S.conditions.length) condBox.appendChild(el('p', { className: 'sb-empty', text: 'No conditions: it runs every time the trigger matches.' }));
            if (S.conditions.length < MAX_CONDITIONS) {
                var pick = selectInput(C.conditions.map(function (c) { return { value: c.type, label: c.label }; }), 'role', function () {});
                pick.setAttribute('data-focus', 'cond-add');
                var add = el('button', { className: 'btn btn-secondary btn-sm', text: 'Add condition', attrs: { type: 'button' } });
                add.addEventListener('click', function () {
                    S.conditions.push(COND_DEFAULT[pick.value] ? COND_DEFAULT[pick.value]() : (function () {
                        var c = { type: pick.value };
                        ((CONDLABEL[pick.value] || {}).fields || []).forEach(function (fd) { if (fd.default !== undefined) c[fd.name] = fd.default; });
                        return c;
                    })());
                    dirty = true;
                    focusKey = 'cond-' + (S.conditions.length - 1);
                    renderConditions();
                });
                condBox.appendChild(el('div', { className: 'sb-add' }, [field('Condition', pick), add]));
            }
            restoreFocus(condBox);
        }

        // ── actions ──
        function countSteps(list) {
            var n = 0;
            (list || []).forEach(function (s) {
                n += 1;
                if (s && s.type === 'random') (s.branches || []).forEach(function (b) { n += countSteps(b.actions); });
                if (s && s.type === 'if') n += countSteps(s.then) + countSteps(s.else);
            });
            return n;
        }
        function newStep(type) {
            var def = ACT[type];
            var s = { type: type };
            (def.fields || []).forEach(function (f) {
                if (f.kind === 'check') { s.check = { type: 'metadata', path: '', op: 'eq', value: '' }; return; }
                if (f.kind === 'ifbranches') { s.then = []; s.else = []; return; }
                if (f.kind === 'branches') s.branches = [{ weight: 1, actions: [] }, { weight: 1, actions: [] }];
                else if (f.default !== undefined) s[f.name] = f.default;
                else s[f.name] = '';
            });
            if (def.target === 'studio' || def.target === 'overlay') s.queueSeconds = 120;
            return s;
        }

        function fillChannels(select, guildId, current) {
            clear(select);
            if (!guildId) { select.appendChild(el('option', { text: 'Pick a server first', attrs: { value: '' } })); return; }
            var list = channelCache[guildId];
            if (!list) {
                select.appendChild(el('option', { text: 'Loading channels', attrs: { value: '' } }));
                call('GET', '/stream/bot/api/guilds/' + encodeURIComponent(guildId) + '/channels').then(function (r) {
                    if (r.ok) { channelCache[guildId] = r.data.channels || []; fillChannels(select, guildId, current); }
                    else { clear(select); select.appendChild(el('option', { text: errorText(r, 'Could not load the channels'), attrs: { value: '' } })); }
                });
                return;
            }
            select.appendChild(el('option', { text: list.length ? 'Pick a channel' : 'No channels CertiFried can post in', attrs: { value: '' } }));
            options(select, list.map(function (c) { return { value: c.id, label: '#' + c.name }; }), current);
        }

        function stepFields(step, depth, label) {
            var def = ACT[step.type];
            var out = [];
            var ctx = {};
            var wantsObs = false;
            (def.fields || []).forEach(function (f) {
                var set = function (v) { step[f.name] = v; };
                if (f.suggest && f.kind === 'text') {
                    var sg = suggestInput(step, f, set);
                    var empty = !suggestions(f.suggest, step).length;
                    if (f.suggest !== 'sounds' && f.suggest !== 'media' && f.suggest !== 'lightScenes' && !(ST && ST.obs)) wantsObs = true;
                    var box = field(f.label, sg.input, {
                        hint: f.suggest === 'sounds' && empty ? 'Upload sounds on the Sounds tab, or type a file name from the sounds folder in Studio.'
                            : f.suggest === 'media' ? 'The name of an image or video under Overlays, Images and videos. Variables work here.'
                            : f.suggest === 'lightScenes' ? 'Hue scenes, Nanoleaf effects and Govee or LIFX cloud scenes of the light picked above.' : (f.optional ? 'Optional.' : null),
                    });
                    box.appendChild(sg.list);
                    out.push(box);
                    return;
                }
                switch (f.kind) {
                    case 'select': {
                        var names = f.optionLabels || OPTION[f.name] || {};
                        out.push(field(f.label, selectInput(f.options.map(function (o) { return { value: o, label: names[o] || o }; }), step[f.name] || f.default, set)));
                        break;
                    }
                    case 'template': {
                        var ta = el('textarea', { attrs: { rows: 3, maxlength: 2000, spellcheck: 'true' } });
                        ta.value = step[f.name] == null ? '' : String(step[f.name]);
                        ta.addEventListener('input', function () { set(ta.value); });
                        out.push(field(f.label, ta, { wide: true, hint: f.hint || (f.optional ? 'Optional. Variables such as {user.name} work here.' : 'Variables such as {user.name} work here.') }));
                        break;
                    }
                    case 'number':
                        out.push(field(f.label, numberInput(step[f.name] != null ? step[f.name] : f.default, set, { min: f.min, max: f.max })));
                        break;
                    case 'key':
                        out.push(field(f.label, textInput(step[f.name], set, { maxlength: 64, spellcheck: 'false' }), { hint: 'Letters, numbers, _ . or -.' }));
                        break;
                    case 'url': {
                        var u = textInput(step[f.name], set, { maxlength: 500, inputmode: 'url', spellcheck: 'false' });
                        u.type = 'url';
                        out.push(field(f.label, u, { wide: true, hint: 'The host must be on your webhook allow-list (Connections, Settings).' }));
                        break;
                    }
                    case 'color': {
                        var c = el('input', { attrs: { type: 'color' } });
                        c.value = /^#[0-9a-f]{6}$/i.test(String(step[f.name] || '')) ? step[f.name] : (f.default || '#9146ff');
                        c.addEventListener('input', function () { set(c.value); });
                        out.push(field(f.label, c));
                        break;
                    }
                    case 'guild': {
                        var g = el('select');
                        g.appendChild(el('option', { text: D.guilds.length ? 'Pick a server' : 'No servers available', attrs: { value: '' } }));
                        options(g, D.guilds.map(function (x) { return { value: x.id, label: x.name }; }), step.guildId);
                        if (step.guildId && !D.guilds.some(function (x) { return x.id === step.guildId; })) {
                            g.appendChild(el('option', { text: 'A server you no longer manage', attrs: { value: step.guildId } }));
                            g.value = step.guildId;
                        }
                        g.addEventListener('change', function () {
                            step.guildId = g.value;
                            step.channelId = '';
                            if (ctx.channel) fillChannels(ctx.channel, g.value, '');
                        });
                        out.push(field(f.label, g, { hint: D.guilds.length ? null : 'You need Manage Server in a server CertiFried is in.' }));
                        break;
                    }
                    case 'channel': {
                        var ch = el('select');
                        ctx.channel = ch;
                        fillChannels(ch, step.guildId, step.channelId);
                        ch.addEventListener('change', function () { step.channelId = ch.value; });
                        out.push(field(f.label, ch, { hint: 'Posts never ping anyone.' }));
                        break;
                    }
                    case 'overlay': {
                        var ov = el('select');
                        var wantTypes = f.overlayTypes || [];
                        var fillOverlays = function () {
                            clear(ov);
                            var list = (OVL.overlays || []).filter(function (x) { return !wantTypes.length || wantTypes.indexOf(x.type) >= 0; });
                            var auto = wantTypes.indexOf('goal') >= 0 ? (list.length ? 'Pick a goal overlay' : 'No goal overlays yet') : 'Your Text and media overlay, else the alert box';
                            ov.appendChild(el('option', { text: OVL.overlays ? auto : 'Loading overlays', attrs: { value: '' } }));
                            options(ov, list.map(function (x) { return { value: x.id, label: x.name + ' (' + x.typeLabel + ')' }; }), step[f.name]);
                            if (step[f.name] && !list.some(function (x) { return String(x.id) === String(step[f.name]); })) {
                                ov.appendChild(el('option', { text: 'An overlay that was deleted', attrs: { value: String(step[f.name]) } }));
                                ov.value = String(step[f.name]);
                            }
                        };
                        fillOverlays();
                        overlayChoices().then(fillOverlays);
                        ov.addEventListener('change', function () { step[f.name] = ov.value ? Number(ov.value) : ''; });
                        out.push(field(f.label, ov, { hint: 'Make overlays on the Overlays tab.' }));
                        break;
                    }
                    case 'light': {
                        var lightList = function () { return ((DEV.data && DEV.data.lights) || []).filter(function (x) { return x.kind !== 'bridge' || (step.type === 'light.scene' && x.scenes && x.scenes.length); }); };
                        var ls = deviceSelect(step, f, lightList, 'No lights yet', 'A light that is not reported right now', step.type === 'light.scene' ? null : 'All lights');
                        out.push(field(f.label, ls, { hint: 'Lights CertiFried Studio found on your PC, and Govee or LIFX cloud lights (Devices page). Cloud lights work without Studio.' }));
                        break;
                    }
                    case 'lightPreset':
                        out.push(field(f.label, deviceSelect(step, f, function () { return DEV.data && DEV.data.presets; }, 'No presets yet', 'A preset that was deleted'), { hint: 'Make presets on the Devices page, under Light presets.' }));
                        break;
                    case 'vmTarget':
                        out.push(field(f.label, deviceSelect(step, f, function () {
                            var t = DEV.data && DEV.data.vm && DEV.data.vm.targets;
                            if (t && t.length) return t;
                            var all = [];
                            for (var i = 0; i < 8; i++) all.push({ value: 'strip:' + i, label: 'Strip ' + (i + 1) });
                            for (var j = 0; j < 8; j++) all.push({ value: 'bus:' + j, label: 'Bus ' + (j + 1) });
                            return all;
                        }, 'No strips', 'A strip or bus Voicemeeter does not have'), { hint: 'Names come from Voicemeeter through CertiFried Studio (Audio).' }));
                        break;
                    case 'vmProfile': {
                        var vmProfiles = function () { return DEV.data && DEV.data.vm && DEV.data.vm.profiles; };
                        out.push(field(f.label, deviceSelect(step, f, vmProfiles, 'No settings files reported', 'A file Studio has not reported'), { hint: 'Save settings in Voicemeeter (Menu, Save Settings) into Documents\\Voicemeeter; Studio lists them.' }));
                        break;
                    }
                    case 'automation': {
                        var a = el('select');
                        var others = (D.automations || []).filter(function (x) { return x.id !== S.id; });
                        a.appendChild(el('option', { text: others.length ? 'Pick an automation' : 'No other automations', attrs: { value: '' } }));
                        options(a, others.map(function (x) { return { value: x.id, label: x.name }; }), step.automationId);
                        a.addEventListener('change', function () { step.automationId = a.value ? Number(a.value) : ''; });
                        out.push(field(f.label, a, { hint: 'It runs with the same event, even if its own trigger is different. It must be on.' }));
                        break;
                    }
                    case 'lines': {
                        var ln = el('textarea', { attrs: { rows: 4, maxlength: 1100, spellcheck: 'true' } });
                        ln.value = step[f.name] == null ? '' : String(step[f.name]);
                        ln.addEventListener('input', function () { set(ln.value); });
                        out.push(field(f.label, ln, { wide: true, hint: 'One per line. Variables work here too.' }));
                        break;
                    }
                    case 'check': {
                        if (!step.check || typeof step.check !== 'object') step.check = { type: 'metadata', path: '', op: 'eq', value: '' };
                        var kinds = (C.ifChecks || ['role', 'amount', 'text', 'metadata']).map(function (k) { return { value: k, label: CHECK_LABEL[k] || k }; });
                        out.push(field('Check', selectInput(kinds, step.check.type, function (v) {
                            step.check = COND_DEFAULT[v] ? COND_DEFAULT[v]() : { type: v };
                            dirty = true;
                            renderActions();
                        }), { hint: step.check.type === 'metadata' ? 'An argument set earlier in the run is the detail args.name.' : null }));
                        conditionFields(step.check).forEach(function (n) { out.push(n); });
                        break;
                    }
                    case 'ifbranches':
                        break;
                    case 'branches':
                        break;
                    default:
                        out.push(field(f.label, textInput(step[f.name], set, { maxlength: 300 })));
                }
            });
            if (wantsObs) out.push(el('p', { className: 'sb-field-hint sb-field is-wide', text: 'Open CertiFried Studio with OBS connected to fill these lists.' }));
            if (def.help) out.push(el('p', { className: 'sb-field-hint sb-field is-wide', text: def.help }));
            if (def.outputs && def.outputs.length) out.push(el('p', { className: 'sb-field-hint sb-field is-wide', text: 'Later actions in this run can use ' + def.outputs.map(function (o) { return '{' + o + '}'; }).join(' and ') + '.' }));
            if (def.platforms && def.platforms.length === 1 && def.platforms[0] === 'twitch') out.push(el('p', { className: 'sb-field-hint sb-field is-wide', text: 'Twitch only: Kick has no way to do this. It works on your Twitch channel through the Stream bot grant.' }));
            if (def.platforms && def.platforms.length === 1 && def.platforms[0] === 'youtube') out.push(el('p', { className: 'sb-field-hint sb-field is-wide', text: 'YouTube only, on the viewer behind a YouTube event, while you are live. It uses a large share of the daily YouTube allowance, so it pauses when the allowance runs low.' }));
            if (def.target === 'studio' || def.target === 'overlay') {
                out.push(field('Wait for a device (seconds)', numberInput(step.queueSeconds != null ? step.queueSeconds : 120, function (v) { step.queueSeconds = v; }, { min: 0, max: 3600, step: 1 }),
                    { hint: 'If nothing is connected, it waits this long for one, then expires.' }));
            }
            return out;
        }

        function renderBranches(step, depth, label, pathKey) {
            var box = el('div', { className: 'sb-branches' });
            (step.branches || []).forEach(function (b, bi) {
                var bLabel = label + ', choice ' + (bi + 1);
                var weight = numberInput(b.weight != null ? b.weight : 1, function (v) { b.weight = v; }, { min: 0.01, max: 1000 });
                var rm = el('button', { className: 'btn btn-secondary btn-sm', text: 'Remove choice', attrs: { type: 'button', 'aria-label': 'Remove ' + bLabel } });
                rm.addEventListener('click', function () {
                    step.branches.splice(bi, 1);
                    dirty = true;
                    focusKey = pathKey;
                    renderActions();
                });
                var steps = el('div', { className: 'sb-steps' });
                renderStepList(b.actions, steps, depth + 1, bLabel, pathKey + '.' + bi);
                var branch = el('div', { className: 'sb-branch' }, [
                    el('div', { className: 'sb-branch-head' }, [
                        el(headingTag(depth, 1), { className: 'sb-branch-title', text: 'Choice ' + (bi + 1) }),
                        field('Weight', weight, { hint: 'Higher is picked more often.' }),
                        rm,
                    ]),
                    steps,
                ]);
                if (!b.actions.length) branch.appendChild(el('p', { className: 'sb-empty', text: 'No actions in this choice: picking it does nothing.' }));
                branch.appendChild(addBar(b.actions, depth + 1, pathKey + '.' + bi));
                box.appendChild(branch);
            });
            if ((step.branches || []).length < MAX_BRANCHES) {
                var more = el('button', { className: 'btn btn-secondary btn-sm', text: 'Add choice', attrs: { type: 'button' } });
                more.addEventListener('click', function () {
                    step.branches.push({ weight: 1, actions: [] });
                    dirty = true;
                    focusKey = pathKey;
                    renderActions();
                });
                box.appendChild(el('div', {}, [more]));
            }
            return box;
        }

        /** The two step lists of an If step: Then and Otherwise. */
        function renderIf(step, depth, label, pathKey) {
            var box = el('div', { className: 'sb-branches' });
            [['then', 'Then', 'When the check passes'], ['else', 'Otherwise', 'When it does not']].forEach(function (part, bi) {
                if (!Array.isArray(step[part[0]])) step[part[0]] = [];
                var list = step[part[0]];
                var steps = el('div', { className: 'sb-steps' });
                renderStepList(list, steps, depth + 1, label + ', ' + part[1].toLowerCase(), pathKey + '.' + bi);
                var branch = el('div', { className: 'sb-branch' }, [
                    el('div', { className: 'sb-branch-head' }, [el(headingTag(depth, 1), { className: 'sb-branch-title', text: part[1] }), el('p', { className: 'sb-field-hint', text: part[2] })]),
                    steps,
                ]);
                if (!list.length) branch.appendChild(el('p', { className: 'sb-empty', text: 'Nothing: this part does nothing.' }));
                branch.appendChild(addBar(list, depth + 1, pathKey + '.' + bi));
                box.appendChild(branch);
            });
            return box;
        }

        function renderStepList(list, container, depth, parentLabel, pathKey) {
            list.forEach(function (step, i) {
                var def = ACT[step.type];
                var key = pathKey + ':' + i;
                var label = (parentLabel ? parentLabel + ', action ' : 'Action ') + (i + 1);
                if (!def) {
                    container.appendChild(el('div', { className: 'sb-block' }, [el('p', { className: 'sb-field-hint', text: label + ': unknown action "' + step.type + '". Remove it to save.' })]));
                    return;
                }
                var tools = el('div', { className: 'sb-block-tools' });
                function tool(text, aria, fn, disabled) {
                    var b = el('button', { className: 'btn btn-secondary btn-sm', text: text, attrs: { type: 'button', 'aria-label': aria, disabled: !!disabled, 'data-focus': key + ':' + text } });
                    b.addEventListener('click', fn);
                    tools.appendChild(b);
                }
                tool('Up', 'Move ' + label + ' up', function () {
                    list.splice(i - 1, 0, list.splice(i, 1)[0]);
                    dirty = true;
                    focusKey = pathKey + ':' + (i - 1) + ':' + (i - 1 > 0 ? 'Up' : 'Down');
                    renderActions();
                }, i === 0);
                tool('Down', 'Move ' + label + ' down', function () {
                    list.splice(i + 1, 0, list.splice(i, 1)[0]);
                    dirty = true;
                    focusKey = pathKey + ':' + (i + 1) + ':' + (i + 1 < list.length - 1 ? 'Down' : 'Up');
                    renderActions();
                }, i === list.length - 1);
                tool('Remove', 'Remove ' + label + ', ' + def.label, function () {
                    list.splice(i, 1);
                    dirty = true;
                    focusKey = 'add:' + pathKey;
                    renderActions();
                });
                var head = el('div', { className: 'sb-block-head' }, [
                    el(headingTag(depth), { className: 'sb-block-title', text: (i + 1) + '. ' + def.label, attrs: { tabindex: '-1', 'data-focus': key } }),
                ]);
                if ((def.target === 'studio' || def.target === 'overlay') && !(C.devicesOnline && C.devicesOnline[def.target])) {
                    head.appendChild(el('span', { className: 'cf-pill is-warn', text: C.targetLabels[def.target] }));
                }
                if (def.platforms && def.platforms.length === 1 && def.platforms[0] === 'twitch') head.appendChild(el('span', { className: 'cf-pill', text: 'Twitch only' }));
                if (def.platforms && def.platforms.length === 1 && def.platforms[0] === 'youtube') head.appendChild(el('span', { className: 'cf-pill', text: 'YouTube only' }));
                head.appendChild(tools);
                var block = el('div', { className: 'sb-block' }, [head]);
                var fields = stepFields(step, depth, label);
                if (fields.length) block.appendChild(el('div', { className: 'sb-fields' }, fields));
                if (step.type === 'random') block.appendChild(renderBranches(step, depth, label, key));
                if (step.type === 'if') block.appendChild(renderIf(step, depth, label, key));
                container.appendChild(block);
            });
        }

        function addBar(list, depth, pathKey) {
            var used = countSteps(S.actions);
            var bar = el('div', { className: 'sb-add' });
            if (used >= MAX_STEPS) {
                bar.appendChild(el('p', { className: 'sb-field-hint', text: 'This automation has ' + MAX_STEPS + ' actions, the most it can have.' }));
                return bar;
            }
            var pick = el('select', { attrs: { 'data-focus': 'add:' + pathKey } });
            var groups = [];
            var byGroup = {};
            C.actions.forEach(function (a) {
                if ((a.type === 'random' || a.type === 'if') && depth >= MAX_DEPTH) return;
                if (!byGroup[a.group]) { byGroup[a.group] = []; groups.push(a.group); }
                byGroup[a.group].push(a);
            });
            groups.forEach(function (g) {
                var og = el('optgroup', { attrs: { label: g } });
                byGroup[g].forEach(function (a) {
                    var needs = (a.target === 'studio' || a.target === 'overlay') && !(C.devicesOnline && C.devicesOnline[a.target]);
                    var only = a.platforms && a.platforms.length === 1 ? ({ twitch: ' (Twitch only)', youtube: ' (YouTube only)' })[a.platforms[0]] || '' : '';
                    og.appendChild(el('option', { text: a.label + (needs ? ' (' + C.targetLabels[a.target] + ')' : '') + only, attrs: { value: a.type } }));
                });
                pick.appendChild(og);
            });
            var add = el('button', { className: 'btn btn-secondary btn-sm', text: 'Add action', attrs: { type: 'button' } });
            add.addEventListener('click', function () {
                list.push(newStep(pick.value));
                dirty = true;
                focusKey = pathKey + ':' + (list.length - 1);
                renderActions();
            });
            var note = el('p', { className: 'sb-field-hint sb-add-note', id: uid('h'), text: used + ' of ' + MAX_STEPS + ' actions used' });
            pick.setAttribute('aria-describedby', note.id);
            bar.appendChild(field(depth ? 'Add to this choice' : 'Action', pick));
            bar.appendChild(add);
            bar.appendChild(note);
            return bar;
        }

        function renderActions() {
            clear(actBox);
            var steps = el('div', { className: 'sb-steps' });
            renderStepList(S.actions, steps, 0, '', 'a');
            actBox.appendChild(steps);
            if (!S.actions.length) actBox.appendChild(el('p', { className: 'sb-empty', text: 'No actions yet. Add one below, for example Send a chat message.' }));
            actBox.appendChild(addBar(S.actions, 0, 'a'));
            restoreFocus(actBox);
        }

        renderTrigger();
        renderConditions();
        renderActions();

        // ── save, delete ──
        function showList(box, list, items) {
            clear(list);
            (items || []).forEach(function (t) { list.appendChild(el('li', { text: t })); });
            box.hidden = !(items && items.length);
        }
        function payload() {
            var trigger_config = {};
            if (S.platforms.length) trigger_config.platforms = S.platforms.slice();
            if (S.trigger === 'chat') trigger_config.match = { mode: S.match.mode, text: S.match.text, caseSensitive: S.match.caseSensitive };
            if (S.trigger === 'bits.used') trigger_config.bitsKind = S.bitsKind || 'any';
            if (S.trigger === 'variable.changed') { if (S.varKey.trim()) trigger_config.key = S.varKey.trim().toLowerCase(); trigger_config.scope = S.varScope || 'any'; }
            if (S.trigger === 'voice.phrase') {
                trigger_config.phrases = S.phrases.split('\n').map(function (t) { return t.trim(); }).filter(Boolean);
                if (String(S.voiceConf).trim() !== '') trigger_config.confidence = Number(S.voiceConf);
                if (String(S.voiceWait).trim() !== '') trigger_config.cooldownSec = Number(S.voiceWait);
            }
            (((EVT[S.trigger] || {}).config) || []).forEach(function (fd) {
                if (S.extra[fd.name] !== undefined && S.extra[fd.name] !== '') trigger_config[fd.name] = fd.kind === 'number' ? Number(S.extra[fd.name]) : S.extra[fd.name];
            });
            if (String(S.queueName).trim()) trigger_config.queue = { name: String(S.queueName).trim(), blocking: !!S.queueBlocking };
            return { name: S.name.trim(), enabled: S.enabled, trigger_type: S.trigger, trigger_config: trigger_config, conditions: S.conditions, actions: S.actions };
        }
        var saving = false;
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            if (saving) return;
            saving = true;
            setStatus(saveStatus, 'Saving', 'busy');
            var isNew = !S.id;
            call(isNew ? 'POST' : 'PUT', '/stream/bot/api/automations' + (isNew ? '' : '/' + S.id), payload()).then(function (r) {
                saving = false;
                if (!r.ok) {
                    var errs = (r.data && r.data.errors) || [errorText(r, 'Could not save.')];
                    showList(errBox, errList, errs);
                    showList(warnBox, warnList, []);
                    setStatus(saveStatus, 'Not saved', 'bad');
                    errBox.focus();
                    return;
                }
                showList(errBox, errList, []);
                showList(warnBox, warnList, r.data.warnings || []);
                dirty = false;
                setStatus(saveStatus, 'Saved', 'ok');
                if (isNew) {
                    S.id = r.data.id;
                    try { history.replaceState(null, '', '/stream/bot/automations/' + S.id); } catch (err) { /* old browser */ }
                    delBtn.hidden = false;
                    if (testSec) testSec.hidden = false;
                }
                if (titleEl) titleEl.textContent = S.name.trim();
                document.title = S.name.trim() + ' · Stream bot · CertiFried';
            });
        });
        delBtn.addEventListener('click', function () {
            if (!S.id) return;
            if (!window.confirm('Delete "' + (S.name || 'this automation') + '"? Its run history stays until it expires.')) return;
            setStatus(saveStatus, 'Deleting', 'busy');
            call('DELETE', '/stream/bot/api/automations/' + S.id).then(function (r) {
                if (r.ok) window.location.assign('/stream/bot/automations');
                else setStatus(saveStatus, errorText(r, 'Could not delete it.'), 'bad');
            });
        });

        // ── test ──
        var testBtn = document.getElementById('sb-test-run');
        var testStatus = document.getElementById('sb-test-status');
        var testOut = document.getElementById('sb-test-result');
        var dryIn = document.getElementById('sb-dry');
        var STEP_STATUS = { ok: 'done', failed: 'failed', skipped: 'skipped', dry: 'dry run', sent: 'sent to a device', queued: 'waiting for a device' };
        var RUN_STATUS = { ok: 'Finished', partial: 'Finished, some actions failed', failed: 'Failed', skipped: 'Skipped', running: 'Still running' };
        if (testBtn) testBtn.addEventListener('click', function () {
            if (!S.id) return;
            clear(testOut);
            testBtn.disabled = true;
            setStatus(testStatus, dirty ? 'Testing the saved version (you have unsaved changes)' : 'Testing', 'busy');
            call('POST', '/stream/bot/api/automations/' + S.id + '/test', { dryRun: !!dryIn.checked }).then(function (r) {
                testBtn.disabled = false;
                if (!r.ok) { setStatus(testStatus, errorText(r, 'The test could not run.'), 'bad'); return; }
                var d = r.data;
                var runsHref = '/stream/bot/runs?automation=' + encodeURIComponent(S.id);
                if (d.status === 'running') {
                    setStatus(testStatus, 'Still running', 'warn');
                    testOut.appendChild(el('p', { className: 'sb-test-head' }, ['The test is still running (a wait or a slow action). ', el('a', { text: 'See it in Run history', attrs: { href: runsHref } }), '.']));
                    return;
                }
                setStatus(testStatus, (RUN_STATUS[d.status] || d.status) + (d.dryRun ? ' (dry run)' : ''), d.status === 'ok' ? 'ok' : (d.status === 'skipped' ? 'warn' : 'bad'));
                var head = el('p', { className: 'sb-test-head' }, [(RUN_STATUS[d.status] || d.status) + (d.dryRun ? ', nothing was sent. ' : '. ')]);
                if (d.runId) head.appendChild(el('a', { text: 'Open run ' + d.runId, attrs: { href: '/stream/bot/runs/' + encodeURIComponent(d.runId) } }));
                testOut.appendChild(head);
                if (d.skipReason) testOut.appendChild(el('p', { className: 'sb-field-hint', text: 'Reason: ' + d.skipReason }));
                if (d.steps && d.steps.length) {
                    var ol = el('ol');
                    d.steps.forEach(function (s) {
                        var lbl = s.type === 'random' ? 'Pick one at random' : ((ACT[s.type] && ACT[s.type].label) || s.type);
                        ol.appendChild(el('li', { text: s.at + ' ' + lbl + ': ' + (STEP_STATUS[s.status] || s.status) + (s.detail ? '. ' + s.detail : '') }));
                    });
                    testOut.appendChild(ol);
                }
            });
        });

        window.addEventListener('beforeunload', function (e) {
            if (!dirty) return undefined;
            e.preventDefault();
            e.returnValue = '';
            return '';
        });
    }

    // ── connections ────────────────────────────────────────────────────────────────────────
    function initConnections() {
        var msg = document.getElementById('sb-conn-msg');
        var msgText = document.getElementById('sb-conn-msg-text');
        function say(text, tone) {
            if (!msg) return;
            msg.className = 'cf-notice' + (tone === 'bad' ? ' is-bad' : tone === 'ok' ? ' is-ok' : tone === 'warn' ? ' is-warn' : '');
            msgText.textContent = text;
            msg.hidden = false;
            msg.scrollIntoView({ block: 'nearest' });
        }
        Array.prototype.forEach.call(document.querySelectorAll('[data-link-platform]'), function (b) {
            b.addEventListener('click', function () {
                var platform = b.getAttribute('data-link-platform');
                b.disabled = true;
                b.textContent = 'Linking';
                call('POST', '/stream/bot/api/channels/link', { platform: platform, id: b.getAttribute('data-link-id') }).then(function (r) {
                    if (!r.ok) { b.disabled = false; b.textContent = 'Link'; say(errorText(r, 'Could not link the channel.'), 'bad'); return; }
                    if (r.data.kick && !r.data.kick.ok) {
                        b.textContent = 'Linked';
                        say('The channel is linked, but Kick did not accept the event subscription: ' + r.data.kick.error + ' Reload this page to see its state.', 'warn');
                        return;
                    }
                    window.location.assign('/stream/bot/connections?ok=linked_' + (platform === 'kick' || platform === 'youtube' ? platform : 'twitch'));
                });
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-unlink-channel]'), function (b) {
            b.addEventListener('click', function () {
                if (!window.confirm('Unlink ' + (b.getAttribute('data-name') || 'this channel') + '? Its events stop reaching your automations.')) return;
                b.disabled = true;
                call('DELETE', '/stream/bot/api/channels/' + encodeURIComponent(b.getAttribute('data-unlink-channel'))).then(function (r) {
                    if (r.ok) window.location.assign('/stream/bot/connections?ok=unlinked');
                    else { b.disabled = false; say(errorText(r, 'Could not unlink it.'), 'bad'); }
                });
            });
        });
        // YouTube Live (H-741): look for a live broadcast now (the server allows it once a minute).
        Array.prototype.forEach.call(document.querySelectorAll('[data-youtube-check]'), function (b) {
            b.addEventListener('click', function () {
                var label = b.textContent;
                b.disabled = true;
                b.textContent = 'Checking';
                call('POST', '/stream/bot/api/youtube/check', {}).then(function (r) {
                    b.textContent = label;
                    if (!r.ok) { b.disabled = false; say(errorText(r, 'Could not check YouTube.'), 'bad'); return; }
                    var list = r.data.channels || [];
                    if (list.some(function (c) { return c.live; })) { window.location.reload(); return; }
                    b.disabled = false;
                    var err = list.map(function (c) { return c.error; }).filter(Boolean)[0];
                    say(err ? 'YouTube: ' + err : 'No live broadcast on your YouTube channel right now.', err ? 'warn' : 'ok');
                });
            });
        });

        // Heart rate (Studio 0.2.14): the optional Pulsoid token.
        var hrForm = document.getElementById('sb-pulsoid-form');
        var hrStatus = document.getElementById('sb-pulsoid-status');
        if (hrForm) {
            hrForm.addEventListener('submit', function (e) {
                e.preventDefault();
                setStatus(hrStatus, 'Saving', 'busy');
                call('POST', '/stream/bot/api/heart/pulsoid', { token: document.getElementById('sb-pulsoid-token').value }).then(function (r) {
                    if (r.ok) window.location.assign('/stream/bot/connections#sb-heart-title');
                    else setStatus(hrStatus, errorText(r, 'Could not save it.'), 'bad');
                });
            });
        }
        var hrRemove = document.getElementById('sb-pulsoid-remove');
        if (hrRemove) {
            hrRemove.addEventListener('click', function () {
                if (!window.confirm('Remove the Pulsoid token? CertiFried then uses only your watch through Studio.')) return;
                hrRemove.disabled = true;
                call('DELETE', '/stream/bot/api/heart/pulsoid').then(function (r) {
                    if (r.ok) window.location.reload();
                    else { hrRemove.disabled = false; setStatus(hrStatus, errorText(r, 'Could not remove it.'), 'bad'); }
                });
            });
        }

        var tipForm = document.getElementById('sb-tip-form');
        var tipSource = document.getElementById('sb-tip-source');
        var tipStatus = document.getElementById('sb-tip-status');
        function showTipRows() {
            var v = tipSource.value;
            Array.prototype.forEach.call(tipForm.querySelectorAll('[data-tip-for]'), function (row) {
                row.hidden = row.getAttribute('data-tip-for').split(' ').indexOf(v) < 0;
            });
            Array.prototype.forEach.call(tipForm.querySelectorAll('[data-tip-help]'), function (p) {
                var on = p.getAttribute('data-tip-help') === v;
                p.hidden = !on;
                if (on) document.getElementById('sb-tip-token').setAttribute('aria-describedby', p.id || (p.id = uid('tiphelp')));
            });
        }
        if (tipForm && tipSource) {
            tipSource.addEventListener('change', showTipRows);
            showTipRows();
            tipForm.addEventListener('submit', function (e) {
                e.preventDefault();
                var v = tipSource.value;
                var body = { source: v };
                if (v === 'streamelements' || v === 'streamlabs') body.token = document.getElementById('sb-tip-token').value;
                var refSel = document.getElementById('sb-tip-' + v);
                if (refSel && refSel.tagName === 'SELECT') body.ref = refSel.value;
                setStatus(tipStatus, 'Adding', 'busy');
                call('POST', '/stream/bot/api/tip-sources', body).then(function (r) {
                    if (r.ok) window.location.assign('/stream/bot/connections?ok=tip_added#sb-tips-title');
                    else setStatus(tipStatus, errorText(r, 'Could not add it.'), 'bad');
                });
            });
        }
        Array.prototype.forEach.call(document.querySelectorAll('[data-toggle-tip]'), function (sw) {
            sw.addEventListener('change', function () {
                var want = sw.checked;
                sw.disabled = true;
                call('POST', '/stream/bot/api/tip-sources/' + encodeURIComponent(sw.getAttribute('data-toggle-tip')) + '/toggle', { enabled: want }).then(function (r) {
                    sw.disabled = false;
                    if (r.ok) setStatus(tipStatus, want ? 'Turned on' : 'Turned off', 'ok');
                    else { sw.checked = !want; setStatus(tipStatus, errorText(r, 'Could not change it.'), 'bad'); }
                });
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-remove-tip]'), function (b) {
            b.addEventListener('click', function () {
                if (!window.confirm('Remove ' + (b.getAttribute('data-name') || 'this tip service') + '? A saved token is deleted with it.')) return;
                b.disabled = true;
                call('DELETE', '/stream/bot/api/tip-sources/' + encodeURIComponent(b.getAttribute('data-remove-tip'))).then(function (r) {
                    if (r.ok) window.location.reload();
                    else { b.disabled = false; setStatus(tipStatus, errorText(r, 'Could not remove it.'), 'bad'); }
                });
            });
        });

        var setForm = document.getElementById('sb-settings-form');
        var setStatusEl = document.getElementById('sb-settings-status');
        if (setForm) setForm.addEventListener('submit', function (e) {
            e.preventDefault();
            var hosts = document.getElementById('sb-allow-hosts');
            setStatus(setStatusEl, 'Saving', 'busy');
            call('POST', '/stream/bot/api/settings', { storeChat: document.getElementById('sb-store-chat').checked, webhookAllowHosts: hosts.value }).then(function (r) {
                if (!r.ok) { setStatus(setStatusEl, errorText(r, 'Could not save.'), 'bad'); return; }
                hosts.value = (r.data.settings && r.data.settings.webhookAllowHosts || []).join('\n');
                setStatus(setStatusEl, 'Saved', 'ok');
            });
        });
    }

    // ── devices ────────────────────────────────────────────────────────────────────────────
    function initDevices() {
        var pairForm = document.getElementById('sb-pair-form');
        var pairStatus = document.getElementById('sb-pair-status');
        if (pairForm) pairForm.addEventListener('submit', function (e) {
            e.preventDefault();
            setStatus(pairStatus, 'Making a code', 'busy');
            call('POST', '/stream/bot/api/devices/pairing-code', { name: document.getElementById('sb-pair-name').value }).then(function (r) {
                if (!r.ok) { setStatus(pairStatus, errorText(r, 'Could not make a code.'), 'bad'); return; }
                document.getElementById('sb-pair-code').textContent = r.data.code;
                var until = new Date(r.data.expiresAt);
                document.getElementById('sb-pair-expiry').textContent = 'Works once, until ' + until.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + '. Making a new code does not cancel this one.';
                document.getElementById('sb-pair-result').hidden = false;
                var open = document.getElementById('sb-pair-open');
                if (open) open.href = 'certifried-studio://pair?code=' + encodeURIComponent(r.data.code);
                setStatus(pairStatus, 'Code ready: ' + r.data.code, 'ok');
            });
        });
        var tokenForm = document.getElementById('sb-token-form');
        var tokenStatus = document.getElementById('sb-token-status');
        var tokenValue = document.getElementById('sb-token-value');
        if (tokenForm) tokenForm.addEventListener('submit', function (e) {
            e.preventDefault();
            setStatus(tokenStatus, 'Making a token', 'busy');
            call('POST', '/stream/bot/api/devices/token', { kind: 'overlay', name: document.getElementById('sb-token-name').value }).then(function (r) {
                if (!r.ok) { setStatus(tokenStatus, errorText(r, 'Could not make a token.'), 'bad'); return; }
                tokenValue.value = r.data.token;
                document.getElementById('sb-token-result').hidden = false;
                tokenValue.focus();
                tokenValue.select();
                setStatus(tokenStatus, 'Token made. Copy it now: it is not shown again. Reload to see it in the list.', 'ok');
            });
        });
        var copy = document.getElementById('sb-token-copy');
        if (copy) copy.addEventListener('click', function () {
            var done = function () { setStatus(tokenStatus, 'Copied', 'ok'); };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tokenValue.value).then(done, function () { tokenValue.select(); setStatus(tokenStatus, 'Select the token and copy it', 'warn'); });
            else { tokenValue.select(); try { document.execCommand('copy'); done(); } catch (err) { setStatus(tokenStatus, 'Select the token and copy it', 'warn'); } }
        });
        var devStatus = document.getElementById('sb-dev-status');
        function deviceAction(attr, method, suffix, question) {
            Array.prototype.forEach.call(document.querySelectorAll('[' + attr + ']'), function (b) {
                b.addEventListener('click', function () {
                    if (!window.confirm(question.replace('%s', b.getAttribute('data-name') || 'this device'))) return;
                    b.disabled = true;
                    call(method, '/stream/bot/api/devices/' + encodeURIComponent(b.getAttribute(attr)) + suffix).then(function (r) {
                        if (r.ok) window.location.reload();
                        else { b.disabled = false; setStatus(devStatus, errorText(r, 'Could not do that.'), 'bad'); }
                    });
                });
            });
        }
        deviceAction('data-revoke-device', 'POST', '/revoke', 'Revoke %s? It is disconnected now and its token stops working.');
        deviceAction('data-delete-device', 'DELETE', '', 'Remove %s? Its token stops working, it is disconnected now, and it is deleted from the list. This cannot be undone.');
    }

    // ── sounds ─────────────────────────────────────────────────────────────────────────────
    function initSounds() {
        var form = document.getElementById('sb-snd-form');
        var fileIn = document.getElementById('sb-snd-file');
        var nameIn = document.getElementById('sb-snd-name');
        var upStatus = document.getElementById('sb-up-status');
        var listStatus = document.getElementById('sb-snd-status');
        if (fileIn) fileIn.addEventListener('change', function () {
            var f = fileIn.files && fileIn.files[0];
            if (f && !nameIn.value.trim()) nameIn.value = f.name.replace(/\.[a-z0-9]{2,4}$/i, '').slice(0, 80);
        });
        if (form) form.addEventListener('submit', function (e) {
            e.preventDefault();
            var f = fileIn.files && fileIn.files[0];
            if (!f) { setStatus(upStatus, 'Choose an audio file first.', 'bad'); return; }
            if (f.size > 5 * 1024 * 1024) { setStatus(upStatus, 'A sound can be at most 5 MB.', 'bad'); return; }
            var name = (nameIn.value || f.name).trim();
            setStatus(upStatus, 'Uploading', 'busy');
            fetch('/stream/bot/api/sounds?name=' + encodeURIComponent(name), {
                method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream' }, body: f,
            }).then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok && data && data.ok !== false, status: res.status, data: data || {} }; });
            }, function () { return { ok: false, status: 0, data: { error: 'Could not reach CertiFried. Check your connection and try again.' } }; }).then(function (r) {
                if (r.ok) window.location.reload();
                else setStatus(upStatus, errorText(r, 'Could not upload it.'), 'bad');
            });
        });
        var player = null;
        Array.prototype.forEach.call(document.querySelectorAll('[data-play-sound]'), function (b) {
            b.addEventListener('click', function () {
                if (player) { player.pause(); player = null; }
                player = new Audio('/stream/bot/api/sounds/' + encodeURIComponent(b.getAttribute('data-play-sound')) + '/file');
                player.play().catch(function () { setStatus(listStatus, 'Could not play ' + (b.getAttribute('data-name') || 'it') + ' in this browser.', 'warn'); });
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-delete-sound]'), function (b) {
            b.addEventListener('click', function () {
                if (!window.confirm('Delete ' + (b.getAttribute('data-name') || 'this sound') + '? Actions that play it will fail until you upload one with the same name.')) return;
                b.disabled = true;
                call('DELETE', '/stream/bot/api/sounds/' + encodeURIComponent(b.getAttribute('data-delete-sound'))).then(function (r) {
                    if (r.ok) window.location.reload();
                    else { b.disabled = false; setStatus(listStatus, errorText(r, 'Could not delete it.'), 'bad'); }
                });
            });
        });
    }

    if (page === 'overview') initOverview();
    else if (page === 'automations') initAutomations();
    else if (page === 'editor') initEditor();
    else if (page === 'connections') initConnections();
    else if (page === 'devices') initDevices();
    else if (page === 'sounds') initSounds();
})();
