'use strict';
/*
 * Hidden audio player. Each play command gets its own HTMLAudioElement, routed to the chosen output device with
 * setSinkId. The main process (src/main/sound.js) decides what plays when; this only plays and reports back.
 */
(function () {
    const bridge = window.audioBridge;
    const playing = new Map();

    function cleanup(id) {
        const a = playing.get(id);
        if (!a) return;
        playing.delete(id);
        try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) { /* ignore */ }
    }

    bridge.onPlay(async (cmd) => {
        const a = new Audio();
        a.preload = 'auto';
        playing.set(cmd.id, a);
        a.addEventListener('ended', () => { cleanup(cmd.id); bridge.ended(cmd.id); });
        a.addEventListener('error', () => {
            const code = a.error ? a.error.code : 0;
            cleanup(cmd.id);
            bridge.error(cmd.id, code === 4 ? 'unsupported_or_missing_file' : code === 2 ? 'network_error' : code === 3 ? 'decode_error' : 'playback_error');
        });
        try {
            a.volume = Math.max(0, Math.min(1, Number(cmd.volume) || 0));
            if (cmd.sinkId && cmd.sinkId !== 'default' && typeof a.setSinkId === 'function') {
                try { await a.setSinkId(cmd.sinkId); } catch (e) { /* device unplugged: fall back to the default output */ }
            }
            a.src = cmd.src;
            await a.play();
            bridge.started(cmd.id);
        } catch (e) {
            if (!playing.has(cmd.id)) return;   // the error event already reported it
            cleanup(cmd.id);
            bridge.error(cmd.id, (e && e.name) || 'playback_error');
        }
    });

    bridge.onStop((id) => {
        if (id == null) { for (const k of [...playing.keys()]) { cleanup(k); bridge.ended(k); } return; }
        if (playing.has(id)) { cleanup(id); bridge.ended(id); }
    });

    bridge.onDevices(async (req) => {
        try {
            const kind = req.kind === 'audioinput' ? 'audioinput' : 'audiooutput';
            const list = await navigator.mediaDevices.enumerateDevices();
            bridge.reply(req.id, list.filter((d) => d.kind === kind).map((d, i) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'Windows default' : `${kind === 'audioinput' ? 'Input' : 'Output'} ${i + 1}`) })));
        } catch (e) {
            bridge.reply(req.id, []);
        }
    });

    // ── voice commands: microphone capture at 16 kHz mono, handed to the main process ──
    let mic = null;
    async function stopMic() {
        const m = mic;
        mic = null;
        if (!m) return;
        try { m.node.port.onmessage = null; m.node.disconnect(); } catch (e) { /* ignore */ }
        try { m.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
        try { await m.ctx.close(); } catch (e) { /* ignore */ }
    }
    bridge.onVoiceStart(async (req) => {
        await stopMic();
        try {
            const constraints = { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true };
            if (req && req.deviceId && req.deviceId !== 'default') constraints.deviceId = { exact: req.deviceId };
            const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
            const ctx = new AudioContext({ sampleRate: 16000 });
            await ctx.audioWorklet.addModule('voice-worklet.js');
            const src = ctx.createMediaStreamSource(stream);
            const node = new AudioWorkletNode(ctx, 'certifried-pcm16');
            node.port.onmessage = (ev) => {
                bridge.voicePcm(ev.data.pcm);
                bridge.voiceLevel(ev.data.level);
            };
            src.connect(node);
            // keep the worklet pulled by the graph, without playing the microphone back
            const mute = ctx.createGain();
            mute.gain.value = 0;
            node.connect(mute).connect(ctx.destination);
            mic = { stream, ctx, node };
            bridge.voiceState('on');
        } catch (e) {
            await stopMic();
            bridge.voiceState('error', (e && e.name) || 'mic_error');
        }
    });
    bridge.onVoiceStop(async () => { await stopMic(); bridge.voiceState('off'); });
})();
