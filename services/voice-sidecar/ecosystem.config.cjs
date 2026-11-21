/*
 * The own-voice sidecar (services/voice-sidecar/server.py): speaker embeddings (ReDimNet + ECAPA) and the AudioSeal
 * watermark, on a Unix socket in ~/certifried-data/voice/run (mode 0600). CPU only, 2 torch threads, nice 10.
 * The Python venv is ~/voice-sidecar/venv (torch CPU, torchaudio, speechbrain, audioseal 0.2.1, soundfile); models are
 * cached in ~/voice-sidecar/models.
 * Start with: pm2 start services/voice-sidecar/ecosystem.config.cjs && pm2 save
 * If it is down, own-voice synthesis fails closed (nothing unmarked is ever played) and recordings cannot be checked.
 */
const HOME = '/home/death';

module.exports = {
    apps: [{
        name: 'voice-sidecar',
        script: `${HOME}/CertiFriedUtility/services/voice-sidecar/server.py`,
        interpreter: `${HOME}/voice-sidecar/venv/bin/python`,
        interpreter_args: '-u',
        cwd: `${HOME}/voice-sidecar`,
        env: {
            VOICE_SIDECAR_THREADS: '2',
            VOICE_SIDECAR_SOCKET: `${HOME}/certifried-data/voice/run/sidecar.sock`,
            VOICE_SIDECAR_CACHE: `${HOME}/voice-sidecar/models`,
            OMP_NUM_THREADS: '2',
            HF_HUB_DISABLE_TELEMETRY: '1',
            PYTHONWARNINGS: 'ignore',
        },
        autorestart: true,
        max_restarts: 10,
        restart_delay: 10000,
        max_memory_restart: '2500M',
    }],
};
