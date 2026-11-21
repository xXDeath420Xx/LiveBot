/*
 * The "CertiFried Media Share" OBS page (/stream/bot/overlay/mediashare/<key>; views/stream-bot/mediashare-overlay.ejs).
 *
 * Frames from …/events (SSE): hello { showCard, video }, video { videoId, positionMs, paused, title, requester }, sync
 * { positionMs, paused }, stop, speak { src, volume }, gone.
 *
 * Videos are always muted here: their sound plays in the VOD-safe CertiFried Music source, which the server keeps in step
 * with this page. The YouTube player is driven with postMessage (enablejsapi) so no script is loaded from YouTube.
 * Speech plays from this page, one message at a time. Text is only set with textContent.
 */
(function () {
    'use strict';
    var base = location.pathname.replace(/\/+$/, '');
    var preview = /(?:^|[?&])preview=1(?:&|$)/.test(location.search);
    var stage = document.getElementById('sbms-stage');
    var frameBox = document.getElementById('sbms-frame');
    var card = document.getElementById('sbms-card');
    var speech = document.getElementById('sbms-speech');
    var showCard = true;
    var current = null;      // { videoId, iframe, time, at }
    var queue = [];
    var speaking = false;
    var es = null;
    var wait = 3000;

    function post(func, args) {
        if (!current || !current.iframe.contentWindow) return;
        try { current.iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: args || [] }), 'https://www.youtube-nocookie.com'); } catch (e) { /* not ready */ }
    }
    window.addEventListener('message', function (e) {
        if (!current || e.origin !== 'https://www.youtube-nocookie.com') return;
        var d = null;
        try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (err) { return; }
        if (d && d.info && typeof d.info.currentTime === 'number') { current.time = d.info.currentTime; current.at = Date.now(); }
    });

    function setCard(v) {
        document.getElementById('sbms-title').textContent = v && v.title ? v.title : '';
        document.getElementById('sbms-by').textContent = v && v.requester ? 'Requested by ' + v.requester : '';
        card.hidden = !(showCard && v && v.title);
    }
    function stop() {
        if (current) { current.iframe.remove(); current = null; }
        stage.hidden = true;
        setCard(null);
    }
    function show(v) {
        if (!v || !/^[A-Za-z0-9_-]{11}$/.test(String(v.videoId || ''))) { stop(); return; }
        var start = Math.max(0, Math.floor((Number(v.positionMs) || 0) / 1000));
        if (current && current.videoId === v.videoId) { align(v); setCard(v); return; }
        stop();
        var f = document.createElement('iframe');
        f.title = 'Shared video';
        f.allow = 'autoplay; encrypted-media';
        f.setAttribute('frameborder', '0');
        f.src = 'https://www.youtube-nocookie.com/embed/' + v.videoId + '?autoplay=1&mute=1&controls=0&disablekb=1&modestbranding=1&playsinline=1&rel=0&iv_load_policy=3&enablejsapi=1&start=' + start + '&origin=' + encodeURIComponent(location.origin);
        current = { videoId: v.videoId, iframe: f, time: start, at: Date.now() };
        f.addEventListener('load', function () {
            try { f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'sbms' }), 'https://www.youtube-nocookie.com'); } catch (e) { /* ignore */ }
            post('mute');
            if (v.paused) post('pauseVideo');
        });
        frameBox.appendChild(f);
        stage.hidden = false;
        setCard(v);
    }
    function align(s) {
        if (!current) return;
        post('mute');
        if (s.paused) { post('pauseVideo'); return; }
        post('playVideo');
        var want = (Number(s.positionMs) || 0) / 1000;
        var have = current.time + (Date.now() - current.at) / 1000;
        if (Math.abs(have - want) > 2.5) { post('seekTo', [want, true]); current.time = want; current.at = Date.now(); }
    }

    function nextSpeech() {
        if (speaking || !queue.length) return;
        var item = queue.shift();
        speaking = true;
        speech.src = base + '/' + item.src;
        speech.volume = Math.max(0, Math.min(1, (Number(item.volume) || 0) / 100));
        var done = function () { speaking = false; setTimeout(nextSpeech, 300); };
        speech.onended = done;
        speech.onerror = done;
        var p = speech.play();
        if (p && p.catch) p.catch(done);
    }

    function connect() {
        es = new EventSource(base + '/events' + (preview ? '?preview=1' : ''));
        es.addEventListener('hello', function (e) {
            wait = 3000;
            var d = JSON.parse(e.data || '{}');
            showCard = d.showCard !== false;
            if (d.video) show(d.video); else stop();
        });
        es.addEventListener('video', function (e) { show(JSON.parse(e.data || '{}')); });
        es.addEventListener('sync', function (e) { align(JSON.parse(e.data || '{}')); });
        es.addEventListener('stop', function () { stop(); });
        es.addEventListener('speak', function (e) {
            var d = JSON.parse(e.data || '{}');
            if (!/^tts\/[A-Za-z0-9_-]{1,20}$/.test(String(d.src || ''))) return;
            if (queue.length < 10) queue.push(d);
            nextSpeech();
        });
        es.addEventListener('gone', function () { try { es.close(); } catch (err) { /* closed */ } stop(); es = null; });
        es.onerror = function () {
            if (!es || es.readyState !== 2) return;   // the browser retries by itself unless the server answered with an error
            es = null;
            setTimeout(connect, wait);
            wait = Math.min(30000, wait * 2);
        };
    }
    connect();
})();
