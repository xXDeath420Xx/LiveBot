/*
 * The song request player inside OBS (views/stream-bot/music-overlay.ejs). It plays only what the engine sends over
 * /stream/bot/overlay/music/<key>/events and reports back to …/report: started, progress every 5 s, paused, ended, error.
 * Plain HTML audio: with "Control audio via OBS" on, OBS takes the page's sound as the source's own audio.
 * Every element is filled with textContent; nothing from the server is parsed as markup.
 */
(function () {
    'use strict';
    var data;
    try { data = JSON.parse(document.getElementById('sbmo-data').textContent); } catch (e) { return; }
    var key = data.key;
    var base = '/stream/bot/overlay/music/' + encodeURIComponent(key);
    var audio = document.getElementById('sbmo-audio');
    var card = document.getElementById('sbmo-card');
    var art = document.getElementById('sbmo-art');
    var current = null;     // { playId, durationMs, live }
    var showCard = true;
    var lastProgress = 0;

    function report(event, extra) {
        var body = { event: event, playId: current ? current.playId : null, positionMs: Math.round((audio.currentTime || 0) * 1000), durationMs: isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null };
        for (var k in (extra || {})) body[k] = extra[k];
        fetch(base + '/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(function () {});
    }
    function setText(id, text) { document.getElementById(id).textContent = text || ''; }
    function renderCard(p) {
        if (!p || !showCard) { card.hidden = true; return; }
        setText('sbmo-title', p.title);
        setText('sbmo-artist', p.artist);
        setText('sbmo-by', p.requester ? 'Requested by ' + p.requester : '');
        if (p.thumbnail && /^https:\/\//.test(p.thumbnail)) { art.src = p.thumbnail; art.hidden = false; } else { art.removeAttribute('src'); art.hidden = true; }
        card.hidden = false;
    }
    function progress() {
        var bar = document.getElementById('sbmo-progress');
        var d = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (current && current.durationMs ? current.durationMs / 1000 : 0);
        bar.style.width = d ? Math.min(100, (audio.currentTime / d) * 100).toFixed(1) + '%' : '0%';
    }

    function play(p) {
        current = { playId: p.playId, durationMs: p.durationMs, live: !!p.live };
        audio.volume = Math.max(0, Math.min(1, (Number(p.volume) || 0) / 100));
        showCard = p.card !== false;
        audio.src = base + '/audio/' + encodeURIComponent(p.playId) + '?exp=' + encodeURIComponent(p.exp) + '&sig=' + encodeURIComponent(p.sig);
        // A live Spotify song cannot be seeked here: the engine moves Spotify itself.
        var start = p.live ? 0 : Math.max(0, Number(p.startMs) || 0) / 1000;
        var seekOnce = function () { if (start > 1) { try { audio.currentTime = start; } catch (e) { /* not seekable yet */ } } audio.removeEventListener('loadedmetadata', seekOnce); };
        audio.addEventListener('loadedmetadata', seekOnce);
        renderCard(p);
        var go = audio.play();
        if (go && go.catch) go.catch(function (e) { report('error', { error: (e && e.name) || 'play_refused' }); });
    }
    function stop(hideCard) {
        try { audio.pause(); } catch (e) { /* ignore */ }
        audio.removeAttribute('src');
        try { audio.load(); } catch (e) { /* ignore */ }
        current = null;
        if (hideCard) card.hidden = true;
    }

    audio.addEventListener('playing', function () { if (current) report(audio.currentTime > 1 ? 'resumed' : 'started'); });
    audio.addEventListener('pause', function () { if (current && !audio.ended && audio.getAttribute('src')) report('paused'); });
    audio.addEventListener('ended', function () { if (current) { report('ended'); progress(); } });
    audio.addEventListener('error', function () {
        if (!current || !audio.getAttribute('src')) return;
        var code = audio.error ? audio.error.code : 0;
        report('error', { error: code === 2 ? 'network_error' : code === 3 ? 'decode_error' : code === 4 ? 'unsupported' : 'playback_error' });
    });
    audio.addEventListener('timeupdate', function () {
        progress();
        var t = Date.now();
        if (current && t - lastProgress > 5000) { lastProgress = t; report('progress'); }
    });

    var es = new EventSource(base + '/events');
    var on = function (name, fn) { es.addEventListener(name, function (e) { var d = {}; try { d = JSON.parse(e.data); } catch (x) { /* ignore */ } fn(d); }); };
    on('hello', function (d) { showCard = d.card !== false; if (typeof d.volume === 'number') audio.volume = Math.max(0, Math.min(1, d.volume / 100)); });
    on('play', play);
    on('pause', function () { try { audio.pause(); } catch (e) { /* ignore */ } });
    on('resume', function () { var go = audio.play(); if (go && go.catch) go.catch(function () {}); });
    on('seek', function (d) { if (current && current.live) return; try { audio.currentTime = Math.max(0, Number(d.positionMs) || 0) / 1000; } catch (e) { /* ignore */ } });
    on('volume', function (d) { audio.volume = Math.max(0, Math.min(1, (Number(d.volume) || 0) / 100)); });
    on('card', function (d) { showCard = d.card !== false; if (!showCard) card.hidden = true; });
    on('idle', function () { if (!current) card.hidden = true; });
    on('stop', function () { stop(true); });
})();
