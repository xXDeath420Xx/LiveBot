/*
 * Local speech-to-text for voice transcription (core/voice-transcription-manager.js).
 *
 * whisper.cpp built at ~/whisper.cpp. Two persistent servers so the model is loaded once rather
 * than per utterance (loading is most of a short clip's latency):
 *   whisper-fast      base.en   ~0.15x realtime on 4 threads — live captions
 *   whisper-accurate  small.en  ~0.5x realtime              — guilds that choose accuracy
 * Both bind to 127.0.0.1 only. Start with: pm2 start ecosystem.whisper.config.cjs && pm2 save
 */
const WHISPER = '/home/death/whisper.cpp';

const server = (name, model, port, threads) => ({
    name,
    script: `${WHISPER}/build/bin/whisper-server`,
    interpreter: 'none',
    args: ['-m', `${WHISPER}/models/ggml-${model}.bin`, '--host', '127.0.0.1', '--port', String(port),
        '-t', String(threads), '-l', 'en', '-nt'],
    cwd: WHISPER,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: '1500M',
});

module.exports = {
    apps: [
        server('whisper-fast', 'base.en', 8178, 4),
        server('whisper-accurate', 'small.en', 8179, 4),
    ],
};
