import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const piperTTS = require('./piper-tts.cjs');

export const {
    synthesize,
    synthesizeDetailed,
    getVoiceOptions,
    isKokoroInstalled,
    logFallback,
    getPiperInstalledVoices,
    getAvailableVoices,
    getVoicesByLanguage,
    getVoiceInfo,
    getModelPath,
    getInstalledVoices,
    cleanupTempFiles,
    getAllVoicesPaths,
    AVAILABLE_VOICES
} = piperTTS;
