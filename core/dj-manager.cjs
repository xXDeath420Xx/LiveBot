"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
var fs = require("fs");
var path = require("path");
var logger_1 = require("../utils/logger.cjs");
var child_process_1 = require("child_process");
var geminiApi = require("../utils/gemini-api.cjs");
var musicMetrics = require("./music-metrics.cjs");
var db_1 = require("../utils/db.cjs");
var musicErrorReasons = require("../utils/music-error-reasons.cjs");
var djLibrary = require("./dj-blocklist.cjs");
// Voice ids / sample rates for the two TTS engines (Piper, Kokoro): utils/kokoro-logic.cjs.
var ttsLogic = require("../utils/kokoro-logic.cjs");
// Piper model path -> its output sample rate (from the model's .onnx.json; raw PCM carries none).
var piperRateCache = new Map();
function piperModelRate(modelPath) {
    if (!piperRateCache.has(modelPath)) {
        var config = null;
        try { config = JSON.parse(fs.readFileSync(modelPath + '.json', 'utf8')); } catch (e) { /* no config: Piper's usual rate */ }
        piperRateCache.set(modelPath, ttsLogic.piperSampleRate(config));
    }
    return piperRateCache.get(modelPath);
}
// --- AI DJ blocklist / favourites cache (per guild; /music settings djblock|djfavorite invalidate it) ---
var DJ_LIBRARY_TTL_MS = 60 * 1000;
// --- Piper TTS Configuration ---
var PIPER_PATH = process.env.PIPER_PATH || '/home/death/.local/bin/piper';
var PIPER_MODEL_DIR = process.env.PIPER_MODEL_DIR || '/home/death/CertiFriedUtility/piper_models';
var PIPER_DEFAULT_MODEL = process.env.PIPER_DEFAULT_MODEL || 'en_US/amy/medium/en_US-amy-medium.onnx';
// --- FFmpeg Configuration ---
var FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
var DJManager = /** @class */ (function () {
    function DJManager(client) {
        var _this = this;
        this.client = client;
        this.player = client.player;
        this.player.events.on("playerFinish", function (queue, finishedTrack) { return _this.onPlayerFinish(queue, finishedTrack); });
        this.player.events.on("emptyQueue", function (queue) { return _this.onQueueEnd(queue); });
        this.player.events.on("playerError", function (queue, error) { return _this.onPlayerError(queue, error); });
        this._blocklistCache = new Map(); // guildId -> { at, entries }
        this._favoritesCache = new Map(); // guildId -> { at, rows }
    }
    /**
     * The guild's DJ blocklist (ai_dj_blacklist) as matchable entries, cached for a minute.
     * A read failure is logged and treated as "nothing blocked" for this batch (the DJ keeps playing).
     */
    DJManager.prototype.getBlocklist = async function (guildId) {
        var hit = this._blocklistCache.get(guildId);
        if (hit && Date.now() - hit.at < DJ_LIBRARY_TTL_MS) return hit.entries;
        try {
            var result = await db_1.default.execute("SELECT id, entry_type, song_identifier, title, artist, reason FROM ai_dj_blacklist WHERE guild_id = ?", [guildId]);
            var entries = (result[0] || []).map(djLibrary.entryFromRow).filter(Boolean);
            this._blocklistCache.set(guildId, { at: Date.now(), entries: entries });
            return entries;
        } catch (error) {
            logger_1.default.error("[DJ] Could not load the blocklist for guild ".concat(guildId, ": ").concat(error.message));
            return hit ? hit.entries : [];
        }
    };
    /** The guild's favourite songs (ai_dj_favorites), cached for a minute. */
    DJManager.prototype.getFavorites = async function (guildId) {
        var hit = this._favoritesCache.get(guildId);
        if (hit && Date.now() - hit.at < DJ_LIBRARY_TTL_MS) return hit.rows;
        try {
            var result = await db_1.default.execute("SELECT id, song_title, artist, url, priority FROM ai_dj_favorites WHERE guild_id = ? ORDER BY priority DESC, id ASC LIMIT 200", [guildId]);
            var rows = result[0] || [];
            this._favoritesCache.set(guildId, { at: Date.now(), rows: rows });
            return rows;
        } catch (error) {
            logger_1.default.error("[DJ] Could not load favourites for guild ".concat(guildId, ": ").concat(error.message));
            return hit ? hit.rows : [];
        }
    };
    /** Called after /music settings djblock|djfavorite changes so the next batch sees them immediately. */
    DJManager.prototype.invalidateDJLibrary = function (guildId) {
        this._blocklistCache.delete(guildId);
        this._favoritesCache.delete(guildId);
    };
    /** Drop blocked items (Gemini {title, artist} or Tracks), logging what was dropped. */
    DJManager.prototype.filterBlocked = function (items, entries, guildId, what) {
        if (!entries || !entries.length || !items || !items.length) return items || [];
        var res = djLibrary.filterBlocked(items, entries);
        if (res.blocked.length) {
            logger_1.default.info("[DJ] Blocklist removed ".concat(res.blocked.length, " ").concat(what, " in guild ").concat(guildId, ": ")
                .concat(res.blocked.map(function (b) { return "\"".concat(b.item.title, "\" (").concat(b.entry.type, " ").concat(b.entry.type === 'artist' ? b.entry.artist : b.entry.title, ")"); }).join(", ")));
        }
        return res.kept;
    };
    DJManager.prototype.getDJVoiceModel = async function (guildId) {
        var _this = this;
        try {
            var result = await db_1.default.execute("SELECT dj_voice FROM music_config WHERE guild_id = ?", [guildId]);
            var config = result[0][0];
            var voiceModel = PIPER_DEFAULT_MODEL;

            if (config && config.dj_voice) {
                if (ttsLogic.isKokoroVoiceId(config.dj_voice)) {
                    // Kept even while the Kokoro model is missing: generatePiperAudio falls back (and logs it).
                    var kokoro = ttsLogic.parseVoiceId(config.dj_voice);
                    voiceModel = kokoro.known ? "kokoro:" + kokoro.voice : PIPER_DEFAULT_MODEL;
                } else if (config.dj_voice.includes('/') || config.dj_voice.includes('.onnx')) {
                    voiceModel = config.dj_voice;
                } else {
                    var voiceMap = this.getAllVoices();
                    voiceModel = voiceMap[config.dj_voice] || PIPER_DEFAULT_MODEL;
                }
            }

            // Cache the voice model for later use (avoids db calls in skip banter)
            this.setCachedVoiceModel(guildId, voiceModel);
            return voiceModel;
        } catch (error) {
            logger_1.default.warn("[DJ] Failed to fetch DJ voice for guild ".concat(guildId, ", using default: ").concat(error.message));
            return PIPER_DEFAULT_MODEL;
        }
    };
    DJManager.prototype.getAllVoices = function () {
        // Use the centralized voice list from piper-tts module
        const piperTTS = require('../utils/piper-tts.cjs');
        return piperTTS.getAllVoicesPaths();
    };
    DJManager.prototype.getVoicesList = function () {
        var voices = this.getAllVoices();
        const piperTTS = require('../utils/piper-tts.cjs');
        const availableVoices = piperTTS.AVAILABLE_VOICES;

        return Object.keys(voices).map(function (key) {
            const voiceData = availableVoices[key];
            return {
                name: key,
                path: voices[key],
                locale: voiceData ? voiceData.locale : 'Unknown',
                quality: voiceData ? voiceData.quality : 'medium',
                description: voiceData ? voiceData.description : '',
                flag: voiceData ? voiceData.flag : ''
            };
        });
    };
    /**
     * DJ speech -> 48 kHz stereo WAV at finalOutputPath. modelName is a Piper model path relative to
     * piper_models, or "kokoro:<voice>" for a Kokoro voice (synthesised to a 24 kHz WAV, then
     * converted); a Kokoro failure falls back to the default Piper model and is logged.
     * Piper's raw output has no header, so ffmpeg is told the model's own sample rate (22.05 kHz for
     * medium/high voices, 16 kHz for low ones) — it used to be told 22050 for every voice, which
     * played the low-quality voices ~38% too fast and high.
     */
    DJManager.prototype.generatePiperAudio = async function (text, modelName, finalOutputPath) {
        if (String(modelName).startsWith('kokoro:')) {
            var voiceId = ttsLogic.kokoroId(String(modelName).slice('kokoro:'.length));
            var wavPath = finalOutputPath + '.kokoro.wav';
            try {
                var kokoroTts = await import('../utils/kokoro-tts.js');
                await kokoroTts.kokoroToFile(text, voiceId, wavPath);
                return await this.convertToDiscordWav(['-i', wavPath], null, finalOutputPath);
            } catch (error) {
                logger_1.default.warn("[DJ] Kokoro voice ".concat(voiceId, " unavailable (").concat(error.message, "); using the default Piper voice"));
                return this.generatePiperAudio(text, PIPER_DEFAULT_MODEL, finalOutputPath);
            } finally {
                fs.promises.unlink(wavPath).catch(function () { });
            }
        }
        var modelPath = path.join(PIPER_MODEL_DIR, modelName);
        if (!fs.existsSync(modelPath)) {
            throw new Error("Piper model not found at: ".concat(modelPath));
        }
        logger_1.default.info("[DJ/Pipeline] Starting Piper -> WAV audio generation for: ".concat(finalOutputPath));
        var piper = (0, child_process_1.spawn)(PIPER_PATH, ['--model', modelPath, '--output-raw']);
        piper.stdin.write(text);
        piper.stdin.end();
        return this.convertToDiscordWav(ttsLogic.rawPcmInputArgs(piperModelRate(modelPath)), piper, finalOutputPath);
    };
    /** ffmpeg: the given input (raw PCM piped from `source`, or a file) -> 48 kHz stereo 16-bit WAV. */
    DJManager.prototype.convertToDiscordWav = function (inputArgs, source, finalOutputPath) {
        return new Promise(function (resolve, reject) {
            var piper = source;
            var ffmpeg = (0, child_process_1.spawn)(FFMPEG_PATH, inputArgs.concat([
                '-af', 'aresample=resampler=soxr,pan=stereo|FL=FC|FR=FC',
                '-ar', '48000',
                '-ac', '2',
                '-acodec', 'pcm_s16le',
                '-y',
                finalOutputPath
            ]));
            var piperStderr = '';
            if (piper) {
                piper.stdout.pipe(ffmpeg.stdin);
                piper.stderr.on('data', function (data) { piperStderr += data; });
                piper.on('error', function (err) { logger_1.default.error("[DJ/Piper] Failed to start Piper process: ".concat(err.message)); reject(err); });
            }
            var ffmpegStderr = '';
            ffmpeg.stderr.on('data', function (data) { ffmpegStderr += data; });
            ffmpeg.on('error', function (err) { logger_1.default.error("[DJ/FFmpeg] Failed to start FFmpeg process: ".concat(err.message)); reject(err); });
            ffmpeg.on('close', function (code) {
                if (code === 0) {
                    logger_1.default.info("[DJ/FFmpeg] WAV generation finished successfully. Audio saved to ".concat(finalOutputPath));
                    resolve(finalOutputPath);
                }
                else {
                    logger_1.default.error("[DJ/FFmpeg] FFmpeg process exited with code ".concat(code, ". Stderr: ").concat(ffmpegStderr));
                    if (piper) logger_1.default.error("[DJ/Piper] Piper Stderr (for context): ".concat(piperStderr));
                    reject(new Error("FFmpeg failed with code ".concat(code)));
                }
            });
        });
    };
    DJManager.prototype.playPlaylistIntro = function (queue_1, playlistTracks_1) {
        return __awaiter(this, arguments, void 0, function (queue, playlistTracks, addToEnd) {
            var commentaryText, script, piperTempFilePath, audioFilePath, djVoiceModel, piperError_1, commentarySearchResult, commentaryTrack, tracksToAdd, error_2;
            var _a, _b, _c, _d, _e, _f;
            if (addToEnd === void 0) { addToEnd = false; }
            return __generator(this, function (_g) {
                switch (_g.label) {
                    case 0:
                        logger_1.default.info("[DJ] playPlaylistIntro triggered for guild ".concat(queue.guild.id, "."));
                        if (!playlistTracks || playlistTracks.length === 0) {
                            logger_1.default.warn("[DJ] No playlist tracks provided for intro commentary for guild ".concat(queue.guild.id, "."));
                            return [2 /*return*/];
                        }
                        if (!queue.metadata.djMode) return [3 /*break*/, 11];
                        _g.label = 1;
                    case 1:
                        _g.trys.push([1, 9, , 10]);
                        // Validate playlistTracks before proceeding
                        if (!Array.isArray(playlistTracks) || playlistTracks.length === 0) {
                            logger_1.default.warn("[DJ] Invalid playlist tracks provided for guild ".concat(queue.guild.id, ". Skipping commentary."));
                            return [2 /*return*/];
                        }
                        return [4 /*yield*/, geminiApi.generatePlaylistCommentary(playlistTracks)];
                    case 2:
                        commentaryText = _g.sent();
                        script = commentaryText || "Here's your upcoming playlist!";
                        logger_1.default.info("[DJ] Generated intro script for guild ".concat(queue.guild.id, ": ").concat(script));
                        piperTempFilePath = path.join(__dirname, "../temp_audio/".concat(queue.guild.id, "_intro_commentary_piper.wav"));
                        audioFilePath = void 0;
                        _g.label = 3;
                    case 3:
                        _g.trys.push([3, 6, , 7]);
                        return [4 /*yield*/, this.getDJVoiceModel(queue.guild.id)];
                    case 4:
                        djVoiceModel = _g.sent();
                        return [4 /*yield*/, this.generatePiperAudio(script, djVoiceModel, piperTempFilePath)];
                    case 5:
                        audioFilePath = _g.sent();
                        return [3 /*break*/, 7];
                    case 6:
                        piperError_1 = _g.sent();
                        logger_1.default.error("[DJ] Audio generation pipeline failed for intro commentary: ".concat(piperError_1.message, ". Adding tracks without intro."));
                        queue.addTrack(playlistTracks); // Add tracks directly if commentary fails
                        (_b = (_a = this.client.musicPanelManager) === null || _a === void 0 ? void 0 : _a.get(queue.guild.id)) === null || _b === void 0 ? void 0 : _b.updatePanel();
                        return [2 /*return*/];
                    case 7: return [4 /*yield*/, this.player.search(audioFilePath, {
                            requestedBy: this.client.user,
                            metadata: { isDJCommentary: true }
                        })];
                    case 8:
                        commentarySearchResult = _g.sent();
                        if (!commentarySearchResult || !commentarySearchResult.hasTracks()) {
                            logger_1.default.error("[DJ] Failed to resolve commentary track from local file: ".concat(audioFilePath, ". Adding tracks without intro."));
                            queue.addTrack(playlistTracks);
                            (_d = (_c = this.client.musicPanelManager) === null || _c === void 0 ? void 0 : _c.get(queue.guild.id)) === null || _d === void 0 ? void 0 : _d.updatePanel();
                            return [2 /*return*/];
                        }
                        commentaryTrack = commentarySearchResult.tracks[0];
                        commentaryTrack.title = 'DJ Playlist Intro';
                        commentaryTrack.description = 'DJ Intro for upcoming playlist';
                        commentaryTrack.author = 'DJ Bot';
                        commentaryTrack.thumbnail = 'https://i.imgur.com/GBp9Ahl.png';
                        tracksToAdd = __spreadArray([commentaryTrack], playlistTracks, true);
                        queue.addTrack(tracksToAdd);
                        logger_1.default.info("[DJ] Added commentary and ".concat(playlistTracks.length, " playlist tracks."));
                        return [3 /*break*/, 10];
                    case 9:
                        error_2 = _g.sent();
                        logger_1.default.error("[DJ] Failed to generate or inject intro commentary for guild ".concat(queue.guild.id, ":"), { error: error_2.message, stack: error_2.stack });
                        // Ensure tracks are added even if commentary completely fails
                        try {
                            queue.addTrack(playlistTracks);
                        }
                        catch (addError) {
                            logger_1.default.error("[DJ] Critical error: Failed to add tracks after commentary failure:", { error: addError.message, stack: addError.stack });
                        }
                        return [3 /*break*/, 10];
                    case 10: return [3 /*break*/, 12];
                    case 11:
                        // If not in DJ mode, just add the tracks.
                        queue.addTrack(playlistTracks);
                        _g.label = 12;
                    case 12:
                        (_f = (_e = this.client.musicPanelManager) === null || _e === void 0 ? void 0 : _e.get(queue.guild.id)) === null || _f === void 0 ? void 0 : _f.updatePanel();
                        return [2 /*return*/];
                }
            });
        });
    };
    // Cache for DJ voice models to avoid database calls
    DJManager.prototype._voiceModelCache = new Map();

    DJManager.prototype.getCachedVoiceModel = function (guildId) {
        // Return cached model or default (must be full path)
        return this._voiceModelCache.get(guildId) || PIPER_DEFAULT_MODEL;
    };

    DJManager.prototype.setCachedVoiceModel = function (guildId, model) {
        this._voiceModelCache.set(guildId, model);
    };

    // Ensure voice model is loaded into cache (call this when DJ session starts)
    DJManager.prototype.ensureVoiceModelCached = async function (guildId) {
        if (!this._voiceModelCache.has(guildId)) {
            await this.getDJVoiceModel(guildId);
        }
        return this.getCachedVoiceModel(guildId);
    };

    // Handle DJ mode skip - generates banter FIRST, then skips
    DJManager.prototype.handleDJSkip = async function (queue, skippedTrack, skipper) {
        if (!queue.metadata.djMode) {
            // Not in DJ mode, just do normal skip
            queue.node.skip();
            return;
        }

        try {
            logger_1.default.info("[DJ] handleDJSkip called for guild ".concat(queue.guild.id, ", track: ").concat(skippedTrack?.title));

            // Get voice model - fetch from DB if not cached
            var djVoiceModel = this._voiceModelCache.get(queue.guild.id);
            if (!djVoiceModel) {
                logger_1.default.info("[DJ] Voice model not cached, fetching from DB...");
                djVoiceModel = await this.getDJVoiceModel(queue.guild.id);
            }
            logger_1.default.info("[DJ] Using voice model: ".concat(djVoiceModel));

            // Generate commentary
            var commentaryText = await geminiApi.generatePassiveAggressiveCommentary({
                total_plays: 0, total_skips: 0, user_play_count: 0,
                user_skip_count: 0, user_skip_button_presses: 0
            });
            logger_1.default.info("[DJ] Generated banter text: ".concat(commentaryText));

            // Generate audio file
            var filePath = path.join(__dirname, "../temp_audio/".concat(queue.guild.id, "_skip_banter.wav"));
            var audioFilePath = await this.generatePiperAudio(commentaryText, djVoiceModel, filePath);

            if (!audioFilePath || !fs.existsSync(audioFilePath)) {
                logger_1.default.warn("[DJ] Skip banter audio file not created, doing normal skip");
                queue.node.skip();
                return;
            }

            // Search for the audio file as a playable track
            var searchResult = await this.player.search(audioFilePath, {
                requestedBy: this.client.user,
                metadata: { isDJCommentary: true, isSkipBanter: true }
            });

            if (searchResult.hasTracks()) {
                var banterTrack = searchResult.tracks[0];
                banterTrack.title = 'DJ Skip Comment';
                banterTrack.author = 'AI DJ';
                banterTrack.thumbnail = 'https://i.imgur.com/GBp9Ahl.png';

                // Insert banter at position 0 (next in queue)
                queue.insertTrack(banterTrack, 0);
                logger_1.default.info("[DJ] Inserted banter at position 0");

                // Now skip - this will skip current song and start playing the banter (which is now at position 0)
                queue.node.skip();
                logger_1.default.info("[DJ] Skipped to banter track");
            } else {
                logger_1.default.warn("[DJ] Could not create banter track, doing normal skip");
                queue.node.skip();
            }
        } catch (error) {
            logger_1.default.error("[DJ] handleDJSkip failed:", { error: error.message, stack: error.stack });
            // On any error, just perform normal skip
            try { queue.node.skip(); } catch (e) {}
        } finally {
            var _a, _b;
            (_b = (_a = this.client.musicPanelManager) === null || _a === void 0 ? void 0 : _a.get(queue.guild.id)) === null || _b === void 0 ? void 0 : _b.updatePanel();
        }
    };

    // Legacy function - now just calls handleDJSkip
    DJManager.prototype.playSkipBanter = async function (queue, skippedTrack, skipper) {
        // This is now a no-op since handleDJSkip does everything
        // Kept for backwards compatibility but skip should use handleDJSkip directly
        logger_1.default.warn("[DJ] playSkipBanter called but skip should use handleDJSkip instead");
    };
    DJManager.prototype.onPlayerFinish = function (queue, finishedTrack) {
        return __awaiter(this, void 0, void 0, function () {
            var localPath_1, requester, djInitiatorId, finalUserId;
            var _this = this;
            var _a, _b, _c, _d, _e;
            return __generator(this, function (_f) {
                switch (_f.label) {
                    case 0:
                        // Wrap entire handler in try-catch to prevent crashes
                        try {
                            logger_1.default.info("[DJ] onPlayerFinish event triggered for guild ".concat(queue.guild.id, ". Track: ").concat(finishedTrack.title, ", Queue Size: ").concat(queue.tracks.size));
                        } catch (logError) {
                            // Even logging failed, just continue
                        }

                        // Safely update panel with error handling
                        try {
                            (_b = (_a = this.client.musicPanelManager) === null || _a === void 0 ? void 0 : _a.get(queue.guild.id)) === null || _b === void 0 ? void 0 : _b.updatePanel();
                        } catch (panelError) {
                            logger_1.default.warn("[DJ] Panel update failed in onPlayerFinish: ".concat(panelError.message));
                        }

                        if (!(((_c = finishedTrack.metadata) === null || _c === void 0 ? void 0 : _c.isDJCommentary) || ((_d = finishedTrack.metadata) === null || _d === void 0 ? void 0 : _d.isSkipBanter))) return [3 /*break*/, 1];
                        localPath_1 = finishedTrack.url;
                        if (localPath_1 && fs.existsSync(localPath_1)) {
                            fs.unlink(localPath_1, function (err) {
                                if (err)
                                    logger_1.default.error("[Cleanup] Failed to delete commentary temp file: ".concat(localPath_1), err.message);
                                else
                                    logger_1.default.info("[Cleanup] Deleted commentary temp file: ".concat(localPath_1));
                            });
                        }
                        return [3 /*break*/, 3];
                    case 1:
                        if (!finishedTrack.requestedBy) return [3 /*break*/, 3];
                        requester = finishedTrack.requestedBy;
                        djInitiatorId = (_e = queue.metadata) === null || _e === void 0 ? void 0 : _e.djInitiatorId;
                        finalUserId = (requester.id === this.client.user.id && djInitiatorId) ? djInitiatorId : requester.id;
                        return [4 /*yield*/, musicMetrics.incrementPlayCount(finishedTrack.url, queue.guild.id, finalUserId)];
                    case 2:
                        _f.sent();
                        _f.label = 3;
                    case 3:
                        // Pre-fetch logic: Only trigger if NOT already generating
                        // The queueEnd event handler will also trigger onQueueEnd, so we skip pre-fetch here
                        // to avoid race conditions and duplicate playlist generation
                        if (queue.tracks.size > 0 && queue.tracks.size <= 3 && queue.metadata.djMode && !queue.metadata.isGenerating) {
                            logger_1.default.info("[DJ] Queue nearing end (".concat(queue.tracks.size, " tracks left). Will let queueEnd handle playlist generation."));
                            // Don't call onQueueEnd here - let the queueEnd event handler do it
                            // This prevents race conditions and duplicate generation
                        }
                        // Don't manually trigger onQueueEnd when queue is empty either
                        // The discord-player library will fire queueEnd automatically
                        return [2 /*return*/];
                }
            });
        });
    };
    DJManager.prototype.onQueueEnd = function (queue) {
        return __awaiter(this, void 0, void 0, function () {
            var panel, shouldAddToEnd, _a, inputSong, inputArtist, inputGenre, playedTracks, djInitiatorId, prompt_1, djUser_1, channel, ytExtractor, videoInfo, error_4, geminiRecommendedTracks, BATCH_SIZE, resolvedTracks, i, batch, batchPromises, batchResults, channel, channel;
            var _this = this;
            var _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        console.log("[DJ DEBUG] emptyQueue event triggered for guild " + queue.guild.id);
                        logger_1.default.info("[DJ] emptyQueue event triggered for guild ".concat(queue.guild.id, "."));
                        panel = (_b = this.client.musicPanelManager) === null || _b === void 0 ? void 0 : _b.get(queue.guild.id);
                        if (queue.metadata.isGenerating) {
                            logger_1.default.warn("[DJ] Playlist generation is already in progress for guild ".concat(queue.guild.id, ". Skipping."));
                            return [2 /*return*/];
                        }
                        if (!queue.metadata.djMode) return [3 /*break*/, 29];
                        shouldAddToEnd = queue.tracks.size > 0;
                        _c.label = 1;
                    case 1:
                        _c.trys.push([1, , 26, 29]);
                        queue.metadata.isGenerating = true;
                        if (!panel) return [3 /*break*/, 3];
                        return [4 /*yield*/, panel.updatePanel()];
                    case 2:
                        _c.sent();
                        _c.label = 3;
                    case 3:
                        console.log("[DJ DEBUG] DJ mode is active. inputSong:", queue.metadata.inputSong, "inputArtist:", queue.metadata.inputArtist);
                        logger_1.default.info("[DJ] DJ mode is active. Generating new playlist. addToEnd: ".concat(shouldAddToEnd));
                        _a = queue.metadata, inputSong = _a.inputSong, inputArtist = _a.inputArtist, inputGenre = _a.inputGenre, playedTracks = _a.playedTracks, djInitiatorId = _a.djInitiatorId, prompt_1 = _a.prompt;
                        return [4 /*yield*/, this.client.users.fetch(djInitiatorId).catch(function () { return null; })];
                    case 4:
                        djUser_1 = _c.sent();
                        if (!!djUser_1) return [3 /*break*/, 6];
                        logger_1.default.error("[DJ] Could not fetch the DJ initiator user (ID: ".concat(djInitiatorId, "). Ending session."));
                        return [4 /*yield*/, this.client.channels.cache.get(queue.metadata.channelId)];
                    case 5:
                        channel = _c.sent();
                        if (channel && channel.isTextBased())
                            channel.send("🎧 | Could not identify the original DJ. Ending the session.");
                        if (queue.connection)
                            queue.delete();
                        return [2 /*return*/];
                    case 6:
                        if (!(prompt_1 && (prompt_1.includes('youtube.com') || prompt_1.includes('youtu.be')))) return [3 /*break*/, 11];
                        logger_1.default.info("[DJ] Detected YouTube URL in prompt: ".concat(prompt_1, ". Extracting video info..."));
                        _c.label = 7;
                    case 7:
                        _c.trys.push([7, 10, , 11]);
                        ytExtractor = this.player.extractors.get('com.certifried.ytdlp-universal') ||
                            this.player.extractors.get('com.certifried.ytdlp') ||
                            this.player.extractors.get('com.certifried.playwright-youtube');
                        if (!(ytExtractor && ytExtractor.getVideoInfo)) return [3 /*break*/, 9];
                        return [4 /*yield*/, ytExtractor.getVideoInfo(prompt_1)];
                    case 8:
                        videoInfo = _c.sent();
                        if (videoInfo && videoInfo.title && videoInfo.author) {
                            logger_1.default.info("[DJ] Extracted video info: \"".concat(videoInfo.title, "\" by \"").concat(videoInfo.author, "\""));
                            // Use the extracted video info as seed song/artist instead of URL
                            inputSong = videoInfo.title;
                            inputArtist = videoInfo.author;
                            prompt_1 = null; // Clear the prompt so it uses song/artist instead
                        }
                        _c.label = 9;
                    case 9: return [3 /*break*/, 11];
                    case 10:
                        error_4 = _c.sent();
                        logger_1.default.error("[DJ] Failed to extract YouTube video info: ".concat(error_4.message, ". Using prompt as-is."));
                        return [3 /*break*/, 11];
                    case 11:
                        console.log("[DJ DEBUG] Calling getRecommendationsWithFallback with song:", inputSong, "artist:", inputArtist);
                        return [4 /*yield*/, this.getRecommendationsWithFallback(inputSong, inputArtist, inputGenre, playedTracks, prompt_1, queue)];
                    case 12:
                        geminiRecommendedTracks = _c.sent();
                        console.log("[DJ DEBUG] Gemini returned:", geminiRecommendedTracks ? geminiRecommendedTracks.length : 0, "tracks");
                        if (!(geminiRecommendedTracks && geminiRecommendedTracks.length > 0)) return [3 /*break*/, 23];
                        BATCH_SIZE = 3;
                        resolvedTracks = [];
                        i = 0;
                        _c.label = 13;
                    case 13:
                        if (!(i < geminiRecommendedTracks.length)) return [3 /*break*/, 16];
                        batch = geminiRecommendedTracks.slice(i, i + BATCH_SIZE);
                        batchPromises = batch.map(function (recTrack) { return __awaiter(_this, void 0, void 0, function () {
                            var query, searchResult, track, ytdlpResult;
                            var _this2 = this;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0:
                                        query = "".concat(recTrack.title, " ").concat(recTrack.artist);
                                        console.log("[DJ] Searching for: " + query);
                                        // Try player search first
                                        return [4 /*yield*/, this.player.search(query, { requestedBy: djUser_1, metadata: { artist: recTrack.artist } }).catch(function(e) { return { hasTracks: function() { return false; }, tracks: [] }; })];
                                    case 1:
                                        searchResult = _a.sent();
                                        if (searchResult.hasTracks() && searchResult.tracks.length > 0) {
                                            track = searchResult.tracks[0];
                                            console.log("[DJ] Found via player: " + track.title);
                                            if (!track.url.includes('youtube.com/shorts'))
                                                return [2 /*return*/, track];
                                        }
                                        // Fallback: Direct yt-dlp search
                                        console.log("[DJ] Player search failed, trying direct yt-dlp for: " + query);
                                        return [4 /*yield*/, new Promise(function(resolve) {
                                            var spawn = require('child_process').spawn;
                                            // Flat search: hits only YouTube's search page, which works even while the
                                            // player endpoint bot-walls us. NEVER pass the master cookies.txt — yt-dlp
                                            // rewrites it and strips the auth cookies on a bot challenge.
                                            var args = ['--no-update', '--flat-playlist', '-j', '--no-warnings', 'ytsearch1:' + query];
                                            var proc = spawn('yt-dlp', args);
                                            var output = '';
                                            proc.stdout.on('data', function(d) { output += d.toString(); });
                                            var stderr = '';
                                            proc.stderr.on('data', function(d) { stderr += d.toString(); });
                                            proc.on('close', function(code) {
                                                if (code === 0 && output.trim()) {
                                                    try {
                                                        var data = JSON.parse(output.trim());
                                                        console.log("[DJ] yt-dlp found: " + data.title);
                                                        var u = data.webpage_url || (data.url && data.url.indexOf('http') === 0 ? data.url : (data.id ? 'https://www.youtube.com/watch?v=' + data.id : null));
                                                        resolve({ title: data.title, url: u, author: data.uploader || data.channel, duration: data.duration });
                                                    } catch(e) { resolve(null); }
                                                } else {
                                                    if (stderr.trim()) console.log("[DJ] yt-dlp failed (code " + code + "): " + stderr.trim().slice(0, 300));
                                                    resolve(null);
                                                }
                                            });
                                            proc.on('error', function() { resolve(null); });
                                            setTimeout(function() { try { proc.kill(); } catch(e) {} resolve(null); }, 15000);
                                        })];
                                    case 2:
                                        ytdlpResult = _a.sent();
                                        if (ytdlpResult && ytdlpResult.url && !ytdlpResult.url.includes('youtube.com/shorts')) {
                                            // Search for the URL to get a proper Track object
                                            return [4 /*yield*/, _this2.player.search(ytdlpResult.url, { requestedBy: djUser_1 }).catch(function() { return null; })];
                                        }
                                        return [2 /*return*/, null];
                                    case 3:
                                        var urlSearchResult = _a.sent();
                                        if (urlSearchResult && urlSearchResult.hasTracks && urlSearchResult.hasTracks()) {
                                            console.log("[DJ] Converted URL to Track: " + urlSearchResult.tracks[0].title);
                                            return [2 /*return*/, urlSearchResult.tracks[0]];
                                        }
                                        return [2 /*return*/, null];
                                }
                            });
                        }); });
                        return [4 /*yield*/, Promise.all(batchPromises)];
                    case 14:
                        batchResults = _c.sent();
                        resolvedTracks.push.apply(resolvedTracks, batchResults.filter(function (track) { return track !== null; }));
                        logger_1.default.info("[DJ] Processed batch ".concat(Math.floor(i / BATCH_SIZE) + 1, "/").concat(Math.ceil(geminiRecommendedTracks.length / BATCH_SIZE), " (").concat(resolvedTracks.length, " tracks found so far)"));
                        _c.label = 15;
                    case 15:
                        i += BATCH_SIZE;
                        return [3 /*break*/, 13];
                    case 16:
                        // The blocklist is a guarantee, not a request: a search can resolve a recommendation
                        // to a different upload (a cover, a feature) — check what actually got resolved.
                        // (getRecommendationsWithFallback just refreshed the cached list for this guild.)
                        resolvedTracks = this.filterBlocked(resolvedTracks, (this._blocklistCache.get(queue.guild.id) || {}).entries, queue.guild.id, "resolved tracks");
                        if (!(resolvedTracks.length > 0)) return [3 /*break*/, 20];
                        // Store tracks with timestamps for 1-hour cooldown
                        var now = Date.now();
                        playedTracks.push.apply(playedTracks, resolvedTracks.map(function (t) { return { title: t.title, playedAt: now }; }));
                        return [4 /*yield*/, this.playPlaylistIntro(queue, resolvedTracks, shouldAddToEnd)];
                    case 17:
                        _c.sent();
                        if (!(!queue.isPlaying() && !shouldAddToEnd)) return [3 /*break*/, 19];
                        return [4 /*yield*/, queue.node.play()];
                    case 18:
                        _c.sent();
                        _c.label = 19;
                    case 19: return [3 /*break*/, 22];
                    case 20:
                        logger_1.default.warn("[DJ] No playable tracks found for new recommendations.");
                        return [4 /*yield*/, this.client.channels.cache.get(queue.metadata.channelId)];
                    case 21:
                        channel = _c.sent();
                        if (channel && channel.isTextBased())
                            channel.send("🎧 | The AI DJ has run out of new recommendations. Ending the session.");
                        if (queue.connection)
                            queue.delete();
                        _c.label = 22;
                    case 22: return [3 /*break*/, 25];
                    case 23:
                        logger_1.default.info("[DJ] Gemini AI did not return new recommendations. Ending DJ session.");
                        return [4 /*yield*/, this.client.channels.cache.get(queue.metadata.channelId)];
                    case 24:
                        channel = _c.sent();
                        if (channel && channel.isTextBased())
                            channel.send("🎧 | The AI DJ has run out of new recommendations. Ending the session.");
                        if (queue.connection)
                            queue.delete();
                        _c.label = 25;
                    case 25: return [3 /*break*/, 29];
                    case 26:
                        queue.metadata.isGenerating = false;
                        if (!panel) return [3 /*break*/, 28];
                        return [4 /*yield*/, panel.updatePanel()];
                    case 27:
                        _c.sent();
                        _c.label = 28;
                    case 28: return [7 /*endfinally*/];
                    case 29: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Get recommendations with fallback for niche/comedy/novelty content
     * If primary recommendations fail, tries genre-based fallback.
     *
     * With `queue`, the guild's AI DJ library applies:
     *   - favourites-seeded sessions (no seed given) re-pick a few favourites for every batch;
     *   - the blocklist is named to Gemini as exclusions, and blocked recommendations are dropped
     *     before anything is searched (onQueueEnd checks the resolved tracks again).
     */
    DJManager.prototype.getRecommendationsWithFallback = async function (inputSong, inputArtist, inputGenre, playedTracks, prompt, queue) {
        var guildId = queue && queue.guild ? queue.guild.id : null;
        var _this = this;
        var blocked = guildId ? await this.getBlocklist(guildId) : [];
        if (guildId && queue.metadata && queue.metadata.favoritesSeed) {
            var favorites = await this.getFavorites(guildId);
            var picks = djLibrary.pickWeighted(favorites, 3);
            if (picks.length) {
                prompt = djLibrary.joinPrompt(queue.metadata.basePrompt, djLibrary.favoritesSeedText(picks));
                queue.metadata.prompt = prompt;
                logger_1.default.info("[DJ] Favourite seeds for guild ".concat(guildId, ": ").concat(picks.map(function (f) { return f.song_title; }).join(", ")));
            }
        }
        var exclusion = djLibrary.exclusionText(blocked);
        var seeds = { inputSong: inputSong, inputArtist: inputArtist, inputGenre: inputGenre };
        var keep = function (recs) { return _this.filterBlocked(recs || [], blocked, guildId, "recommendations"); };

        // First attempt: normal recommendations
        console.log("[DJ DEBUG] getRecommendationsWithFallback: calling geminiApi.generatePlaylistRecommendations");
        console.log("[DJ DEBUG] params - song:", inputSong, "artist:", inputArtist, "genre:", inputGenre, "blocked:", blocked.length);
        var recommendations = keep(await geminiApi.generatePlaylistRecommendations(inputSong, inputArtist, inputGenre, playedTracks, djLibrary.withExclusions(prompt, seeds, exclusion)));

        // If we got results, return them
        if (recommendations.length > 0) {
            return recommendations;
        }

        // Fallback: If Gemini returns empty and we have song/artist info, try comedy/novelty genre
        if (!(inputSong || inputArtist)) {
            return [];
        }
        logger_1.default.info("[DJ] Initial recommendations empty. Trying fallback with comedy/novelty genre...");

        var fallbackPrompt = "The song \"".concat(inputSong || 'Unknown', "\" by \"").concat(inputArtist || 'Unknown', "\" appears to be a ");
        fallbackPrompt += "comedy, parody, novelty, or adult humor song. Please recommend 10-15 similar songs from ANY artist. ";
        fallbackPrompt += "Consider artists like: Weird Al Yankovic, Tim Minchin, Flight of the Conchords, Tenacious D, ";
        fallbackPrompt += "The Lonely Island, Stephen Lynch, Rodney Carrington, Bob Rivers, Adam Sandler, Denis Leary, ";
        fallbackPrompt += "Kevin Bloody Wilson, Monty Python, Tom Lehrer, Bo Burnham, or similar comedic musicians. ";
        fallbackPrompt += "Also consider Australian comedy musicians, British comedy acts, and holiday parody songs if relevant. ";
        fallbackPrompt += "Focus on songs that are actually available on YouTube.";

        recommendations = keep(await geminiApi.generatePlaylistRecommendations(null, null, 'comedy/novelty', playedTracks, djLibrary.joinPrompt(fallbackPrompt, exclusion)));
        if (recommendations.length > 0) {
            logger_1.default.info("[DJ] Fallback succeeded with ".concat(recommendations.length, " comedy/novelty recommendations"));
            return recommendations;
        }

        // Second fallback: try general "fun/party" songs
        logger_1.default.info("[DJ] Comedy fallback empty. Trying general fun/party music fallback...");
        fallbackPrompt = "Generate 10-15 fun, upbeat party songs that would appeal to someone who enjoys comedy and novelty music. ";
        fallbackPrompt += "Include a mix of classic party songs, funny songs, and feel-good tracks. Focus on songs available on YouTube.";

        recommendations = keep(await geminiApi.generatePlaylistRecommendations(null, null, 'party/fun', playedTracks, djLibrary.joinPrompt(fallbackPrompt, exclusion)));
        if (recommendations.length > 0) {
            logger_1.default.info("[DJ] Party music fallback succeeded with ".concat(recommendations.length, " recommendations"));
        }
        return recommendations;
    };

    DJManager.prototype.onPlayerError = function (queue, error) {
        return __awaiter(this, void 0, void 0, function () {
            var channel, reason;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        // Only handle errors for DJ-mode sessions (matches onPlayerFinish/onQueueEnd pattern)
                        if (!queue.metadata || !queue.metadata.djMode) {
                            return [2 /*return*/];
                        }
                        logger_1.default.error("[Player Error] Guild: ".concat(queue.guild.id, ", Error: ").concat(error.message));
                        return [4 /*yield*/, this.client.channels.cache.get(queue.metadata.channelId)];
                    case 1:
                        channel = _a.sent();
                        if (channel && channel.isTextBased()) {
                            reason = musicErrorReasons.getPlayerErrorReason(error.message);
                            channel.send("\u23ED\uFE0F | Skipped unavailable track: " + reason);
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    return DJManager;
}());
exports.default = DJManager;
