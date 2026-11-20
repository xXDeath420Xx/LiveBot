/*
 * A CertiFried overlay inside OBS (views/stream-bot/overlay.ejs). It shows only what the server sends over
 * <base>/events (SSE) and acknowledges overlay actions to <base>/report. Types: alerts, chat, events, goal, counter,
 * nowplaying, canvas, scene; every type also shows the "Show text" and "Show an image or video" actions. A scene screen
 * draws the streamer's artwork (cover fit) with its title, scrolling line, countdown, glows and weather effects; it stops
 * its animation loops before it is drawn again (a settings save).
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
        if (m) {
            var mw = el('div', 'sbo-alert-media'); mw.appendChild(m); box.appendChild(mw);
            if (m.tagName === 'VIDEO' && a.sound) m.muted = true;
            // "Image size": a share of the file's own size (100 keeps the layout's usual limits).
            var scale = Number(a.mediaScale) || 100;
            if (scale !== 100) {
                var sized = function () {
                    var w = m.tagName === 'VIDEO' ? m.videoWidth : m.naturalWidth;
                    if (w) { m.style.maxWidth = 'none'; m.style.maxHeight = 'none'; m.style.width = Math.round(w * scale / 100) + 'px'; }
                };
                m.addEventListener(m.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', sized);
            }
        }
        var txt = el('div', 'sbo-alert-text sbo-panel');
        txt.appendChild(titleNode(a));
        if (a.detail) txt.appendChild(el('p', 'sbo-alert-detail', a.detail));
        var over = m && a.layout === 'over';
        // Over the picture only the title and second line sit on it; the viewer's message goes underneath.
        if (a.message && !over) txt.appendChild(el('p', 'sbo-alert-message', a.message));
        if (over) m.parentNode.appendChild(txt); else box.appendChild(txt);
        if (a.message && over) { var under = el('div', 'sbo-alert-under sbo-panel'); under.appendChild(el('p', 'sbo-alert-message', a.message)); box.appendChild(under); }
        var delay = Math.max(0, Math.min(5000, Number(a.textDelayMs) || 0));
        if (delay) { txt.classList.add('sbo-text-wait'); setTimeout(function () { txt.classList.remove('sbo-text-wait'); txt.classList.add('sbo-in--fade'); }, delay); }
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
        // Twitch: speech-bubble glyph on purple; Kick: a dark K on green; YouTube: a white play triangle on red.
        if (p === 'youtube') return glyph('M6 4.5v7l6-3.5z', '#ff0000', 'YouTube');
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
    function clock(ms) {
        var s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
        return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (x < 10 ? '0' : '') + x;
    }
    function drawNow(c) {
        if (!np) return;
        if (npTimer) { clearInterval(npTimer); npTimer = null; }
        if (!c) { np.card.hidden = true; return; }
        np.title.textContent = c.title || '';
        np.artist.textContent = c.artist || '';
        np.by.textContent = c.requester ? 'Requested by ' + c.requester : '';
        var thumb = c.thumbnail && /^https:\/\//.test(c.thumbnail) ? c.thumbnail : null;
        if (thumb && cfg.showArt !== false) { np.art.src = thumb; np.art.hidden = false; } else { np.art.removeAttribute('src'); np.art.hidden = true; }
        if (np.blur) { if (thumb) { np.blur.src = thumb; np.blur.hidden = false; } else { np.blur.removeAttribute('src'); np.blur.hidden = true; } }
        np.card.hidden = false;
        var pos = Number(c.positionMs) || 0;
        var dur = Number(c.durationMs) || 0;
        var t0 = Date.now();
        var tick = function () {
            var p = c.paused ? pos : pos + (Date.now() - t0);
            np.bar.style.width = dur ? Math.min(100, p / dur * 100).toFixed(1) + '%' : '0%';
            if (np.now) { np.now.textContent = clock(dur ? Math.min(p, dur) : p); np.total.textContent = clock(dur); }
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
            var card = el('div', 'sbmo-card' + (cfg.background === 'cover' ? ' sbo-np--cover' : ''));
            card.hidden = true;
            var art = el('img', 'sbmo-art'); art.alt = ''; art.hidden = true;
            var text = el('div', 'sbmo-text');
            np = { card: card, art: art, title: el('p', 'sbmo-title'), artist: el('p', 'sbmo-artist'), by: el('p', 'sbmo-by'), bar: el('span'), blur: null, now: null, total: null };
            if (cfg.background === 'cover') { np.blur = el('img', 'sbo-np-blur'); np.blur.alt = ''; np.blur.hidden = true; card.appendChild(np.blur); }
            text.appendChild(np.title); text.appendChild(np.artist); text.appendChild(np.by);
            var barWrap = el('div', 'sbmo-bar');
            barWrap.appendChild(np.bar);
            card.appendChild(art); card.appendChild(text);
            if (cfg.showTimes) {
                var row = el('div', 'sbo-np-times');
                np.now = el('span', 'sbo-np-time'); np.total = el('span', 'sbo-np-time');
                row.appendChild(np.now); row.appendChild(barWrap); row.appendChild(np.total);
                card.appendChild(row);
            } else {
                card.appendChild(barWrap);
            }
            if (cfg.titleSize) card.style.setProperty('--sbo-np-title', cfg.titleSize + 'px');
            if (cfg.barColor) card.style.setProperty('--sbo-np-bar', cfg.barColor);
            widget.appendChild(placed(cfg.position, card, cfg.width || 440));
            drawNow(state && state.now);
        } else if (type === 'scene') {
            buildScene(state || {});
        }
    }
    // ── scene screen: artwork, title, scrolling line, countdown, glows and weather (all in % of the artwork) ──
    var sceneStop = null;
    function rgbOf(h) {
        var m = String(h || '').match(/^#?([0-9a-f]{6})$/i);
        var n = m ? parseInt(m[1], 16) : 0xffffff;
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    function rgbaOf(h, a) { var c = rgbOf(h); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
    function shade(h, f) {
        return 'rgb(' + rgbOf(h).map(function (x) { return Math.round(f < 0 ? x * (1 + f) : x + (255 - x) * f); }).join(',') + ')';
    }
    function fitCanvas(cv) {
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var r = cv.getBoundingClientRect();
        cv.width = Math.max(2, Math.round(r.width * dpr));
        cv.height = Math.max(2, Math.round(r.height * dpr));
        cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
        return { w: r.width, h: r.height };
    }
    function buildScene(state) {
        if (sceneStop) { sceneStop(); sceneStop = null; }
        var alive = true;
        var timers = [];
        var onResize = [];
        sceneStop = function () {
            alive = false;
            timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
            onResize.forEach(function (f) { window.removeEventListener('resize', f); });
        };
        function frames(fn) { var f = function (t) { if (!alive) return; fn(t); requestAnimationFrame(f); }; requestAnimationFrame(f); }
        function resized(fn) { onResize.push(fn); window.addEventListener('resize', fn); }
        function pct(n, v) { n.style.left = v.x + '%'; n.style.top = v.y + '%'; }
        var c = cfg;
        var kinds = state.media || {};
        var root = el('div', 'sbs');
        var art = el('div', 'sbs-art');
        var kb = el('div', 'sbs-kb' + (c.kenBurns ? '' : ' is-still'));
        kb.style.setProperty('--sbs-kb-scale', String((Number(c.kenBurnsScale) || 106) / 100));
        kb.style.setProperty('--sbs-kb-sec', (Number(c.kenBurnsSec) || 38) + 's');
        art.appendChild(kb);
        root.appendChild(art);
        var aspect = 16 / 9;
        function fitArt() { art.style.width = 'max(100vw, calc(100vh * ' + aspect.toFixed(5) + '))'; art.style.aspectRatio = aspect.toFixed(5); }
        fitArt();
        function mediaEl(id, cls) {
            if (!id) return null;
            var n;
            if (kinds[id] === 'video') { n = el('video', cls); n.muted = true; n.loop = true; n.autoplay = true; n.playsInline = true; }
            else { n = el('img', cls); n.alt = ''; }
            n.src = url('media/' + id);
            return n;
        }
        var bg = mediaEl(c.background, 'sbs-bg');
        // A see-through window in the artwork (a camera placed behind this source shows through it), soft-edged.
        function cutWindow() {
            var wv = c.window || {};
            if (!bg || !wv.enabled) return;
            var W = 1000, H = Math.max(2, Math.round(1000 / aspect));
            var cv = document.createElement('canvas');
            cv.width = W; cv.height = H;
            var g = cv.getContext('2d');
            g.fillStyle = '#000';
            g.fillRect(0, 0, W, H);
            g.globalCompositeOperation = 'destination-out';
            g.filter = 'blur(' + Math.max(0.5, (Number(wv.feather) || 0) / 100 * W) + 'px)';
            g.fillRect(wv.x / 100 * W, wv.y / 100 * H, wv.w / 100 * W, wv.h / 100 * H);
            var mask = 'url("' + cv.toDataURL('image/png') + '")';
            bg.style.webkitMaskImage = mask; bg.style.maskImage = mask;
            bg.style.webkitMaskSize = '100% 100%'; bg.style.maskSize = '100% 100%';
        }
        if (bg) {
            kb.appendChild(bg);
            var known = function () {
                var w = bg.tagName === 'VIDEO' ? bg.videoWidth : bg.naturalWidth;
                var h = bg.tagName === 'VIDEO' ? bg.videoHeight : bg.naturalHeight;
                if (w && h) { aspect = w / h; fitArt(); cutWindow(); }
            };
            bg.addEventListener(bg.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', known);
        }
        if (Number(c.dim) > 0) { var dim = el('div', 'sbs-dim'); dim.style.opacity = String(Number(c.dim) / 100); kb.appendChild(dim); }
        var ins = c.inset || {};
        var inset = c.window && c.window.enabled ? null : mediaEl(ins.media, 'sbs-inset');
        if (inset) { pct(inset, ins); inset.style.width = ins.w + '%'; inset.style.height = ins.h + '%'; kb.appendChild(inset); }
        (c.glows || []).forEach(function (gl) {
            var g = el('div', 'sbs-glow sbs-glow--' + (gl.style || 'pulse'));
            pct(g, gl);
            g.style.width = gl.size + 'cqw'; g.style.height = gl.size + 'cqw';
            g.style.background = 'radial-gradient(circle, ' + rgbaOf(gl.color, 0.95) + ' 0%, ' + rgbaOf(gl.color, 0.55) + ' 35%, ' + rgbaOf(gl.color, 0.12) + ' 62%, ' + rgbaOf(gl.color, 0) + ' 78%)';
            kb.appendChild(g);
        });
        if (c.smoke && c.smoke.enabled) {
            var sw = el('div', 'sbs-smoke');
            pct(sw, c.smoke);
            var scv = document.createElement('canvas');
            sw.appendChild(scv);
            kb.appendChild(sw);
            var sctx = scv.getContext('2d');
            var SW = 0, SH = 0, puffs = [], acc = 0, rate = Math.max(0.1, (Number(c.smoke.intensity) || 100) / 100);
            var ssize = function () { var s = fitCanvas(scv); SW = s.w; SH = s.h; };
            timers.push(setTimeout(ssize, 0)); resized(ssize);
            frames(function (t) {
                if (!SW) return;
                sctx.clearRect(0, 0, SW, SH);
                acc += 1;
                if (acc >= 7 / rate) {
                    acc = 0;
                    puffs.push({ x: SW * 0.5 + (Math.random() - 0.5) * SW * 0.06, y: SH * 0.97, r: SW * 0.04 + Math.random() * SW * 0.03, vy: -(SH * 0.0016 + Math.random() * SH * 0.0014),
                        vx: (Math.random() * 0.4 + 0.1) * (SW * 0.0016), grow: 1.004 + Math.random() * 0.004, phase: Math.random() * Math.PI * 2, life: 0, max: 150 + Math.random() * 90 });
                }
                for (var i = puffs.length - 1; i >= 0; i--) {
                    var p = puffs[i];
                    p.life++; p.y += p.vy; p.x += p.vx + Math.sin(t * 0.0012 + p.phase) * 0.4; p.r *= p.grow;
                    var k = p.life / p.max;
                    if (k >= 1) { puffs.splice(i, 1); continue; }
                    var a = (k < 0.2 ? k / 0.2 : (1 - k)) * 0.16;
                    var gr = sctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
                    gr.addColorStop(0, 'rgba(210,210,205,' + a + ')'); gr.addColorStop(1, 'rgba(210,210,205,0)');
                    sctx.fillStyle = gr; sctx.beginPath(); sctx.arc(p.x, p.y, p.r, 0, 7); sctx.fill();
                }
            });
        }
        if (Number(c.fog) > 0) {
            var fog = el('div', 'sbs-fog');
            fog.style.opacity = String(Number(c.fog) / 100);
            ['f1', 'f2', 'f3'].forEach(function (k) { fog.appendChild(el('span', k)); });
            root.appendChild(fog);
        }
        function fullCanvas(cls) { var cv = document.createElement('canvas'); cv.className = cls; root.appendChild(cv); return cv; }
        if (Number(c.embers) > 0) {
            var ecv = fullCanvas('sbs-fx');
            var ectx = ecv.getContext('2d');
            var EW = 0, EH = 0, parts = [];
            var centre = c.emberArea === 'centre';
            var spawn = function (reset) {
                return centre
                    ? { x: EW * 0.26 + Math.random() * EW * 0.52, y: reset ? EH + Math.random() * EH * 0.35 : EH * 0.45 + Math.random() * EH * 0.55, r: 0.4 + Math.random() * 1.5,
                        vy: 0.25 + Math.random() * 0.65, sway: 0.4 + Math.random() * 0.9, phase: Math.random() * Math.PI * 2, life: 0, max: 240 + Math.random() * 360, hue: 24 + Math.random() * 18 }
                    : { x: Math.random() * EW, y: reset ? EH + Math.random() * EH * 0.4 : Math.random() * EH, r: 0.5 + Math.random() * 1.9,
                        vy: 0.25 + Math.random() * 0.7, sway: 0.4 + Math.random() * 0.9, phase: Math.random() * Math.PI * 2, life: 0, max: 280 + Math.random() * 420, hue: 25 + Math.random() * 20 };
            };
            var esize = function () { var s = fitCanvas(ecv); EW = s.w; EH = s.h; parts = []; for (var i = 0; i < Number(c.embers); i++) parts.push(spawn(false)); };
            timers.push(setTimeout(esize, 0)); resized(esize);
            frames(function (t) {
                if (!EW) return;
                ectx.clearRect(0, 0, EW, EH);
                ectx.globalCompositeOperation = 'lighter';
                parts.forEach(function (p) {
                    p.life++; p.y -= p.vy; p.x += Math.sin((t * 0.001 * p.sway) + p.phase) * 0.4;
                    var k = p.life / p.max;
                    var fade = k < 0.12 ? k / 0.12 : (k > 0.7 ? (1 - k) / 0.3 : 1);
                    var a = centre ? fade * Math.min(1, p.y / (EH * 0.55)) * 0.5 : fade * 0.55;
                    if ((centre ? p.y < EH * 0.05 : p.y < -10) || p.life > p.max) { var n = spawn(true); Object.keys(n).forEach(function (key) { p[key] = n[key]; }); return; }
                    var rr = p.r * (centre ? 2.6 : 3);
                    var g = ectx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
                    g.addColorStop(0, 'hsla(' + p.hue + ',95%,62%,' + a + ')'); g.addColorStop(1, 'hsla(' + p.hue + ',95%,55%,0)');
                    ectx.fillStyle = g; ectx.beginPath(); ectx.arc(p.x, p.y, rr, 0, 7); ectx.fill();
                });
            });
        }
        if (Number(c.rain) > 0) {
            var rcv = fullCanvas('sbs-fx');
            var rctx = rcv.getContext('2d');
            var RW = 0, RH = 0, drops = [];
            var mk = function () { return { x: Math.random() * RW * 1.2 - RW * 0.1, y: Math.random() * RH, len: 8 + Math.random() * 16, sp: 9 + Math.random() * 9, a: 0.05 + Math.random() * 0.12 }; };
            var rsize = function () { var s = fitCanvas(rcv); RW = s.w; RH = s.h; drops = []; for (var i = 0; i < Math.round(220 * Number(c.rain) / 100); i++) drops.push(mk()); };
            timers.push(setTimeout(rsize, 0)); resized(rsize);
            frames(function () {
                if (!RW) return;
                rctx.clearRect(0, 0, RW, RH);
                rctx.lineWidth = 1;
                rctx.lineCap = 'round';
                drops.forEach(function (d) {
                    rctx.strokeStyle = 'rgba(185,205,225,' + d.a + ')';
                    rctx.beginPath(); rctx.moveTo(d.x, d.y); rctx.lineTo(d.x + 0.18 * d.len, d.y + d.len); rctx.stroke();
                    d.y += d.sp; d.x += 0.18 * d.sp;
                    if (d.y > RH) { d.y = -20; d.x = Math.random() * RW * 1.2 - RW * 0.1; }
                });
            });
        }
        if (Number(c.vignette) > 0) { var vg = el('div', 'sbs-vignette'); vg.style.setProperty('--sbs-vig', String(Number(c.vignette) / 100)); root.appendChild(vg); }
        if (c.lightning) {
            var bolt = el('div', 'sbs-lightning');
            root.appendChild(bolt);
            var flash = function () {
                if (!alive) return;
                bolt.classList.remove('is-on'); void bolt.offsetWidth; bolt.classList.add('is-on');
                timers.push(setTimeout(flash, 7000 + Math.random() * 12000));
            };
            timers.push(setTimeout(flash, 2500 + Math.random() * 4000));
        }
        root.style.setProperty('--sbs-glow', rgbOf(c.glowColor).join(','));
        if (c.title) {
            var tw = el('div', 'sbs-title-wrap');
            tw.style.top = c.titleY + '%';
            var title = el('p', 'sbs-title sbs-title--' + (c.titleStyle || 'glow'), c.title);
            title.style.fontSize = c.titleSize + 'px';
            title.style.color = c.titleColor;
            if (c.titleStyle === 'shimmer') {
                title.style.backgroundImage = 'linear-gradient(100deg, ' + shade(c.titleColor, -0.35) + ' 0%, ' + c.titleColor + ' 30%, ' + shade(c.titleColor, 0.45) + ' 50%, ' + c.titleColor + ' 70%, ' + shade(c.titleColor, -0.35) + ' 100%)';
            }
            tw.appendChild(title);
            root.appendChild(tw);
        }
        if (c.subtitle) {
            var sub = el('p', 'sbs-sub', c.subtitle);
            sub.style.fontSize = c.subtitleSize + 'px';
            sub.style.color = c.subtitleColor;
            if (c.subtitleMode === 'marquee') {
                var mq = el('div', 'sbs-marquee');
                mq.style.top = c.subtitleY + '%';
                var track = el('span', 'sbs-track');
                track.style.animationDuration = (Number(c.marqueeSec) || 18) + 's';
                track.appendChild(sub);
                mq.appendChild(track);
                root.appendChild(mq);
            } else {
                var still = el('div', 'sbs-line');
                still.style.top = c.subtitleY + '%';
                still.appendChild(sub);
                root.appendChild(still);
            }
        }
        if (c.countdown && c.countdown.enabled) {
            var cdw = el('div', 'sbs-line');
            cdw.style.top = c.countdown.y + '%';
            var cdt = el('p', 'sbs-count');
            cdt.style.color = c.subtitleColor;
            cdw.appendChild(cdt);
            root.appendChild(cdw);
            // Counts from when this source is shown (Studio creates it with "Refresh browser when scene becomes active").
            var ends = Date.now() + (Number(c.countdown.minutes) || 5) * 60000;
            var paint = function () {
                var left = ends - Date.now();
                cdt.textContent = left > 0 ? (c.countdown.label ? c.countdown.label + ' ' : '') + clock(left + 999) : (c.countdown.endText || '');
            };
            paint();
            timers.push(setInterval(paint, 250));
        }
        if (c.socials) {
            var so = el('div', 'sbs-line');
            so.style.top = c.socialsY + '%';
            var sp = el('p', 'sbs-socials', c.socials);
            sp.style.color = c.subtitleColor;
            so.appendChild(sp);
            root.appendChild(so);
        }
        if (Number(c.grain) > 0) {
            var gcv = document.createElement('canvas');
            gcv.width = 170; gcv.height = 170;
            var gctx = gcv.getContext('2d');
            var img = gctx.createImageData(170, 170);
            for (var i = 0; i < img.data.length; i += 4) { var v = Math.random() * 255; img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255; }
            gctx.putImageData(img, 0, 0);
            var grain = el('div', 'sbs-grain');
            grain.style.backgroundImage = 'url("' + gcv.toDataURL('image/png') + '")';
            grain.style.opacity = String(Number(c.grain) / 100);
            root.appendChild(grain);
        }
        widget.appendChild(root);
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
