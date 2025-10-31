/**
 * Piper TTS (Text-to-Speech) Utility
 * Uses locally installed Piper models for high-quality voice synthesis
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const PIPER_BINARY = '/root/.local/bin/piper';
const MODELS_DIR = path.join(__dirname, '..', 'piper_models');
const TEMP_AUDIO_DIR = path.join(__dirname, '..', 'temp_audio');

// Ensure temp audio directory exists
if (!fs.existsSync(TEMP_AUDIO_DIR)) {
    fs.mkdirSync(TEMP_AUDIO_DIR, { recursive: true });
}

/**
 * Available voices with metadata
 */
const AVAILABLE_VOICES = {
    // US English Voices
    'amy': { locale: 'en_US', quality: 'medium', gender: 'female', description: 'Clear American female voice' },
    'joe': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'Natural American male voice' },
    'ryan': { locale: 'en_US', quality: 'high', gender: 'male', description: 'High-quality American male voice' },
    'ljspeech': { locale: 'en_US', quality: 'high', gender: 'female', description: 'Professional female voice' },
    'danny': { locale: 'en_US', quality: 'low', gender: 'male', description: 'Fast American male voice' },
    'kathleen': { locale: 'en_US', quality: 'low', gender: 'female', description: 'Fast American female voice' },
    'john': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'Friendly American male voice' },
    'bryce': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'Deep American male voice' },
    'kristin': { locale: 'en_US', quality: 'medium', gender: 'female', description: 'Warm American female voice' },
    'norman': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'Mature American male voice' },
    'kusal': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'Young American male voice' },
    'hfc_female': { locale: 'en_US', quality: 'medium', gender: 'female', description: 'Clear female voice' },
    'hfc_male': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'Clear male voice' },
    'lessac': { locale: 'en_US', quality: 'medium', gender: 'female', description: 'Expressive female voice' },
    'libritts': { locale: 'en_US', quality: 'high', gender: 'mixed', description: 'High-quality multi-speaker' },
    'arctic': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'Accented male voice' },
    'l2arctic': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'L2 accented male voice' },

    // GB English Voices
    'alan': { locale: 'en_GB', quality: 'medium', gender: 'male', description: 'British male voice' },
    'alba': { locale: 'en_GB', quality: 'medium', gender: 'female', description: 'British female voice' },
    'aru': { locale: 'en_GB', quality: 'medium', gender: 'female', description: 'British young female voice' },
    'jenny': { locale: 'en_GB', quality: 'medium', gender: 'female', description: 'British Jenny voice' },
    'cori': { locale: 'en_GB', quality: 'medium', gender: 'female', description: 'British Cori voice' },
    'northern_english_male': { locale: 'en_GB', quality: 'medium', gender: 'male', description: 'Northern English accent' },
    'southern_english_female': { locale: 'en_GB', quality: 'medium', gender: 'female', description: 'Southern English accent' },
    'vctk': { locale: 'en_GB', quality: 'medium', gender: 'mixed', description: 'British multi-speaker' },
    'semaine': { locale: 'en_GB', quality: 'medium', gender: 'mixed', description: 'British emotional voice' }
};

/**
 * Get list of all available voices
 * @returns {Array} Array of voice objects with metadata
 */
function getAvailableVoices() {
    return Object.entries(AVAILABLE_VOICES).map(([name, data]) => ({
        name,
        ...data,
        flag: data.locale === 'en_US' ? '🇺🇸' : '🇬🇧'
    }));
}

/**
 * Get voice metadata
 * @param {string} voiceName - Name of the voice
 * @returns {Object|null} Voice metadata or null if not found
 */
function getVoiceInfo(voiceName) {
    if (!AVAILABLE_VOICES[voiceName]) {
        return null;
    }
    return {
        name: voiceName,
        ...AVAILABLE_VOICES[voiceName],
        flag: AVAILABLE_VOICES[voiceName].locale === 'en_US' ? '🇺🇸' : '🇬🇧'
    };
}

/**
 * Get model path for a voice
 * @param {string} voiceName - Name of the voice
 * @returns {string|null} Full path to the model file
 */
function getModelPath(voiceName) {
    const voiceInfo = AVAILABLE_VOICES[voiceName];
    if (!voiceInfo) {
        return null;
    }

    const locale = voiceInfo.locale;
    const quality = voiceInfo.quality;
    const modelFile = `${locale}-${voiceName}-${quality}.onnx`;
    const modelPath = path.join(MODELS_DIR, locale, voiceName, quality, modelFile);

    if (!fs.existsSync(modelPath)) {
        logger.warn(`[Piper TTS] Model file not found: ${modelPath}`);
        return null;
    }

    return modelPath;
}

/**
 * Synthesize text to speech using Piper
 * @param {string} text - Text to synthesize
 * @param {string} voiceName - Voice to use (default: 'ryan')
 * @param {Object} options - Synthesis options
 * @returns {Promise<string>} Path to generated audio file
 */
async function synthesize(text, voiceName = 'ryan', options = {}) {
    return new Promise((resolve, reject) => {
        try {
            // Validate voice
            const modelPath = getModelPath(voiceName);
            if (!modelPath) {
                return reject(new Error(`Voice '${voiceName}' not found or model missing`));
            }

            // Sanitize text (remove problematic characters)
            const sanitizedText = text
                .replace(/[<>]/g, '') // Remove angle brackets
                .replace(/\n+/g, ' ') // Replace newlines with spaces
                .trim();

            if (sanitizedText.length === 0) {
                return reject(new Error('Text is empty after sanitization'));
            }

            if (sanitizedText.length > 1000) {
                return reject(new Error('Text is too long (max 1000 characters)'));
            }

            // Generate unique output filename
            const timestamp = Date.now();
            const random = Math.random().toString(36).substring(7);
            const outputFile = path.join(TEMP_AUDIO_DIR, `tts_${timestamp}_${random}.wav`);

            // Build piper command
            const args = [
                '-m', modelPath,
                '-f', outputFile
            ];

            // Add optional parameters
            if (options.lengthScale !== undefined) {
                args.push('--length-scale', options.lengthScale.toString());
            }
            if (options.noiseScale !== undefined) {
                args.push('--noise-scale', options.noiseScale.toString());
            }
            if (options.volume !== undefined) {
                args.push('--volume', options.volume.toString());
            }

            logger.info(`[Piper TTS] Synthesizing: "${sanitizedText.substring(0, 50)}..." with voice '${voiceName}'`);

            // Spawn piper process
            const piper = spawn(PIPER_BINARY, args);

            // Write text to stdin
            piper.stdin.write(sanitizedText);
            piper.stdin.end();

            let stderr = '';

            piper.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            piper.on('close', (code) => {
                if (code !== 0) {
                    logger.error(`[Piper TTS] Process exited with code ${code}: ${stderr}`);
                    return reject(new Error(`Piper failed with code ${code}`));
                }

                if (!fs.existsSync(outputFile)) {
                    logger.error(`[Piper TTS] Output file not created: ${outputFile}`);
                    return reject(new Error('Audio file was not created'));
                }

                logger.info(`[Piper TTS] Successfully generated audio: ${outputFile}`);
                resolve(outputFile);
            });

            piper.on('error', (err) => {
                logger.error(`[Piper TTS] Process error:`, err);
                reject(err);
            });

        } catch (error) {
            logger.error(`[Piper TTS] Synthesis error:`, error);
            reject(error);
        }
    });
}

/**
 * Clean up old temporary audio files
 * @param {number} maxAge - Maximum age in milliseconds (default: 5 minutes)
 */
function cleanupTempFiles(maxAge = 5 * 60 * 1000) {
    try {
        const now = Date.now();
        const files = fs.readdirSync(TEMP_AUDIO_DIR);

        let cleaned = 0;
        for (const file of files) {
            if (!file.startsWith('tts_')) continue;

            const filePath = path.join(TEMP_AUDIO_DIR, file);
            const stats = fs.statSync(filePath);
            const age = now - stats.mtimeMs;

            if (age > maxAge) {
                fs.unlinkSync(filePath);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            logger.info(`[Piper TTS] Cleaned up ${cleaned} old audio files`);
        }
    } catch (error) {
        logger.error(`[Piper TTS] Cleanup error:`, error);
    }
}

// Auto-cleanup every 5 minutes
setInterval(() => cleanupTempFiles(), 5 * 60 * 1000);

module.exports = {
    synthesize,
    getAvailableVoices,
    getVoiceInfo,
    cleanupTempFiles,
    AVAILABLE_VOICES
};
