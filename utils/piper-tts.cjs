/**
 * Piper TTS (Text-to-Speech) Utility
 * Uses locally installed Piper models for high-quality voice synthesis
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger.cjs');

const PIPER_BINARY = process.env.PIPER_PATH || '/home/death/.local/bin/piper';
const MODELS_DIR = path.join(__dirname, '..', 'piper_models');
const TEMP_AUDIO_DIR = path.join(__dirname, '..', 'temp_audio');

// Ensure temp audio directory exists
if (!fs.existsSync(TEMP_AUDIO_DIR)) {
    fs.mkdirSync(TEMP_AUDIO_DIR, { recursive: true });
}

/**
 * Available voices with metadata
 * Includes all major PiperTTS language packs
 */
const AVAILABLE_VOICES = {
    // === ENGLISH (US) ===
    'amy': { locale: 'en_US', quality: 'medium', gender: 'female', description: 'Clear American female voice', flag: '🇺🇸' },
    'joe': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'Natural American male voice', flag: '🇺🇸' },
    'ryan': { locale: 'en_US', quality: 'high', gender: 'male', description: 'High-quality American male voice', flag: '🇺🇸' },
    'ljspeech': { locale: 'en_US', quality: 'high', gender: 'female', description: 'Professional female voice', flag: '🇺🇸' },
    'danny': { locale: 'en_US', quality: 'low', gender: 'male', description: 'Fast American male voice', flag: '🇺🇸' },
    'kathleen': { locale: 'en_US', quality: 'low', gender: 'female', description: 'Fast American female voice', flag: '🇺🇸' },
    'john': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'Friendly American male voice', flag: '🇺🇸' },
    'bryce': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'Deep American male voice', flag: '🇺🇸' },
    'kristin': { locale: 'en_US', quality: 'medium', gender: 'female', description: 'Warm American female voice', flag: '🇺🇸' },
    'norman': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'Mature American male voice', flag: '🇺🇸' },
    'kusal': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'Young American male voice', flag: '🇺🇸' },
    'hfc_female': { locale: 'en_US', quality: 'medium', gender: 'female', description: 'Clear female voice', flag: '🇺🇸' },
    'hfc_male': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'Clear male voice', flag: '🇺🇸' },
    'lessac': { locale: 'en_US', quality: 'medium', gender: 'female', description: 'Expressive female voice', flag: '🇺🇸' },
    'libritts': { locale: 'en_US', quality: 'high', gender: 'mixed', description: 'High-quality multi-speaker', flag: '🇺🇸' },
    'arctic': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'Accented male voice', flag: '🇺🇸' },
    'l2arctic': { locale: 'en_US', quality: 'medium', gender: 'male', description: 'L2 accented male voice', flag: '🇺🇸' },

    // === ENGLISH (GB) ===
    'alan': { locale: 'en_GB', quality: 'medium', gender: 'male', description: 'British male voice', flag: '🇬🇧' },
    'alba': { locale: 'en_GB', quality: 'medium', gender: 'female', description: 'British female voice', flag: '🇬🇧' },
    'aru': { locale: 'en_GB', quality: 'medium', gender: 'female', description: 'British young female voice', flag: '🇬🇧' },
    'jenny': { locale: 'en_GB', quality: 'medium', gender: 'female', description: 'British Jenny voice', flag: '🇬🇧' },
    'cori': { locale: 'en_GB', quality: 'medium', gender: 'female', description: 'British Cori voice', flag: '🇬🇧' },
    'northern_english_male': { locale: 'en_GB', quality: 'medium', gender: 'male', description: 'Northern English accent', flag: '🇬🇧' },
    'southern_english_female': { locale: 'en_GB', quality: 'medium', gender: 'female', description: 'Southern English accent', flag: '🇬🇧' },
    'vctk': { locale: 'en_GB', quality: 'medium', gender: 'mixed', description: 'British multi-speaker', flag: '🇬🇧' },
    'semaine': { locale: 'en_GB', quality: 'medium', gender: 'mixed', description: 'British emotional voice', flag: '🇬🇧' },

    // === ARABIC ===
    'arabic_male': { locale: 'ar_JO', quality: 'medium', gender: 'male', description: 'Arabic male voice', flag: '🇯🇴' },

    // === CATALAN ===
    'catalan_female': { locale: 'ca_ES', quality: 'medium', gender: 'female', description: 'Catalan female voice', flag: '🇪🇸' },

    // === CZECH ===
    'czech_female': { locale: 'cs_CZ', quality: 'medium', gender: 'female', description: 'Czech female voice', flag: '🇨🇿' },

    // === DANISH ===
    'danish_female': { locale: 'da_DK', quality: 'medium', gender: 'female', description: 'Danish female voice', flag: '🇩🇰' },

    // === GERMAN ===
    'thorsten': { locale: 'de_DE', quality: 'medium', gender: 'male', description: 'German male voice', flag: '🇩🇪' },
    'eva_k': { locale: 'de_DE', quality: 'medium', gender: 'female', description: 'German female voice', flag: '🇩🇪' },

    // === GREEK ===
    'greek_male': { locale: 'el_GR', quality: 'medium', gender: 'male', description: 'Greek male voice', flag: '🇬🇷' },

    // === SPANISH (SPAIN) ===
    'carlfm': { locale: 'es_ES', quality: 'medium', gender: 'male', description: 'Spanish male voice', flag: '🇪🇸' },
    'mls_9972': { locale: 'es_ES', quality: 'medium', gender: 'female', description: 'Spanish female voice', flag: '🇪🇸' },

    // === SPANISH (MEXICO) ===
    'mexican_male': { locale: 'es_MX', quality: 'medium', gender: 'male', description: 'Mexican Spanish male voice', flag: '🇲🇽' },

    // === FINNISH ===
    'finnish_male': { locale: 'fi_FI', quality: 'medium', gender: 'male', description: 'Finnish male voice', flag: '🇫🇮' },

    // === FRENCH ===
    'siwis': { locale: 'fr_FR', quality: 'medium', gender: 'female', description: 'French female voice', flag: '🇫🇷' },
    'tom': { locale: 'fr_FR', quality: 'medium', gender: 'male', description: 'French male voice', flag: '🇫🇷' },

    // === HUNGARIAN ===
    'hungarian_female': { locale: 'hu_HU', quality: 'medium', gender: 'female', description: 'Hungarian female voice', flag: '🇭🇺' },

    // === ICELANDIC ===
    'icelandic_male': { locale: 'is_IS', quality: 'medium', gender: 'male', description: 'Icelandic male voice', flag: '🇮🇸' },

    // === ITALIAN ===
    'riccardo': { locale: 'it_IT', quality: 'medium', gender: 'male', description: 'Italian male voice', flag: '🇮🇹' },

    // === JAPANESE ===
    'japanese_female': { locale: 'ja_JP', quality: 'medium', gender: 'female', description: 'Japanese female voice', flag: '🇯🇵' },

    // === GEORGIAN ===
    'georgian_female': { locale: 'ka_GE', quality: 'medium', gender: 'female', description: 'Georgian female voice', flag: '🇬🇪' },

    // === KAZAKH ===
    'kazakh_female': { locale: 'kk_KZ', quality: 'medium', gender: 'female', description: 'Kazakh female voice', flag: '🇰🇿' },

    // === KOREAN ===
    'korean_female': { locale: 'ko_KR', quality: 'medium', gender: 'female', description: 'Korean female voice', flag: '🇰🇷' },

    // === LUXEMBOURGISH ===
    'luxembourgish_male': { locale: 'lb_LU', quality: 'medium', gender: 'male', description: 'Luxembourgish male voice', flag: '🇱🇺' },

    // === NEPALI ===
    'nepali_male': { locale: 'ne_NP', quality: 'medium', gender: 'male', description: 'Nepali male voice', flag: '🇳🇵' },

    // === DUTCH ===
    'dutch_male': { locale: 'nl_NL', quality: 'medium', gender: 'male', description: 'Dutch male voice', flag: '🇳🇱' },
    'dutch_female': { locale: 'nl_NL', quality: 'medium', gender: 'female', description: 'Dutch female voice', flag: '🇳🇱' },

    // === NORWEGIAN ===
    'norwegian_female': { locale: 'no_NO', quality: 'medium', gender: 'female', description: 'Norwegian female voice', flag: '🇳🇴' },

    // === POLISH ===
    'polish_male': { locale: 'pl_PL', quality: 'medium', gender: 'male', description: 'Polish male voice', flag: '🇵🇱' },
    'polish_female': { locale: 'pl_PL', quality: 'medium', gender: 'female', description: 'Polish female voice', flag: '🇵🇱' },

    // === PORTUGUESE (BRAZIL) ===
    'faber': { locale: 'pt_BR', quality: 'medium', gender: 'male', description: 'Brazilian Portuguese male voice', flag: '🇧🇷' },

    // === PORTUGUESE (PORTUGAL) ===
    'tugao': { locale: 'pt_PT', quality: 'medium', gender: 'male', description: 'Portuguese male voice', flag: '🇵🇹' },

    // === ROMANIAN ===
    'romanian_female': { locale: 'ro_RO', quality: 'medium', gender: 'female', description: 'Romanian female voice', flag: '🇷🇴' },

    // === RUSSIAN ===
    'russian_male': { locale: 'ru_RU', quality: 'medium', gender: 'male', description: 'Russian male voice', flag: '🇷🇺' },
    'russian_female': { locale: 'ru_RU', quality: 'medium', gender: 'female', description: 'Russian female voice', flag: '🇷🇺' },

    // === SLOVAK ===
    'slovak_female': { locale: 'sk_SK', quality: 'medium', gender: 'female', description: 'Slovak female voice', flag: '🇸🇰' },

    // === SLOVENIAN ===
    'slovenian_male': { locale: 'sl_SI', quality: 'medium', gender: 'male', description: 'Slovenian male voice', flag: '🇸🇮' },

    // === SERBIAN ===
    'serbian_male': { locale: 'sr_RS', quality: 'medium', gender: 'male', description: 'Serbian male voice', flag: '🇷🇸' },

    // === SWEDISH ===
    'swedish_male': { locale: 'sv_SE', quality: 'medium', gender: 'male', description: 'Swedish male voice', flag: '🇸🇪' },

    // === SWAHILI ===
    'swahili_male': { locale: 'sw_CD', quality: 'medium', gender: 'male', description: 'Swahili male voice', flag: '🇨🇩' },

    // === TURKISH ===
    'turkish_male': { locale: 'tr_TR', quality: 'medium', gender: 'male', description: 'Turkish male voice', flag: '🇹🇷' },

    // === UKRAINIAN ===
    'ukrainian_female': { locale: 'uk_UA', quality: 'medium', gender: 'female', description: 'Ukrainian female voice', flag: '🇺🇦' },

    // === VIETNAMESE ===
    'vietnamese_male': { locale: 'vi_VN', quality: 'medium', gender: 'male', description: 'Vietnamese male voice', flag: '🇻🇳' },
    'vietnamese_female': { locale: 'vi_VN', quality: 'medium', gender: 'female', description: 'Vietnamese female voice', flag: '🇻🇳' },

    // === CHINESE ===
    'chinese_female': { locale: 'zh_CN', quality: 'medium', gender: 'female', description: 'Chinese female voice', flag: '🇨🇳' }
};

// Cache for installed voices (refreshed on startup and periodically)
let installedVoicesCache = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

/**
 * Get installed voices with caching
 * @returns {Object} Object with installed voices
 */
function getCachedInstalledVoices() {
    const now = Date.now();
    if (!installedVoicesCache || (now - cacheTimestamp) > CACHE_DURATION) {
        installedVoicesCache = getInstalledVoices();
        cacheTimestamp = now;
    }
    return installedVoicesCache;
}

/**
 * Get list of all available voices (uses dynamic discovery)
 * @returns {Array} Array of voice objects with metadata
 */
function getAvailableVoices() {
    const installed = getCachedInstalledVoices();
    return Object.entries(installed).map(([name, data]) => ({
        name,
        ...data
    }));
}

/**
 * Get voices grouped by language (uses dynamic discovery)
 * @returns {Object} Voices grouped by locale
 */
function getVoicesByLanguage() {
    const installed = getCachedInstalledVoices();
    const grouped = {};
    Object.entries(installed).forEach(([name, data]) => {
        if (!grouped[data.locale]) {
            grouped[data.locale] = [];
        }
        grouped[data.locale].push({ name, ...data });
    });
    return grouped;
}

/**
 * Get voice metadata (uses dynamic discovery with fallback to static list)
 * @param {string} voiceName - Name of the voice
 * @returns {Object|null} Voice metadata or null if not found
 */
function getVoiceInfo(voiceName) {
    // First check dynamic installed voices
    const installed = getCachedInstalledVoices();
    if (installed[voiceName]) {
        return {
            name: voiceName,
            ...installed[voiceName]
        };
    }

    // Fallback to static list for backwards compatibility
    if (AVAILABLE_VOICES[voiceName]) {
        return {
            name: voiceName,
            ...AVAILABLE_VOICES[voiceName]
        };
    }

    return null;
}

/**
 * Get list of voices that have models installed
 * Dynamically scans the piper_models directory to find all .onnx files
 * @returns {Object} Object with only installed voices
 */
function getInstalledVoices() {
    const installed = {};

    // Helper function to detect gender from voice name
    const detectGender = (voiceName, speakerCount) => {
        const nameLower = voiceName.toLowerCase();

        // Multi-speaker voices
        if (speakerCount && speakerCount > 1) {
            return 'multi';
        }

        // Female voice patterns
        if (/female|woman|girl|amy|alba|aru|jenny|cori|kristin|kathleen|lessac|eva|kerstin|ramona|siwis|anna|berta|ugla|salka|paola|natia|raya|lili|lada/.test(nameLower)) {
            return 'female';
        }

        // Male voice patterns
        if (/male|man|boy|joe|ryan|danny|john|bryce|norman|kusal|alan|thorsten|kareem|jirka|tom|imre|bui|steinn|riccardo|mihai|dmitri|ruslan|artur|fahrettin|fettah/.test(nameLower)) {
            return 'male';
        }

        return 'neutral';
    };

    // Helper function to get language flag emoji
    const getFlag = (locale) => {
        const flagMap = {
            'ar_JO': '🇯🇴', 'bg_BG': '🇧🇬', 'ca_ES': '🇪🇸', 'cs_CZ': '🇨🇿', 'cy_GB': '🏴󠁧󠁢󠁷󠁬󠁳󠁿',
            'da_DK': '🇩🇰', 'de_DE': '🇩🇪', 'el_GR': '🇬🇷', 'en_GB': '🇬🇧', 'en_US': '🇺🇸',
            'es_AR': '🇦🇷', 'es_ES': '🇪🇸', 'es_MX': '🇲🇽', 'fa_IR': '🇮🇷', 'fi_FI': '🇫🇮',
            'fr_FR': '🇫🇷', 'hi_IN': '🇮🇳', 'hu_HU': '🇭🇺', 'id_ID': '🇮🇩', 'is_IS': '🇮🇸',
            'it_IT': '🇮🇹', 'ja_JP': '🇯🇵', 'ka_GE': '🇬🇪', 'kk_KZ': '🇰🇿', 'ko_KR': '🇰🇷',
            'lb_LU': '🇱🇺', 'lv_LV': '🇱🇻', 'ml_IN': '🇮🇳', 'ne_NP': '🇳🇵', 'nl_BE': '🇧🇪',
            'nl_NL': '🇳🇱', 'no_NO': '🇳🇴', 'pl_PL': '🇵🇱', 'pt_BR': '🇧🇷', 'pt_PT': '🇵🇹',
            'ro_RO': '🇷🇴', 'ru_RU': '🇷🇺', 'sk_SK': '🇸🇰', 'sl_SI': '🇸🇮', 'sr_RS': '🇷🇸',
            'sv_SE': '🇸🇪', 'sw_CD': '🇨🇩', 'te_IN': '🇮🇳', 'tr_TR': '🇹🇷', 'uk_UA': '🇺🇦',
            'vi_VN': '🇻🇳', 'zh_CN': '🇨🇳'
        };
        return flagMap[locale] || '🌐';
    };

    try {
        // Scan all locale directories
        const localeDirectories = fs.readdirSync(MODELS_DIR, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        for (const locale of localeDirectories) {
            const localePath = path.join(MODELS_DIR, locale);

            // Scan all voice directories within locale
            const voiceDirectories = fs.readdirSync(localePath, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name);

            for (const voiceName of voiceDirectories) {
                const voicePath = path.join(localePath, voiceName);

                // Scan all quality directories within voice
                const qualityDirectories = fs.readdirSync(voicePath, { withFileTypes: true })
                    .filter(dirent => dirent.isDirectory())
                    .map(dirent => dirent.name);

                for (const quality of qualityDirectories) {
                    const qualityPath = path.join(voicePath, quality);
                    const modelFile = `${locale}-${voiceName}-${quality}.onnx`;
                    const modelPath = path.join(qualityPath, modelFile);
                    const configPath = path.join(qualityPath, `${modelFile}.json`);

                    // Check if model file exists
                    if (fs.existsSync(modelPath)) {
                        // Try to read config for additional metadata
                        let speakerCount = null;
                        try {
                            if (fs.existsSync(configPath)) {
                                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                                speakerCount = config.num_speakers || null;
                            }
                        } catch (err) {
                            // Config read failed, continue without it
                        }

                        // Create unique voice ID: voiceName_quality for voices with multiple qualities
                        // or just voiceName if only one quality exists
                        const baseVoiceId = `${voiceName}`;
                        const voiceId = quality === 'medium' ? baseVoiceId : `${baseVoiceId}_${quality}`;

                        // Auto-detect gender
                        const gender = detectGender(voiceName, speakerCount);

                        // Add to installed voices
                        installed[voiceId] = {
                            locale: locale,
                            quality: quality,
                            gender: gender,
                            description: `${locale.replace('_', ' ')} ${voiceName} voice`,
                            flag: getFlag(locale),
                            actualVoiceName: voiceName // Store the real filesystem voice name
                        };
                    }
                }
            }
        }

        logger.info(`[Piper TTS] Discovered ${Object.keys(installed).length} installed voices`);
    } catch (err) {
        logger.error(`[Piper TTS] Error scanning for installed voices: ${err.message}`);
    }

    return installed;
}

/**
 * Get model path for a voice
 * @param {string} voiceName - Name of the voice
 * @returns {string|null} Full path to the model file
 */
function getModelPath(voiceName) {
    // First try to get from installed voices (dynamic discovery)
    const installedVoices = getInstalledVoices();
    const voiceInfo = installedVoices[voiceName];

    if (voiceInfo) {
        const locale = voiceInfo.locale;
        const quality = voiceInfo.quality;
        const actualName = voiceInfo.actualVoiceName || voiceName;
        const modelFile = `${locale}-${actualName}-${quality}.onnx`;
        const modelPath = path.join(MODELS_DIR, locale, actualName, quality, modelFile);

        if (fs.existsSync(modelPath)) {
            return modelPath;
        }
    }

    // Fallback to AVAILABLE_VOICES for backwards compatibility
    const fallbackInfo = AVAILABLE_VOICES[voiceName];
    if (fallbackInfo) {
        const locale = fallbackInfo.locale;
        const quality = fallbackInfo.quality;
        const modelFile = `${locale}-${voiceName}-${quality}.onnx`;
        const modelPath = path.join(MODELS_DIR, locale, voiceName, quality, modelFile);

        if (fs.existsSync(modelPath)) {
            return modelPath;
        }
    }

    logger.warn(`[Piper TTS] Model file not found for voice: ${voiceName}`);
    return null;
}

/**
 * Get relative model paths for all voices (for DJ manager)
 * @returns {Object} Map of voice names to relative model paths
 */
function getAllVoicesPaths() {
    const voicePaths = {};
    const installedVoices = getInstalledVoices();

    Object.entries(installedVoices).forEach(([voiceId, data]) => {
        const locale = data.locale;
        const quality = data.quality;
        const actualName = data.actualVoiceName || voiceId;
        const relativePath = `${locale}/${actualName}/${quality}/${locale}-${actualName}-${quality}.onnx`;
        voicePaths[voiceId] = relativePath;
    });

    return voicePaths;
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
    getVoicesByLanguage,
    getVoiceInfo,
    getInstalledVoices,
    cleanupTempFiles,
    getAllVoicesPaths,
    AVAILABLE_VOICES
};
