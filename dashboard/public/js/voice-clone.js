/*
 * Your voice page (/stream/bot/voice; dashboard/views/stream-bot/voice.ejs). Consent, the live check, recording the
 * script, training, listening, settings and delete. Recordings are made with MediaRecorder and sent as they are
 * (WebM/Opus, or MP4 on Safari); the server decodes and checks them. CSRF: /js/csrf.js adds the header to fetch().
 */
(function () {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const data = JSON.parse(($('vc-data') || {}).textContent || '{}');
    const API = '/stream/bot/api/voice';
    let stream = null;

    function say(text, bad) {
        const m = $('vc-msg');
        if (!m) return;
        m.textContent = text || '';
        m.className = 'vc-msg' + (bad ? ' is-bad' : (text ? ' is-ok' : ''));
        if (text) m.scrollIntoView({ block: 'nearest' });
    }
    async function call(path, { method = 'POST', body = null, raw = null, type = null } = {}) {
        const headers = { accept: 'application/json' };
        let payload = null;
        if (raw) { payload = raw; headers['content-type'] = type || 'application/octet-stream'; }
        else if (body) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
        const r = await fetch(API + path, { method, credentials: 'same-origin', headers, body: payload });
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('audio/')) { if (!r.ok) throw new Error('No audio.'); return r.blob(); }
        const j = ct.includes('application/json') ? await r.json() : { ok: false, error: 'Your session expired. Reload the page.' };
        if (!r.ok || j.ok === false) throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { body: j });
        return j;
    }
    const reload = (ms = 600) => setTimeout(() => location.reload(), ms);

    async function mic() {
        if (stream) return stream;
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record audio. Try Chrome, Edge or Firefox.');
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        meter(stream);
        return stream;
    }
    function meter(s) {
        const bar = $('vc-meter-bar');
        if (!bar || !window.AudioContext) return;
        const ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        ctx.createMediaStreamSource(s).connect(an);
        const buf = new Float32Array(an.fftSize);
        let quiet = [], t0 = performance.now();
        (function tick() {
            an.getFloatTimeDomainData(buf);
            let sum = 0; for (const x of buf) sum += x * x;
            const rms = Math.sqrt(sum / buf.length);
            bar.style.width = Math.min(100, Math.round(rms * 400)) + '%';
            if (performance.now() - t0 < 5000) quiet.push(rms);
            else if (quiet) {
                const avg = quiet.reduce((a, b) => a + b, 0) / quiet.length;
                const note = $('vc-mic-note');
                if (note) note.textContent = avg > 0.02 ? 'Your room is a bit noisy. A quieter room gives a cleaner voice.' : 'Your microphone works.';
                quiet = null;
            }
            requestAnimationFrame(tick);
        })();
    }
    function recorder(s) {
        const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
        const mimeType = types.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
        const rec = new MediaRecorder(s, mimeType ? { mimeType, audioBitsPerSecond: 128000 } : {});
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        const done = new Promise((res) => { rec.onstop = () => res(new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' })); });
        rec.start();
        return { stop: () => { if (rec.state !== 'inactive') rec.stop(); return done; }, type: () => rec.mimeType || mimeType };
    }

    // ── consent ──
    const form = $('vc-consent-form');
    if (form) form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
            await call('/consent', { body: {
                typedName: $('vc-name').value, state: $('vc-state').value, agree: $('vc-agree').checked, ageAttested: $('vc-age').checked,
                ownVoice: $('vc-own').checked, keepSamples: $('vc-keep').checked, textVersion: data.consentVersion,
            } });
            say('Signed. Next: the live check.');
            reload();
        } catch (err) { say(err.message, true); btn.disabled = false; }
    });

    // ── live check ──
    const micBtn = $('vc-mic');
    if (micBtn) micBtn.addEventListener('click', async () => { try { await mic(); micBtn.disabled = true; } catch (err) { say(err.message, true); } });
    const liveStart = $('vc-live-start');
    if (liveStart) {
        let sentences = [], index = 0, rec = null, deadline = null, countdown = null;
        const stage = $('vc-live-stage');
        const show = () => {
            $('vc-live-count').textContent = 'Sentence ' + (index + 1) + ' of 3';
            $('vc-live-sentence').textContent = sentences[index];
            $('vc-live-rec').disabled = false; $('vc-live-stop').disabled = true;
            deadline = Date.now() + 10_000;
            clearInterval(countdown);
            countdown = setInterval(() => {
                const left = Math.ceil((deadline - Date.now()) / 1000);
                $('vc-live-timer').textContent = left > 0 ? 'Press Record within ' + left + ' s.' : '';
                if (left <= 0) { clearInterval(countdown); stage.hidden = true; liveStart.disabled = false; say('Too slow to start recording. Start the live check again.', true); }
            }, 250);
        };
        liveStart.addEventListener('click', async () => {
            try {
                await mic();
                liveStart.disabled = true;
                const r = await call('/challenge');
                sentences = r.sentences; index = 0; stage.hidden = false; say('');
                show();
            } catch (err) { say(err.message, true); liveStart.disabled = false; }
        });
        $('vc-live-rec').addEventListener('click', () => {
            clearInterval(countdown); $('vc-live-timer').textContent = 'Recording… press Stop when you have read it.';
            rec = recorder(stream); $('vc-live-rec').disabled = true; $('vc-live-stop').disabled = false;
        });
        $('vc-live-stop').addEventListener('click', async () => {
            $('vc-live-stop').disabled = true; $('vc-live-timer').textContent = 'Checking…';
            const blob = await rec.stop();
            try {
                const r = await call('/challenge/' + index, { raw: blob, type: blob.type });
                if (!r.done) { index = r.next; show(); return; }
                stage.hidden = true;
                if (r.passed) { say('Done, that\'s you. Next: record the script.'); reload(1200); }
                else {
                    say('That didn\'t match: ' + (r.reasons || []).join('; ') + '. ' + (r.lockedUntil ? 'The live check is paused for a day.' : 'You can try again ' + r.attemptsLeft + ' more time' + (r.attemptsLeft === 1 ? '' : 's') + ' today.'), true);
                    liveStart.disabled = !!r.lockedUntil || !r.attemptsLeft;
                }
            } catch (err) { stage.hidden = true; say(err.message, true); liveStart.disabled = false; }
        });
    }

    // ── recording the script ──
    const takeRec = $('vc-take-rec');
    if (takeRec) {
        let prompt = null, rec = null, last = null, lastUrl = null, lastId = null;
        const result = $('vc-take-result');
        const progress = (s) => {
            const mins = Math.round(s.ms / 600) / 100;
            $('vc-progress').textContent = mins + ' of ' + data.limits.minMinutes + ' minutes (' + s.count + ' sentences)';
            const t = $('vc-train'); if (t) t.disabled = mins < data.limits.minMinutes;
        };
        const next = async () => {
            try { prompt = (await call('/prompt', { method: 'GET' })).prompt; $('vc-take-sentence').textContent = prompt.text; }
            catch (err) { $('vc-take-sentence').textContent = err.message; }
        };
        next();
        takeRec.addEventListener('click', async () => {
            try { await mic(); } catch (err) { say(err.message, true); return; }
            rec = recorder(stream); takeRec.disabled = true; $('vc-take-stop').disabled = false; result.textContent = 'Recording…';
        });
        $('vc-take-stop').addEventListener('click', async () => {
            $('vc-take-stop').disabled = true; result.textContent = 'Checking…';
            last = await rec.stop();
            if (lastUrl) URL.revokeObjectURL(lastUrl);
            lastUrl = URL.createObjectURL(last);
            $('vc-take-play').disabled = false;
            try {
                const r = await call('/takes?prompt=' + prompt.index, { raw: last, type: last.type });
                if (r.ok && r.sampleId) {
                    lastId = r.sampleId; result.textContent = 'Saved.'; result.className = 'vc-result is-ok'; $('vc-take-redo').disabled = false;
                    progress(r.summary); await next();
                } else { result.textContent = r.reason; result.className = 'vc-result is-bad'; lastId = null; $('vc-take-redo').disabled = true; }
            } catch (err) { result.textContent = err.message; result.className = 'vc-result is-bad'; }
            takeRec.disabled = false;
        });
        $('vc-take-play').addEventListener('click', () => { if (lastUrl) new Audio(lastUrl).play(); });
        $('vc-take-redo').addEventListener('click', async () => {
            if (!lastId) return;
            try { const r = await call('/takes/' + lastId, { method: 'DELETE' }); progress(r.summary); result.textContent = 'Removed. Read it again.'; lastId = null; $('vc-take-redo').disabled = true; }
            catch (err) { say(err.message, true); }
        });
    }
    const train = $('vc-train');
    if (train) train.addEventListener('click', async () => {
        train.disabled = true;
        try { await call('/train'); say('Queued for training.'); reload(); } catch (err) { say(err.message, true); train.disabled = false; }
    });
    const cancel = $('vc-cancel');
    if (cancel) cancel.addEventListener('click', async () => { try { await call('/train/cancel'); reload(); } catch (err) { say(err.message, true); } });

    // ── listen, settings, approve ──
    const play = $('vc-play');
    async function saveSettings(extra = {}) {
        await call('/settings', { body: { speed: $('vc-speed')?.value, clarity: $('vc-clarity')?.value, ...extra } });
    }
    if (play) play.addEventListener('click', async () => {
        play.disabled = true;
        try {
            await saveSettings();
            const blob = await call('/preview', { body: { text: $('vc-test-text').value } });
            const url = URL.createObjectURL(blob);
            const a = new Audio(url); a.onended = () => URL.revokeObjectURL(url); a.play();
        } catch (err) { say(err.message, true); }
        play.disabled = false;
    });
    const approve = $('vc-approve');
    if (approve) approve.addEventListener('click', async () => {
        try { const r = await call('/approve'); say(r.active ? 'Your voice is ready.' : 'Approved. It becomes active once the CertiFried owner approves it too.'); reload(1200); }
        catch (err) { say(err.message, true); }
    });
    const auto = $('vc-auto');
    if (auto) auto.addEventListener('change', async () => {
        try { await saveSettings({ automations: auto.checked }); say(auto.checked ? 'Your automations can use your voice.' : 'Your automations no longer use your voice.'); }
        catch (err) { say(err.message, true); auto.checked = !auto.checked; }
    });

    for (const [id, key, onText, offText] of [['vc-viewer', 'viewerText', 'Your voice now reads other people’s messages in your own places.', 'Other people’s messages are read in a stock voice again.'], ['vc-isaid', 'iSaid', 'The reader says “I said” for your messages.', 'The reader says your name for your messages.']]) {
        const box = $(id);
        if (box) box.addEventListener('change', async () => {
            try { await call('/settings', { body: { [key]: box.checked } }); say(box.checked ? onText : offText); }
            catch (err) { say(err.message, true); box.checked = !box.checked; }
        });
    }

    // ── delete ──
    const del = $('vc-del');
    if (del) del.addEventListener('click', async () => {
        del.disabled = true;
        try {
            const r = await call('/delete', { body: { confirm: $('vc-del-confirm').value } });
            const t = (d) => new Date(d).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
            $('vc-del-result').textContent = 'Your voice is gone. It stopped working straight away, the files were removed at ' + t(r.result.filesRemovedAt)
                + ', and backup copies expire by ' + new Date(r.result.backupsExpireBy).toLocaleDateString('en-US', { dateStyle: 'long' }) + '.';
            setTimeout(() => location.reload(), 4000);
        } catch (err) { say(err.message, true); del.disabled = false; }
    });
})();
