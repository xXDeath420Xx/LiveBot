'use strict';
/*
 * Sound Alerts and Blerp audio (0.2.10): let CertiFried manage the audio of the streamer's SoundAlerts and Blerp browser
 * sources the way it manages "CertiFried Music" (vod-safe.js), so their sounds stay off the saved Twitch VOD.
 *
 * For each OBS browser source whose address is on soundalerts.com or blerp.com (or, with no address, whose name says
 * Sound Alerts / SoundAlerts / Blerp):
 *   - "Control audio via OBS" on (reroute_audio): the sound goes through OBS instead of Windows desktop audio, so Desktop
 *     Audio capture no longer carries it onto every track;
 *   - monitoring "Monitor and Output", so the streamer still hears it;
 *   - audio tracks: every track except the VOD track.
 * The old values of each source (reroute_audio, monitor type, tracks) are recorded first, so undo() puts them back.
 * Refused while OBS is streaming or recording (changing reroute_audio reloads the browser source), and when OBS has no VOD
 * track yet (nothing to keep them off).
 *
 *   createAlertAudio({ obs, getVod, getSaved, save, logger })
 *     find()      the matching sources: [{ name, uuid, kind: 'soundalerts' | 'blerp' }]
 *     apply()     → { applied: [names], vodTrack, skipped: [{ name, reason }] }; records the old values once (a second
 *                 apply keeps the first record, so undo always goes back to before CertiFried touched them)
 *     undo()      → { restored: [names], missing: [names] } and forgets the record
 *     status()    { managed, at, sources: [names] }
 */
const TRACKS = [1, 2, 3, 4, 5, 6];
const URL_KIND = [[/(^|\.)soundalerts\.com$/i, 'soundalerts'], [/(^|\.)blerp\.com$/i, 'blerp']];
const NAME_KIND = [[/sound ?alerts?/i, 'soundalerts'], [/\bblerp\b/i, 'blerp']];
const MONITOR = 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT';

function fail(code, message) { const e = new Error(message); e.code = code; return e; }

/** 'soundalerts' | 'blerp' | null for one browser source (its address wins over its name). */
function kindOf(name, url) {
    let host = '';
    try { host = new URL(String(url || '')).hostname; } catch { host = ''; }
    if (host) {
        for (const [re, k] of URL_KIND) if (re.test(host)) return k;
        return null;   // an address on another site: not theirs, whatever it is called
    }
    for (const [re, k] of NAME_KIND) if (re.test(String(name || ''))) return k;
    return null;
}

function createAlertAudio({ obs, getVod = async () => ({}), getSaved = () => ({}), save = () => {}, logger = null }) {
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[alert-audio] ${m}`, meta); } catch { /* ignore */ } };
    const call = (t, d) => obs.call(t, d);

    async function find() {
        if (!obs.connected) throw fail('obs_off', 'OBS is not connected');
        const inputs = ((await call('GetInputList')).inputs || []).filter((i) => /browser_source/.test(i.inputKind || i.unversionedInputKind || ''));
        const out = [];
        for (const i of inputs.slice(0, 300)) {
            let url = '';
            try { url = (await call('GetInputSettings', { inputName: i.inputName })).inputSettings?.url || ''; } catch { continue; }
            const kind = kindOf(i.inputName, url);
            if (kind) out.push({ name: i.inputName, uuid: i.inputUuid || null, kind });
        }
        return out;
    }

    async function liveCheck() {
        const [s, r] = await Promise.all([call('GetStreamStatus').catch(() => ({})), call('GetRecordStatus').catch(() => ({}))]);
        if (s.outputActive || r.outputActive) throw fail('live', 'OBS is streaming or recording. Try again after the stream.');
    }

    async function apply() {
        if (!obs.connected) throw fail('obs_off', 'OBS is not connected');
        await liveCheck();
        const vod = await getVod();
        const vodTrack = Number(vod?.vodTrack) || null;
        if (!vodTrack) throw fail('no_vod_track', 'OBS has no Twitch VOD track turned on yet, so there is no track to keep these sounds off. Turn on VOD-safe music first.');
        const list = await find();
        if (!list.length) throw fail('none_found', 'No Sound Alerts or Blerp browser source was found in OBS.');
        const saved = getSaved() || {};
        const record = Array.isArray(saved.sources) ? saved.sources.slice() : [];
        const applied = [];
        const skipped = [];
        for (const src of list) {
            try {
                const settings = (await call('GetInputSettings', { inputName: src.name })).inputSettings || {};
                const mon = (await call('GetInputAudioMonitorType', { inputName: src.name }).catch(() => ({}))).monitorType || null;
                const tracks = (await call('GetInputAudioTracks', { inputName: src.name }).catch(() => ({}))).inputAudioTracks || null;
                if (!record.some((r) => (src.uuid && r.uuid === src.uuid) || r.name === src.name)) {
                    record.push({ name: src.name, uuid: src.uuid, kind: src.kind, prev: { reroute_audio: settings.reroute_audio === true, monitorType: mon, tracks } });
                    // Written before the first change, so a crash half way still leaves the old values for undo.
                    save({ managed: true, at: saved.at || Date.now(), sources: record });
                }
                if (settings.reroute_audio !== true) await call('SetInputSettings', { inputName: src.name, inputSettings: { reroute_audio: true }, overlay: true });
                if (mon !== MONITOR) await call('SetInputAudioMonitorType', { inputName: src.name, monitorType: MONITOR });
                const want = Object.fromEntries(TRACKS.map((t) => [String(t), t !== vodTrack]));
                await call('SetInputAudioTracks', { inputName: src.name, inputAudioTracks: want });
                const check = (await call('GetInputAudioTracks', { inputName: src.name })).inputAudioTracks || {};
                if (check[String(vodTrack)]) throw fail('tracks_failed', 'still on the VOD track');
                applied.push(src.name);
            } catch (e) {
                skipped.push({ name: src.name, reason: String(e?.message || e?.code || 'failed').slice(0, 120) });
            }
        }
        save({ managed: applied.length > 0 || record.length > 0, at: saved.at || Date.now(), sources: record });
        log('info', 'Sound Alerts and Blerp audio managed', { applied: applied.length, skipped: skipped.length, vodTrack });
        return { applied, skipped, vodTrack };
    }

    async function undo() {
        if (!obs.connected) throw fail('obs_off', 'OBS is not connected');
        await liveCheck();
        const saved = getSaved() || {};
        const record = Array.isArray(saved.sources) ? saved.sources : [];
        const inputs = (await call('GetInputList')).inputs || [];
        const restored = [];
        const missing = [];
        for (const r of record) {
            const input = (r.uuid && inputs.find((i) => i.inputUuid === r.uuid)) || inputs.find((i) => i.inputName === r.name);
            if (!input) { missing.push(r.name); continue; }
            const name = input.inputName;
            await call('SetInputSettings', { inputName: name, inputSettings: { reroute_audio: !!r.prev?.reroute_audio }, overlay: true });
            if (r.prev?.monitorType) await call('SetInputAudioMonitorType', { inputName: name, monitorType: r.prev.monitorType });
            if (r.prev?.tracks && typeof r.prev.tracks === 'object') await call('SetInputAudioTracks', { inputName: name, inputAudioTracks: r.prev.tracks });
            restored.push(name);
        }
        save({ managed: false, at: null, sources: [] });
        log('info', 'Sound Alerts and Blerp audio put back', { restored: restored.length, missing: missing.length });
        return { restored, missing };
    }

    return {
        find, apply, undo,
        status() { const s = getSaved() || {}; return { managed: !!s.managed, at: s.at || null, sources: (s.sources || []).map((x) => x.name) }; },
    };
}

module.exports = { createAlertAudio, kindOf };
