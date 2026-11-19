/*
 * A CertiFried overlay inside OBS (views/stream-bot/overlay.ejs). It shows only what the server sends over
 * <base>/events (SSE) and acknowledges overlay actions to <base>/report. Types: alerts, chat, events, goal, counter,
 * nowplaying, canvas; every type also shows the "Show text" and "Show an image or video" actions.
 *
 * Reconnect-safe: the browser's EventSource retries a dropped stream; when the server answered with an error (a restart
 * behind LiteSpeed), the page opens a new one itself with a growing pause (3 s to 30 s). The server sends the current
 * state in every hello, and chat lines are de-duplicated by id.
 * Alerts wait in a queue and never overlap. Sounds, videos and read-aloud messages play inside this page, so OBS's own
 * audio settings for the source decide where they go. Every element is built with createElement and textContent.
 */
(function () {
    'use strict';
    var data;
    try { data = JSON.parse(document.getElementById('sbo-data').textContent); } catch (e) { return; }
    var base = data.base;
    var type = data.type;
    var soundOn = data.sound !== false;
    var body = document.body;
    var widget = document.getElementById('sbo-widget');
    var layer = document.getElementById('sbo-layer');
    var cfg = {};
    var page = {};

    // ── helpers ──
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null && text !== '') n.textContent = String(text);
        return n;
    }
    function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
    function url(rel) { return base + '/' + String(rel).replace(/^\/+/, ''); }
    function report(dispatchId, ok, error) {
        if (!dispatchId) return;
        try {
            fetch(base + '/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dispatchId: dispatchId, ok: ok !== false, error: error || null }), keepalive: true }).catch(function () {});
        } catch (e) { /* old browser */ }
    }
    function setVars(c) {
        var s = body.style;
        if (c.fontCss) s.setProperty('--sbo-font', c.fontCss);
        if (c.textColor) s.setProperty('--sbo-text', c.textColor);
        if (c.accentColor) s.setProperty('--sbo-accent', c.accentColor);
        if (c.barColor) s.setProperty('--sbo-bar', c.barColor);
        if (c.fontSize) s.setProperty('--sbo-size', c.fontSize + 'px');
        if (c.margin != null) s.setProperty('--sbo-margin', c.margin + 'px');
        body.classList.remove('sbo-plate--none', 'sbo-plate--soft', 'sbo-plate--solid');
        body.classList.add('sbo-plate--' + (c.plate || 'none'));
    }
    function placed(position, inner, width) {
        var wrap = el('div', 'sbo-at sbo-at--' + (position || 'center'));
        if (width) wrap.style.width = width + 'px';
        wrap.appendChild(inner);
        return wrap;
    }
    function playAudio(src, volume, onEnd) {
        if (!soundOn || !src) { if (onEnd) setTimeout(onEnd, 0); return null; }
        var a = new Audio(url(src));
        a.volume = Math.max(0, Math.min(1, (Number(volume) || 0) / 100));
        var done = false;
        var finish = function () { if (done) return; done = true; if (onEnd) onEnd(); };
        a.addEventListener('ended', finish);
        a.addEventListener('error', finish);
        var p = a.play();
        if (p && p.catch) p.catch(finish);
        return a;
    }
    function mediaNode(m, volume, cls) {
        if (!m || !m.src) return null;
        var n;
        if (m.kind === 'video') {
            n = el('video', cls);
            n.src = url(m.src);
            n.autoplay = true;
            n.playsInline = true;
            n.muted = !soundOn;
            n.volume = Math.max(0, Math.min(1, (Number(volume == null ? 80 : volume) || 0) / 100));
        } else {
            n = el('img', cls);
            n.alt = '';
            n.src = url(m.src);
        }
        return n;
    }
    function leave(node, after) {
        node.classList.add('sbo-out');
        setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); if (after) after(); }, 380);
    }

    // ── Show text / Show an image or video (every overlay) ──
    function showAction(frame) {
        var p = frame.params || {};
        var anim = 'sbo-in--' + (p.animation || 'rise');
        var inner;
        if (frame.action === 'overlay.text') {
            inner = el('p', 'sbo-show-text sbo-panel ' + anim, p.text || '');
            inner.style.fontSize = (page.textSizes && page.textSizes[p.size]) ? page.textSizes[p.size] + 'px' : '56px';
            inner.style.fontFamily = page.canvasFont || '';
        } else if (frame.action === 'overlay.media') {
            inner = mediaNode(p.media, p.volume, 'sbo-show-media ' + anim);
            if (!inner) { report(frame.id, false, 'no media'); return; }
            var pct = (page.mediaSizes && page.mediaSizes[p.size]) || 35;
            inner.style.width = Math.round(1920 * pct / 100) + 'px';
        } else if (frame.action === 'overlay.alert' && type === 'alerts') {
            enqueue({ id: frame.id, layout: 'text', animation: 'rise', title: p.title || '', detail: p.message || '', message: '', durationMs: p.durationMs || 6000 });
            report(frame.id, true);
            return;
        } else {
            report(frame.id, false, 'not supported here');
            return;
        }
        var node = placed(p.position || 'center', inner);
        layer.appendChild(node);
        report(frame.id, true);
        var ms = Math.max(1000, Math.min(60000, Number(p.durationMs) || 5000));
        var gone = false;
        var end = function () { if (!gone) { gone = true; leave(node); } };
        if (inner.tagName === 'VIDEO') inner.addEventListener('ended', end);
        setTimeout(end, ms);
    }

    // ── alerts ──
    var queue = [];
    var busy = false;
    var slot = null;
    function enqueue(a) {
        if (queue.length > 50) queue.shift();
        queue.push(a);
        if (!busy) next();
    }
    function next() {
        var a = queue.shift();
        if (!a) { busy = false; return; }
        busy = true;
        showAlert(a, function () { setTimeout(next, Math.max(0, Number(cfg.gapMs) || 0)); });
    }
    function titleNode(a) {
        var t = el('p', 'sbo-alert-title');
        var text = String(a.title || '');
        var at = a.name ? text.indexOf(a.name) : -1;
        if (at < 0) { t.textContent = text; return t; }
        if (at > 0) t.appendChild(document.createTextNode(text.slice(0, at)));
        t.appendChild(el('span', 'sbo-name', a.name));
        if (at + a.name.length < text.length) t.appendChild(document.createTextNode(text.slice(at + a.name.length)));
        return t;
    }
    function showAlert(a, done) {
        if (!slot) {
            slot = el('div', 'sbo-alert-slot');
            widget.appendChild(slot);
        }
        slot.className = 'sbo-alert-slot sbo-alert-slot--' + (cfg.position || 'center');
        var box = el('div', 'sbo-alert sbo-alert--' + (a.layout || 'stacked') + ' sbo-in--' + (a.animation || 'rise'));
        var m = a.layout === 'text' ? null : mediaNode(a.media, a.sound ? 0 : 80, '');
        if (m) { var mw = el('div', 'sbo-alert-media'); mw.appendChild(m); box.appendChild(mw); if (m.tagName === 'VIDEO' && a.sound) m.muted = true; }
        var txt = el('div', 'sbo-alert-text sbo-panel');
        txt.appendChild(titleNode(a));
        if (a.detail) txt.appendChild(el('p', 'sbo-alert-detail', a.detail));
        if (a.message) txt.appendChild(el('p', 'sbo-alert-message', a.message));
        box.appendChild(txt);
        clear(slot);
        slot.appendChild(box);
        var minMs = Math.max(2000, Math.min(30000, Number(a.durationMs) || 6000));
        var started = Date.now();
        var speaking = false;
        var finished = false;
        function end() {
            if (finished) return;
            if (speaking || Date.now() - started < minMs) return;
            finished = true;
            leave(box, done);
        }
        function speak() {
            if (!a.tts || !a.tts.src || !soundOn) return;
            speaking = true;
            playAudio(a.tts.src, a.tts.volume, function () { speaking = false; setTimeout(end, 400); });
            setTimeout(function () { speaking = false; end(); }, 30000);
        }
        if (a.sound && a.sound.src && soundOn) playAudio(a.sound.src, a.sound.volume, function () { setTimeout(speak, 250); });
        else setTimeout(speak, 600);
        setTimeout(end, minMs);
    }

    // ── chat ──
    var ROLE_GLYPH = {
        broadcaster: 'M4 3h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm2 3v4l4-2z',
        moderator: 'M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z',
        vip: 'M8 2l5 5-5 7-5-7z',
        subscriber: 'M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3 4.3 13.3l.8-4.1L2 6.3l4.2-.5z',
        founder: 'M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3 4.3 13.3l.8-4.1L2 6.3l4.2-.5z',
        verified: 'M6.5 11.5L3 8l1.2-1.2 2.3 2.3 5.3-5.3L13 5z',
        staff: 'M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2z',
        og: 'M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2zm0 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
        sub_gifter: 'M3 7h10v6H3zM2 5h12v2H2zm6 0v8',
        artist: 'M5 3h7v7.5a2 2 0 1 1-1.5-1.9V5H6.5v6.5A2 2 0 1 1 5 9.6z',
    };
    var ROLE_COLOR = { broadcaster: '#e91916', moderator: '#00ad03', vip: '#e005b9', subscriber: '#8205b4', founder: '#8205b4', verified: '#1d9bf0', staff: '#6b6b6b', og: '#d4a017', sub_gifter: '#ad6800', artist: '#7b49ff' };
    var SVG = 'http://www.w3.org/2000/svg';
    function glyph(pathD, bg, title, fg) {
        var s = document.createElementNS(SVG, 'svg');
        s.setAttribute('viewBox', '0 0 16 16');
        s.setAttribute('class', 'sbo-badge');
        s.setAttribute('role', 'img');
        if (title) s.setAttribute('aria-label', title);
        var r = document.createElementNS(SVG, 'rect');
        r.setAttribute('width', '16'); r.setAttribute('height', '16'); r.setAttribute('rx', '3'); r.setAttribute('fill', bg);
        var p = document.createElementNS(SVG, 'path');
        p.setAttribute('d', pathD); p.setAttribute('fill', fg || '#ffffff'); p.setAttribute('fill-rule', 'evenodd');
        s.appendChild(r); s.appendChild(p);
        return s;
    }
    function platformMark(p) {
        // Twitch: speech-bubble glyph on purple; Kick: a dark K on green.
        return p === 'kick'
            ? glyph('M4 3h2.6v3.6L9.3 3H12L8.6 7.6 12 13H9.2L6.6 8.8V13H4z', '#53fc18', 'Kick', '#0b0e0f')
            : glyph('M4 3h9v6l-3 3H8l-2 2v-2H4zm4 2v3h1.2V5zm2.6 0v3h1.2V5z', '#9146ff', 'Twitch');
    }
    var PALETTE = ['#ff8a80', '#ffb74d', '#ffd54f', '#aed581', '#4dd0e1', '#81d4fa', '#b39ddb', '#f48fb1', '#80cbc4', '#e6ee9c'];
    function nameColor(m) {
        var c = m.color;
        if (c && /^#[0-9a-f]{6}$/i.test(c)) {
            var r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
            if ((0.299 * r + 0.587 * g + 0.114 * b) > 70) return c;   // too dark to read over a stream: use the palette instead
        }
        var h = 0, s = String(m.login || m.name || '');
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return PALETTE[h % PALETTE.length];
    }
    var chatBox = null;
    var seen = {};
    function chatLine(m) {
        if (!chatBox || !m || seen[m.id]) return;
        seen[m.id] = true;
        var line = el('div', 'sbo-line sbo-panel' + (m.action === 'highlight' ? ' is-highlight' : ''));
        line.setAttribute('data-id', m.id);
        line.setAttribute('data-user', (m.platform || '') + ':' + (m.userId || ''));
        line.setAttribute('data-platform', m.platform || '');
        var head = el('span', 'sbo-line-head');
        if (cfg.showPlatform) head.appendChild(platformMark(m.platform));
        if (cfg.showBadges) {
            (m.badges || []).forEach(function (b) {
                if (b.kind === 'img' && b.src) {
                    var wrap = el('span', 'sbo-badge');
                    var img = el('img');
                    img.alt = b.title || '';
                    img.src = url(b.src);
                    img.addEventListener('error', function () {
                        if (b.role && ROLE_GLYPH[b.role] && wrap.parentNode) wrap.parentNode.replaceChild(glyph(ROLE_GLYPH[b.role], ROLE_COLOR[b.role] || '#555', b.title), wrap);
                        else if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
                    });
                    wrap.appendChild(img);
                    head.appendChild(wrap);
                } else if (b.kind === 'role' && ROLE_GLYPH[b.role]) {
                    head.appendChild(glyph(ROLE_GLYPH[b.role], ROLE_COLOR[b.role] || '#555', b.title || b.role));
                }
            });
        }
        var name = el('span', 'sbo-line-name', m.name || 'viewer');
        name.style.color = nameColor(m);
        head.appendChild(name);
        head.appendChild(el('span', 'sbo-line-sep', ':'));
        line.appendChild(head);
        (m.parts || []).forEach(function (p) {
            if (p.t === 'emote' && p.src) {
                var img = el('img', 'sbo-emote');
                img.alt = p.alt || '';
                img.src = url(p.src);
                img.addEventListener('error', function () { if (img.parentNode) img.parentNode.replaceChild(document.createTextNode(p.alt || ''), img); });
                line.appendChild(img);
            } else if (p.v) {
                line.appendChild(document.createTextNode(p.v));
            }
        });
        chatBox.appendChild(line);
        var max = Number(cfg.maxMessages) || 12;
        while (chatBox.children.length > max) { var first = chatBox.firstChild; delete seen[first.getAttribute('data-id')]; chatBox.removeChild(first); }
        var fade = Number(cfg.fadeAfterSec) || 0;
        if (fade > 0) setTimeout(function () { removeLine(line); }, fade * 1000);
    }
    function removeLine(line) {
        if (!line || !line.parentNode || line.classList.contains('is-gone')) return;
        line.classList.add('is-gone');
        setTimeout(function () { if (line.parentNode) { delete seen[line.getAttribute('data-id')]; line.parentNode.removeChild(line); } }, 340);
    }
    function chatRemove(d) {
        if (!chatBox) return;
        Array.prototype.slice.call(chatBox.children).forEach(function (line) {
            if ((d.id && line.getAttribute('data-id') === d.id)
                || (d.userId && line.getAttribute('data-user') === d.platform + ':' + d.userId)
                || (d.all && (!d.platform || line.getAttribute('data-platform') === d.platform))) {
                if (line.parentNode) { delete seen[line.getAttribute('data-id')]; line.parentNode.removeChild(line); }
            }
        });
    }

    // ── recent events ──
    var eventsBox = null;
    function eventRow(item, animate) {
        if (!eventsBox || !item) return;
        var row = el('div', 'sbo-event sbo-panel');
        if (!animate) row.style.animation = 'none';
        row.appendChild(el('span', 'sbo-event-mark'));
        row.appendChild(el('span', 'sbo-event-text', item.text || ''));
        eventsBox.insertBefore(row, eventsBox.firstChild);
        var max = Number(cfg.max) || 5;
        while (eventsBox.children.length > max) eventsBox.removeChild(eventsBox.lastChild);
    }

    // ── goal ──
    var goalNodes = null;
    function fmt(n) { var x = Number(n) || 0; return x.toLocaleString('en-US', { maximumFractionDigits: 2 }); }
    function drawGoal(g) {
        if (!goalNodes || !g) return;
        goalNodes.title.textContent = g.title || cfg.title || '';
        goalNodes.nums.textContent = cfg.showNumbers === false ? '' : fmt(g.current) + ' / ' + fmt(g.target);
        var pct = g.target > 0 ? Math.min(100, (Number(g.current) || 0) / g.target * 100) : 0;
        goalNodes.fill.style.width = pct.toFixed(2) + '%';
    }

    // ── counter ──
    var counterValue = null;
    function drawCounter(v, bump) {
        if (!counterValue) return;
        counterValue.textContent = v == null ? '0' : String(v);
        if (bump) { counterValue.classList.remove('is-bump'); void counterValue.offsetWidth; counterValue.classList.add('is-bump'); }
    }

    // ── now playing (the music player's card) ──
    var np = null;
    var npTimer = null;
    function drawNow(c) {
        if (!np) return;
        if (npTimer) { clearInterval(npTimer); npTimer = null; }
        if (!c) { np.card.hidden = true; return; }
        np.title.textContent = c.title || '';
        np.artist.textContent = c.artist || '';
        np.by.textContent = c.requester ? 'Requested by ' + c.requester : '';
        if (c.thumbnail && /^https:\/\//.test(c.thumbnail)) { np.art.src = c.thumbnail; np.art.hidden = false; } else { np.art.removeAttribute('src'); np.art.hidden = true; }
        np.card.hidden = false;
        var pos = Number(c.positionMs) || 0;
        var dur = Number(c.durationMs) || 0;
        var t0 = Date.now();
        var tick = function () {
            var p = c.paused ? pos : pos + (Date.now() - t0);
            np.bar.style.width = dur ? Math.min(100, p / dur * 100).toFixed(1) + '%' : '0%';
        };
        tick();
        if (!c.paused && dur) npTimer = setInterval(tick, 1000);
    }

    // ── build the widget for the type ──
    function build(state) {
        clear(widget);
        slot = null; chatBox = null; eventsBox = null; goalNodes = null; counterValue = null; np = null;
        if (type === 'chat') {
            chatBox = el('div', 'sbo-chat');
            widget.appendChild(placed(cfg.position, chatBox, cfg.width));
            seen = {};
            ((state && state.messages) || []).forEach(chatLine);
        } else if (type === 'events') {
            eventsBox = el('div', 'sbo-events');
            widget.appendChild(placed(cfg.position, eventsBox, cfg.width));
            ((state && state.items) || []).slice().reverse().forEach(function (it) { eventRow(it, false); });
        } else if (type === 'goal') {
            var g = el('div', 'sbo-goal sbo-panel');
            var head = el('div', 'sbo-goal-head');
            goalNodes = { title: el('span', 'sbo-goal-title'), nums: el('span', 'sbo-goal-nums'), fill: el('div', 'sbo-goal-fill') };
            head.appendChild(goalNodes.title); head.appendChild(goalNodes.nums);
            var track = el('div', 'sbo-goal-track');
            track.appendChild(goalNodes.fill);
            g.appendChild(head); g.appendChild(track);
            widget.appendChild(placed(cfg.position, g, cfg.width));
            drawGoal(state);
        } else if (type === 'counter') {
            var c = el('div', 'sbo-counter sbo-panel');
            if (cfg.label) c.appendChild(el('span', 'sbo-counter-label', cfg.label));
            counterValue = el('span', 'sbo-counter-value');
            c.appendChild(counterValue);
            widget.appendChild(placed(cfg.position, c));
            drawCounter(state && state.value, false);
        } else if (type === 'nowplaying') {
            var card = el('div', 'sbmo-card');
            card.hidden = true;
            var art = el('img', 'sbmo-art'); art.alt = ''; art.hidden = true;
            var text = el('div', 'sbmo-text');
            np = { card: card, art: art, title: el('p', 'sbmo-title'), artist: el('p', 'sbmo-artist'), by: el('p', 'sbmo-by'), bar: el('span') };
            text.appendChild(np.title); text.appendChild(np.artist); text.appendChild(np.by);
            var barWrap = el('div', 'sbmo-bar');
            barWrap.appendChild(np.bar);
            card.appendChild(art); card.appendChild(text); card.appendChild(barWrap);
            widget.appendChild(placed(cfg.position, card, 440));
            drawNow(state && state.now);
        }
    }
    function apply(d) {
        page = d || {};
        cfg = (type === 'alerts' ? (page.config && page.config.general) : page.config) || {};
        setVars(type === 'nowplaying' ? { margin: cfg.margin } : cfg);
        if (type === 'canvas') setVars({ fontCss: page.canvasFont, textColor: cfg.textColor, plate: cfg.plate, fontSize: cfg.fontSize });
        build(page.state || {});
    }

    // ── the stream ──
    var es = null;
    var wait = 3000;
    var stopped = false;
    var handlers = {
        hello: apply,
        config: apply,
        gone: function () { stopped = true; if (es) es.close(); clear(widget); clear(layer); },
        action: showAction,
        alert: function (a) { if (type === 'alerts') enqueue(a); },
        chat: chatLine,
        chat_remove: chatRemove,
        event: function (it) { eventRow(it, true); },
        goal: drawGoal,
        counter: function (d) { drawCounter(d.value, true); },
        nowplaying: function (d) { drawNow(d.now); },
    };
    function run(name, d) { try { handlers[name](d || {}); } catch (err) { /* one bad frame never stops the page */ } }
    function connect() {
        if (stopped) return;
        es = new EventSource(base + '/events' + (data.preview ? '?preview=1' : ''));
        es.addEventListener('open', function () { wait = 3000; });
        es.addEventListener('error', function () {
            if (es.readyState === 2 && !stopped) { setTimeout(connect, wait); wait = Math.min(30000, wait * 2); }
        });
        Object.keys(handlers).forEach(function (name) {
            es.addEventListener(name, function (e) { var d = {}; try { d = JSON.parse(e.data); } catch (x) { /* ignore */ } run(name, d); });
        });
    }
    // The guide screenshots draw invented frames without a server (scripts/site-shots); the dashboard never sets demo.
    if (data.demo) { window.__sboFeed = function (name, d) { if (handlers[name]) run(name, d); }; return; }
    connect();
})();
