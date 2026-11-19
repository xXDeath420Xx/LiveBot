'use strict';
/*
 * Local sound: the play queue (main process) and the sound library (folders on disk).
 *
 * Playback happens in a hidden renderer (src/renderer/audio.html) with HTML audio and setSinkId, so a sound can go
 * to any output device. This module decides what plays when and talks to that renderer through `backend`:
 *   backend.play({ id, src, volume, sinkId })   the renderer answers onStarted(id) / onError(id, reason)
 *   backend.stop(id | null)                     null stops everything
 *
 *   createSoundPlayer({ backend, getSettings, logger, startTimeoutMs })
 *     play({ src, name, volume, mode })  mode 'overlap' (default): plays now, on top of anything playing
 *                                        mode 'queue': waits until earlier queued sounds have finished
 *                                        → { started: true } or { queued: true, position }
 *     stopAll()                          → { stopped }   clears the queue too
 *     onStarted(id) / onEnded(id) / onError(id, reason)   called by the renderer bridge
 *     state()                            { playing, queued }
 *
 *   createLibrary({ localDir, dashboardDir })
 *     list()            [{ name, file, source: 'local' | 'dashboard' }]
 *     resolve(sound)    'https://…' → that URL; a name → the file (dashboard sounds by name first, then local
 *                       files by file name with or without extension). Paths are refused (bad_params).
 *     syncDashboard({ list, download })   keeps dashboardDir equal to the dashboard library
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.webm', '.flac', '.opus']);
const MAX_OVERLAP = 10;
const MAX_QUEUE = 50;
const MAX_DOWNLOAD = 5 * 1024 * 1024;

function fail(code, message) { const e = new Error(message || code); e.code = code; return e; }

function createSoundPlayer({ backend, getSettings = () => ({}), logger = null, startTimeoutMs = 5000 } = {}) {
    let seq = 0;
    const playing = new Map();     // id -> { name, queued: bool }
    const waiting = new Map();     // id -> { resolve, reject, timer }
    const queue = [];              // [{ id, src, name, volume }]
    let queueBusy = null;          // id of the queued sound playing now

    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[sound] ${m}`, meta); } catch { /* ignore */ } };

    function effectiveVolume(v) {
        const s = getSettings() || {};
        const master = Number.isFinite(Number(s.masterVolume)) ? Number(s.masterVolume) : 100;
        const vol = Number.isFinite(Number(v)) ? Number(v) : 100;
        return Math.max(0, Math.min(1, (vol / 100) * (master / 100)));
    }

    function start(item, isQueued) {
        const sinkId = (getSettings() || {}).outputDeviceId || 'default';
        playing.set(item.id, { name: item.name, queued: isQueued });
        if (isQueued) queueBusy = item.id;
        try {
            backend.play({ id: item.id, src: item.src, volume: effectiveVolume(item.volume), sinkId });
        } catch (e) {
            finish(item.id, e.message || 'playback_failed');
        }
    }

    function waitStart(id) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                waiting.delete(id);
                // Still loading after the wait: count it as started; an error later is only logged.
                resolve();
            }, startTimeoutMs);
            waiting.set(id, { resolve, reject, timer });
        });
    }

    function nextInQueue() {
        if (queueBusy || !queue.length) return;
        start(queue.shift(), true);
    }

    function finish(id, error = null) {
        const w = waiting.get(id);
        if (w) { clearTimeout(w.timer); waiting.delete(id); if (error) w.reject(fail('playback_failed', error)); else w.resolve(); }
        if (error) log('warn', 'a sound could not play', { name: playing.get(id)?.name, error });
        playing.delete(id);
        if (queueBusy === id) { queueBusy = null; nextInQueue(); }
    }

    return {
        async play({ src, name = null, volume = 100, mode = 'overlap' } = {}) {
            if (!src) throw fail('bad_params', 'no sound');
            const id = `s${++seq}`;
            const item = { id, src, name: name || src, volume };
            if (mode === 'queue') {
                if (queue.length >= MAX_QUEUE) throw fail('queue_full', 'too many sounds waiting');
                if (queueBusy) { queue.push(item); return { queued: true, position: queue.length }; }
                const started = waitStart(id);
                start(item, true);
                await started;
                return { started: true, mode: 'queue' };
            }
            const overlapping = [...playing.values()].filter((p) => !p.queued).length;
            if (overlapping >= MAX_OVERLAP) throw fail('too_many_sounds', `at most ${MAX_OVERLAP} sounds at once`);
            const started = waitStart(id);
            start(item, false);
            await started;
            return { started: true, mode: 'overlap' };
        },
        stopAll() {
            const n = playing.size + queue.length;
            queue.length = 0;
            for (const [id, w] of waiting) { clearTimeout(w.timer); w.resolve(); waiting.delete(id); }
            playing.clear();
            queueBusy = null;
            try { backend.stop(null); } catch { /* renderer gone */ }
            return { stopped: n };
        },
        onStarted(id) {
            const w = waiting.get(id);
            if (w) { clearTimeout(w.timer); waiting.delete(id); w.resolve(); }
        },
        onEnded(id) { finish(id); },
        onError(id, reason) { finish(id, String(reason || 'playback_failed')); },
        /** The renderer died: everything it was playing is gone. */
        reset() {
            for (const id of [...playing.keys()]) finish(id, 'audio_restarted');
            queue.length = 0;
        },
        state: () => ({ playing: playing.size, queued: queue.length }),
    };
}

function isAudioFile(f) { return AUDIO_EXT.has(path.extname(f).toLowerCase()); }

function createLibrary({ localDir, dashboardDir, logger = null }) {
    const indexFile = () => path.join(dashboardDir, 'index.json');
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[sounds] ${m}`, meta); } catch { /* ignore */ } };

    function ensure() {
        for (const d of [localDir, dashboardDir]) { try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ } }
    }
    function readIndex() {
        try {
            const j = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
            return Array.isArray(j) ? j : [];
        } catch { return []; }
    }
    function writeIndex(list) {
        const tmp = `${indexFile()}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
        fs.renameSync(tmp, indexFile());
    }
    function localFiles() {
        try {
            return fs.readdirSync(localDir, { withFileTypes: true }).filter((e) => e.isFile() && isAudioFile(e.name)).map((e) => e.name).sort((a, b) => a.localeCompare(b));
        } catch { return []; }
    }

    function list() {
        const dash = readIndex().filter((s) => s.file && fs.existsSync(path.join(dashboardDir, s.file))).map((s) => ({ name: s.name, file: path.join(dashboardDir, s.file), source: 'dashboard' }));
        const local = localFiles().map((f) => ({ name: f, file: path.join(localDir, f), source: 'local' }));
        return [...dash, ...local];
    }

    function resolve(sound) {
        const s = String(sound ?? '').trim();
        if (!s) throw fail('bad_params', 'no sound');
        if (/^https:\/\//i.test(s)) {
            try { return { src: new URL(s).href, name: s }; } catch { throw fail('bad_params', 'not a valid address'); }
        }
        if (/^[a-z]+:/i.test(s) || /[\\/]/.test(s) || s.includes('..')) throw fail('bad_params', 'use a sound name or an https:// address');
        const lower = s.toLowerCase();
        const dash = readIndex().find((x) => String(x.name).toLowerCase() === lower);
        if (dash?.file && fs.existsSync(path.join(dashboardDir, dash.file))) return { src: pathToFileURL(path.join(dashboardDir, dash.file)).href, name: dash.name };
        const files = localFiles();
        const exact = files.find((f) => f.toLowerCase() === lower);
        const stem = exact || files.find((f) => path.basename(f, path.extname(f)).toLowerCase() === lower);
        if (stem) return { src: pathToFileURL(path.join(localDir, stem)).href, name: stem };
        throw fail('sound_not_found', `no sound called ${s.slice(0, 60)}`);
    }

    /**
     * list: async () => [{ id, name, size, sha256, mime, url }]  (the engine's sounds.list)
     * download: async (url) => Buffer
     */
    async function syncDashboard({ list: fetchList, download }) {
        ensure();
        const remote = (await fetchList()).filter((r) => r && /^[A-Za-z0-9_-]{1,64}$/.test(String(r.id)) && /^[a-f0-9]{64}$/.test(String(r.sha256)));
        const old = readIndex();
        const next = [];
        let downloaded = 0;
        for (const r of remote) {
            const ext = extFor(r.mime, r.name);
            const file = `${r.id}${ext}`;
            const full = path.join(dashboardDir, file);
            const have = old.find((o) => o.id === r.id && o.sha256 === r.sha256) && fs.existsSync(full);
            if (!have) {
                if (Number(r.size) > MAX_DOWNLOAD) { log('warn', 'a dashboard sound is too large; skipped', { name: r.name }); continue; }
                const buf = await download(r.url);
                if (buf.length > MAX_DOWNLOAD) { log('warn', 'a dashboard sound is too large; skipped', { name: r.name }); continue; }
                const sha = crypto.createHash('sha256').update(buf).digest('hex');
                if (sha !== r.sha256) { log('warn', 'a dashboard sound did not match its checksum; skipped', { name: r.name }); continue; }
                fs.writeFileSync(`${full}.part`, buf);
                fs.renameSync(`${full}.part`, full);
                downloaded++;
            }
            next.push({ id: String(r.id), name: String(r.name).slice(0, 100), sha256: r.sha256, file });
        }
        const keep = new Set(next.map((n) => n.file).concat('index.json'));
        let removed = 0;
        for (const f of fs.readdirSync(dashboardDir)) {
            if (!keep.has(f)) { try { fs.rmSync(path.join(dashboardDir, f), { force: true }); removed++; } catch { /* in use */ } }
        }
        writeIndex(next);
        return { total: next.length, downloaded, removed };
    }

    ensure();
    return { list, resolve, syncDashboard, localDir, dashboardDir };
}

function extFor(mime, name) {
    const byMime = { 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/webm': '.webm', 'audio/flac': '.flac' };
    if (byMime[String(mime).toLowerCase()]) return byMime[String(mime).toLowerCase()];
    const e = path.extname(String(name || '')).toLowerCase();
    return AUDIO_EXT.has(e) ? e : '.mp3';
}

module.exports = { createSoundPlayer, createLibrary, isAudioFile, MAX_OVERLAP, MAX_QUEUE };
