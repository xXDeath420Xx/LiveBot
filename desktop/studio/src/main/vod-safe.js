'use strict';
/*
 * VOD-safe music: song-request music must never reach the saved Twitch VOD.
 *
 * How OBS does it: with Advanced output, Twitch gets the live mix on the streaming track and a second "VOD track"
 * (AdvOut VodTrackEnabled / VodTrackIndex) that becomes the VOD's audio. A source left off the VOD track is heard live
 * but is missing from the VOD.
 *
 * What Studio enforces (always on; the owner asked for it to be forced):
 *   - Music plays only through one OBS browser source, "CertiFried Music" (found again by its input UUID, so renaming
 *     it is fine), with "Control audio via OBS" (reroute_audio) so it never touches Windows desktop audio, monitored
 *     ("Monitor and Output") so the streamer hears it, and referenced in every scene so it plays whatever scene is live.
 *   - Its audio tracks are every track EXCEPT the VOD track. Checked and re-applied when OBS connects, the scene
 *     collection or profile changes, scenes are added, the source is re-created or renamed, its tracks change, the
 *     stream starts, and before every song (the music.prepare action).
 *   - VOD track off, or on the same track as the live audio, while OBS is idle: Studio backs up the profile's basic.ini
 *     and turns the VOD track on (track 2 unless that is the live track) with SetProfileParameter.
 *   - While streaming or recording and protection is not active: fail closed. vodSafe is false, songs are refused, and
 *     the reason says when it will turn on.
 *   - Simple output mode: not switched automatically. The Simple and Advanced encoder settings live in different places
 *     (Advanced keeps its encoder and bitrate in streamEncoder.json, which obs-websocket cannot write), so a switch could
 *     silently change the stream's bitrate. Studio explains the steps and keeps music paused.
 * The person's other sources are reported, never changed, except by their own click on "Keep out of VOD".
 *
 *   createVodSafe({ obs, logger, getSettings, saveSettings, backupProfile, getMusicUrl, now })
 *     ensure(why)              run the checks and fixes; resolves to status()
 *     prepare()                ensure('song'); throws code vod_unsafe when music must not play
 *     status()                 { vodSafe, reason, mode, vodTrack, liveTrack, live, sourceReady, sourceName, warnings[], desktopWarning, recordWithoutMusic, checkedAt }
 *     keepOutOfVod(inputName)  one source, on the person's click
 *     setRecordWithoutMusic(on) recording tracks = the VOD track only (on), or back to what they were (off); idle only
 *     onObsEvent(type, data)   feed OBS events in
 */
const TRACKS = [1, 2, 3, 4, 5, 6];
const MUSIC_NAME = 'CertiFried Music';
// CertiFried's own alert box and Text and media overlay are named by Studio (obs-overlays.js) so they are listed here too.
const MUSICY = /\b(bgm|music|song|songs|spotify|soundcloud|sound ?alerts?|blerp|meme|sfx|playlist|radio|lofi|lo-fi|pretzel|streambeats|jukebox|dj|certifried alerts|certifried canvas)\b/i;
const AUDIO_KINDS = /^(wasapi_|ffmpeg_source|vlc_source|browser_source|coreaudio|pulse_|alsa_|jack_|dshow_input|app_audio_capture|wasapi_process_output_capture)/;
const REASONS = {
    obs_off: 'Music is paused: Studio is not connected to OBS.',
    simple_mode: 'Music is paused: OBS uses Simple output, which has no VOD track. In OBS open Settings, Output, set Output Mode to Advanced, then on the Streaming tab tick Twitch VOD Track and pick a track other than the streaming track.',
    live_unprotected: 'Music is paused: VOD protection is not active in OBS. It turns on at the next stream start.',
    no_backup: 'Music is paused: Studio could not back up the OBS profile, so it did not change it.',
    source_failed: 'Music is paused: the CertiFried Music source could not be set up in OBS.',
    tracks_failed: 'Music is paused: the CertiFried Music source could not be kept off the VOD track.',
};

function fail(code, message) { const e = new Error(message); e.code = code; return e; }

function createVodSafe({ obs, logger = null, getSettings = () => ({}), saveSettings = () => {}, backupProfile = async () => null, getMusicUrl = async () => null, now = () => Date.now() }) {
    let st = { vodSafe: false, reason: REASONS.obs_off, mode: null, vodTrack: null, liveTrack: null, live: false, sourceReady: false, sourceName: MUSIC_NAME, warnings: [], desktopWarning: false, recordWithoutMusic: false, checkedAt: null, changes: [] };
    let running = null;
    let again = false;
    const listeners = new Set();
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[vod-safe] ${m}`, meta); } catch { /* ignore */ } };
    const call = (t, d) => obs.call(t, d);
    const param = async (category, name) => {
        try { return String((await call('GetProfileParameter', { parameterCategory: category, parameterName: name })).parameterValue ?? ''); } catch { return ''; }
    };

    function set(next) {
        st = { ...st, ...next, checkedAt: now() };
        for (const fn of listeners) { try { fn(st); } catch { /* ignore */ } }
    }

    async function isLive() {
        const [s, r] = await Promise.all([call('GetStreamStatus').catch(() => ({})), call('GetRecordStatus').catch(() => ({}))]);
        return { streaming: !!s.outputActive, recording: !!r.outputActive, live: !!s.outputActive || !!r.outputActive };
    }

    /** Find the music input by its UUID, then by name; create it when missing. Returns { name, uuid }. */
    async function ensureSource() {
        const settings = getSettings();
        const inputs = (await call('GetInputList')).inputs || [];
        let input = settings.sourceUuid ? inputs.find((i) => i.inputUuid === settings.sourceUuid) : null;
        if (!input) input = inputs.find((i) => i.inputName === MUSIC_NAME && /browser_source/.test(i.inputKind || ''));
        const url = await getMusicUrl().catch(() => null);
        const sceneList = await call('GetSceneList');
        const scenes = (sceneList.scenes || []).map((s) => s.sceneName);
        if (!input) {
            const target = sceneList.currentProgramSceneName || scenes[0];
            if (!target) throw fail('no_scene', 'OBS has no scene to put the music source in');
            let name = MUSIC_NAME;
            for (let n = 2; inputs.some((i) => i.inputName === name); n++) name = `${MUSIC_NAME} ${n}`;
            const r = await call('CreateInput', {
                sceneName: target, inputName: name, inputKind: 'browser_source', sceneItemEnabled: true,
                inputSettings: { url: url || 'about:blank', width: 400, height: 100, reroute_audio: true, shutdown: false, restart_when_active: false },
            });
            input = { inputName: name, inputUuid: r.inputUuid, inputKind: 'browser_source' };
            st.changes.push(`Created the ${name} browser source`);
            log('info', 'music source created', { scene: target });
        }
        if (input.inputUuid && input.inputUuid !== settings.sourceUuid) saveSettings({ sourceUuid: input.inputUuid });
        // Its own settings: audio through OBS, never desktop audio; the music page once the server has it.
        const cur = await call('GetInputSettings', { inputName: input.inputName });
        const want = { reroute_audio: true, ...(url && cur.inputSettings?.url !== url ? { url } : {}) };
        if (cur.inputSettings?.reroute_audio !== true || want.url) await call('SetInputSettings', { inputName: input.inputName, inputSettings: want, overlay: true });
        const mon = await call('GetInputAudioMonitorType', { inputName: input.inputName }).catch(() => ({}));
        if (mon.monitorType !== 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT') await call('SetInputAudioMonitorType', { inputName: input.inputName, monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' });
        // In every scene, so it plays whichever scene is live.
        for (const scene of scenes) {
            const items = (await call('GetSceneItemList', { sceneName: scene })).sceneItems || [];
            if (!items.some((it) => it.sourceName === input.inputName || (input.inputUuid && it.sourceUuid === input.inputUuid))) {
                await call('CreateSceneItem', { sceneName: scene, sourceName: input.inputName, sceneItemEnabled: true });
            }
        }
        return { name: input.inputName, uuid: input.inputUuid };
    }

    async function setMusicTracks(name, vodTrack) {
        const want = Object.fromEntries(TRACKS.map((t) => [String(t), t !== vodTrack]));
        const cur = (await call('GetInputAudioTracks', { inputName: name })).inputAudioTracks || {};
        if (TRACKS.some((t) => !!cur[String(t)] !== want[String(t)])) await call('SetInputAudioTracks', { inputName: name, inputAudioTracks: want });
        const check = (await call('GetInputAudioTracks', { inputName: name })).inputAudioTracks || {};
        return TRACKS.every((t) => !!check[String(t)] === want[String(t)]);
    }

    async function scanOthers(musicName, vodTrack) {
        const inputs = ((await call('GetInputList')).inputs || []).filter((i) => i.inputName !== musicName && AUDIO_KINDS.test(i.inputKind || i.unversionedInputKind || ''));
        const warnings = [];
        let desktopWarning = false;
        for (const i of inputs.slice(0, 200)) {
            let tracks;
            try { tracks = (await call('GetInputAudioTracks', { inputName: i.inputName })).inputAudioTracks || {}; } catch { continue; }
            if (!tracks[String(vodTrack)]) continue;
            const kind = String(i.inputKind || '');
            if (/^wasapi_output_capture/.test(kind)) { desktopWarning = true; continue; }
            if (MUSICY.test(i.inputName)) warnings.push({ name: i.inputName, kind });
        }
        // Global Desktop Audio devices are inputs too on OBS 28+; also catch them by name
        return { warnings, desktopWarning };
    }

    async function run(why) {
        if (!obs.connected) { set({ vodSafe: false, reason: REASONS.obs_off, sourceReady: false }); return st; }
        st.changes = [];
        const { live } = await isLive();
        let mode = await param('Output', 'Mode');
        let vodOn = (await param('AdvOut', 'VodTrackEnabled')).toLowerCase() === 'true';
        const liveTrack = Number(await param('AdvOut', 'TrackIndex')) || 1;
        let vodTrack = Number(await param('AdvOut', 'VodTrackIndex')) || null;
        if (mode !== 'Advanced') {
            set({ vodSafe: false, reason: REASONS.simple_mode, mode, vodTrack: null, liveTrack: null, live, sourceReady: false });
            return st;
        }
        const collides = vodTrack === liveTrack;
        if (!vodOn || !vodTrack || collides) {
            if (live) {
                set({ vodSafe: false, reason: REASONS.live_unprotected, mode, vodTrack: vodOn ? vodTrack : null, liveTrack, live, sourceReady: false });
                log('warn', 'stream or recording running without VOD protection: music paused', { why });
                return st;
            }
            const backup = await backupProfile().catch(() => null);
            if (!backup) { set({ vodSafe: false, reason: REASONS.no_backup, mode, liveTrack, live }); return st; }
            const pick = [2, 3, 4, 5, 6, 1].find((t) => t !== liveTrack);
            if (!vodTrack || collides) {
                await call('SetProfileParameter', { parameterCategory: 'AdvOut', parameterName: 'VodTrackIndex', parameterValue: String(pick) });
                vodTrack = pick;
            }
            if (!vodOn) await call('SetProfileParameter', { parameterCategory: 'AdvOut', parameterName: 'VodTrackEnabled', parameterValue: 'true' });
            vodOn = true;
            st.changes.push(`Turned on the Twitch VOD track (track ${vodTrack}) in the OBS profile; backup ${backup}`);
            log('info', 'VOD track turned on', { vodTrack, liveTrack });
        }
        let source;
        try { source = await ensureSource(); } catch (e) {
            log('warn', 'music source setup failed', { error: e.message });
            set({ vodSafe: false, reason: REASONS.source_failed, mode, vodTrack, liveTrack, live, sourceReady: false });
            return st;
        }
        const tracksOk = await setMusicTracks(source.name, vodTrack).catch(() => false);
        const others = await scanOthers(source.name, vodTrack).catch(() => ({ warnings: [], desktopWarning: false }));
        set({
            vodSafe: tracksOk, reason: tracksOk ? null : REASONS.tracks_failed, mode, vodTrack, liveTrack, live,
            sourceReady: true, sourceName: source.name, warnings: others.warnings, desktopWarning: others.desktopWarning,
            recordWithoutMusic: !!getSettings().recordWithoutMusic,
        });
        if (st.changes.length) log('info', 'VOD-safe changes', { changes: st.changes, why });
        return st;
    }

    async function ensure(why = 'check') {
        if (running) { again = true; return running; }
        running = (async () => {
            try {
                let r;
                do { again = false; r = await run(why); } while (again);
                return r;
            } catch (e) {
                log('warn', 'VOD-safe check failed', { error: e.message, why });
                set({ vodSafe: false, reason: REASONS.source_failed });
                return st;
            } finally { running = null; }
        })();
        return running;
    }

    const RECHECK = new Set(['CurrentSceneCollectionChanged', 'CurrentProfileChanged', 'InputCreated', 'InputRemoved', 'InputNameChanged', 'SceneListChanged', 'SceneCreated', 'InputAudioTracksChanged', 'InputSettingsChanged']);
    let timer = null;
    function soon(why, ms = 500) {
        clearTimeout(timer);
        timer = setTimeout(() => ensure(why).catch(() => {}), ms);
        timer.unref?.();
    }

    return {
        ensure,
        async prepare() {
            const s = await ensure('song');
            if (!s.vodSafe) throw fail('vod_unsafe', s.reason || REASONS.live_unprotected);
            return { vodSafe: true, vodTrack: s.vodTrack, source: s.sourceName };
        },
        status: () => ({ ...st, warnings: [...st.warnings] }),
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        onObsEvent(type, data = {}) {
            if (type === 'StreamStateChanged' && /STARTING|STARTED/.test(String(data.outputState))) { soon('stream start', 0); return; }
            if (type === 'RecordStateChanged' && /STARTING|STARTED|STOPPED/.test(String(data.outputState))) { soon('recording', 0); return; }
            if (type === 'StreamStateChanged' && /STOPPED/.test(String(data.outputState))) { soon('stream stop', 0); return; }
            if (RECHECK.has(type)) soon(type);
        },
        async keepOutOfVod(inputName) {
            const s = await ensure('keep out');
            if (!s.vodTrack) throw fail('no_vod_track', 'There is no VOD track to keep it out of yet.');
            const tracks = (await call('GetInputAudioTracks', { inputName })).inputAudioTracks || {};
            await call('SetInputAudioTracks', { inputName, inputAudioTracks: { ...tracks, [String(s.vodTrack)]: false } });
            log('info', 'source kept out of the VOD at the person\'s request', { input: inputName });
            return ensure('keep out done');
        },
        async setRecordWithoutMusic(on) {
            const s = await ensure('record setting');
            const { recording } = await isLive();
            if (recording) throw fail('recording', 'Stop recording first.');
            if (!s.vodTrack) throw fail('no_vod_track', 'Turn on VOD protection first.');
            const backup = await backupProfile().catch(() => null);
            if (!backup) throw fail('no_backup', REASONS.no_backup);
            const settings = getSettings();
            if (on) {
                const prev = await param('AdvOut', 'RecTracks');
                saveSettings({ recordWithoutMusic: true, prevRecTracks: prev || '1' });
                await call('SetProfileParameter', { parameterCategory: 'AdvOut', parameterName: 'RecTracks', parameterValue: String(1 << (s.vodTrack - 1)) });
            } else {
                await call('SetProfileParameter', { parameterCategory: 'AdvOut', parameterName: 'RecTracks', parameterValue: String(settings.prevRecTracks || '1') });
                saveSettings({ recordWithoutMusic: false, prevRecTracks: null });
            }
            return ensure('record setting done');
        },
    };
}

module.exports = { createVodSafe, MUSIC_NAME, MUSICY, REASONS };
