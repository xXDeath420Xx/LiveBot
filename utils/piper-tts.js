import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const piperTTS = require('./piper-tts.cjs');

export const {
    synthesize,
    getAvailableVoices,
    getVoicesByLanguage,
    getVoiceInfo,
    getInstalledVoices,
    cleanupTempFiles,
    getAllVoicesPaths,
    AVAILABLE_VOICES
} = piperTTS;
