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
var generative_ai_1 = require("@google/generative-ai");
var logger_1 = require("./logger.cjs");
var GEMINI_API_KEY = process.env.GOOGLE_API_KEY;
if (!GEMINI_API_KEY) {
    logger_1.default.error("[Gemini API] GOOGLE_API_KEY is not set in environment variables.");
}
else {
    logger_1.default.info("[Gemini API] GOOGLE_API_KEY is loaded.");
}
var genAI = new generative_ai_1.GoogleGenerativeAI(GEMINI_API_KEY || "");
var model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
function withRetry(fn_1) {
    return __awaiter(this, arguments, void 0, function (fn, retries, delay) {
        var lastError, _loop_1, i, state_1;
        if (retries === void 0) { retries = 3; }
        if (delay === void 0) { delay = 1000; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _loop_1 = function (i) {
                        var _b, error_1, errorMessage;
                        return __generator(this, function (_c) {
                            switch (_c.label) {
                                case 0:
                                    _c.trys.push([0, 2, , 4]);
                                    _b = {};
                                    return [4 /*yield*/, fn()];
                                case 1: return [2 /*return*/, (_b.value = _c.sent(), _b)];
                                case 2:
                                    error_1 = _c.sent();
                                    lastError = error_1;
                                    errorMessage = error_1 instanceof Error ? error_1.message : 'Unknown error';
                                    logger_1.default.warn("[Retry] Attempt ".concat(i + 1, " failed. Retrying in ").concat(delay * (i + 1), "ms..."), { error: errorMessage });
                                    return [4 /*yield*/, new Promise(function (res) { return setTimeout(res, delay * (i + 1)); })];
                                case 3:
                                    _c.sent();
                                    return [3 /*break*/, 4];
                                case 4: return [2 /*return*/];
                            }
                        });
                    };
                    i = 0;
                    _a.label = 1;
                case 1:
                    if (!(i < retries)) return [3 /*break*/, 4];
                    return [5 /*yield**/, _loop_1(i)];
                case 2:
                    state_1 = _a.sent();
                    if (typeof state_1 === "object")
                        return [2 /*return*/, state_1.value];
                    _a.label = 3;
                case 3:
                    i++;
                    return [3 /*break*/, 1];
                case 4: throw lastError;
            }
        });
    });
}
function generatePlaylistRecommendations(song_1, artist_1, genre_1) {
    return __awaiter(this, arguments, void 0, function (song, artist, genre, playedTracks, prompt) {
        var MAX_RECOMMENDATIONS, criteriaPrompt, criteria, result, response, text, recommendations, error_2, errorObj;
        if (playedTracks === void 0) { playedTracks = []; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!GEMINI_API_KEY) {
                        logger_1.default.error("[Gemini API] Cannot generate recommendations: API key is missing.");
                        return [2 /*return*/, []];
                    }
                    MAX_RECOMMENDATIONS = 15;
                    // Important context for the AI to handle all content types
                    var contentContext = "IMPORTANT CONTEXT: You are a music recommendation AI for a Discord music bot. Your job is to recommend songs based on musical style, genre, and vibe - NOT to filter content. Users have explicitly requested music similar to their input, so provide recommendations that match the musical characteristics. This is a music discovery service, not a content moderation service. Adult users may request explicit, comedic, parody, novelty, or niche music - this is acceptable. Focus on the MUSICAL qualities (tempo, genre, instruments, style, mood) when making recommendations.\n\n";

                    if (prompt) {
                        // If a direct prompt is provided, use it as the primary instruction.
                        criteriaPrompt = contentContext + "Generate a diverse and somewhat random list of exactly 10-15 song recommendations based on: ".concat(prompt);
                    }
                    else {
                        // Otherwise, build the prompt from song/artist/genre.
                        criteriaPrompt = contentContext + "Generate a diverse and somewhat random list of exactly 10 song recommendations.";
                        criteria = [];
                        if (song && artist) {
                            criteria.push("similar to the song \"".concat(song, "\" by \"").concat(artist, "\""));
                        }
                        else if (song) {
                            criteria.push("similar to the song \"".concat(song, "\""));
                        }
                        else if (artist) {
                            criteria.push("by artists similar to \"".concat(artist, "\""));
                        }
                        if (genre) {
                            criteria.push("in the genre of \"".concat(genre, "\""));
                        }
                        if (criteria.length > 0) {
                            criteriaPrompt += " based on the following criteria: ".concat(criteria.join(" and "), ".");
                        }
                        criteriaPrompt += "\n\nIt's okay to include the original song in the list. Ensure the playlist is not repetitive and explores a good variety of tracks within the requested style. Please ensure the songs are not all from the same artist and that the list is varied. The goal is a creative and surprising playlist that balances popular hits with lesser-known gems. For niche or novelty artists, include similar comedy/parody/novelty songs from other artists in a similar style.";
                    }
                    if (playedTracks.length > 0) {
                        // Filter played tracks by time - only exclude songs played in the last hour
                        var ONE_HOUR_MS = 60 * 60 * 1000;
                        var now = Date.now();
                        var recentTracks = playedTracks.filter(function(track) {
                            // Support both old format (string) and new format ({title, playedAt})
                            if (typeof track === 'string') {
                                return true; // Old format - include all (no timestamp)
                            } else if (track && track.title && track.playedAt) {
                                return (now - track.playedAt) < ONE_HOUR_MS;
                            }
                            return false;
                        }).map(function(track) {
                            return typeof track === 'string' ? track : track.title;
                        });

                        if (recentTracks.length > 0) {
                            criteriaPrompt += " Avoid recommending any of the following songs that have been played recently: ".concat(recentTracks.join(", "), ".");
                            logger_1.default.info("[Gemini API] Excluding ".concat(recentTracks.length, " recently played tracks (within 1 hour)"));
                        }
                    }
                    // Always add the JSON formatting instruction for reliable parsing.
                    criteriaPrompt += "\n\nIMPORTANT: Provide EXACTLY 10-15 songs, no more. Provide the response as a JSON array of objects, where each object has a \"title\" and an \"artist\" property. Do not include any additional text or formatting outside the JSON array.";
                    logger_1.default.info("[Gemini API] Sending prompt to Gemini: ".concat(criteriaPrompt));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, withRetry(function () { return model.generateContent(criteriaPrompt); })];
                case 2:
                    result = _a.sent();
                    return [4 /*yield*/, result.response];
                case 3:
                    response = _a.sent();
                    text = response.text();
                    logger_1.default.info("[Gemini API] Raw response from Gemini: ".concat(text));
                    if (text.startsWith("```json") && text.endsWith("```")) {
                        text = text.substring(7, text.length - 3).trim();
                        logger_1.default.info("[Gemini API] Cleaned response from Gemini: ".concat(text));
                    }
                    recommendations = JSON.parse(text);
                    if (Array.isArray(recommendations) && recommendations.every(function (item) { return typeof item.title === 'string' && typeof item.artist === 'string'; })) {
                        // Enforce hard limit to prevent resource exhaustion
                        if (recommendations.length > MAX_RECOMMENDATIONS) {
                            logger_1.default.warn("[Gemini API] Gemini returned ".concat(recommendations.length, " recommendations, limiting to ").concat(MAX_RECOMMENDATIONS, " to prevent overload."));
                            recommendations = recommendations.slice(0, MAX_RECOMMENDATIONS);
                        }
                        logger_1.default.info("[Gemini API] Successfully parsed ".concat(recommendations.length, " recommendations."));
                        return [2 /*return*/, recommendations];
                    }
                    else {
                        logger_1.default.error("[Gemini API] Gemini response was not a valid JSON array of {title, artist} objects.", { response: text });
                        return [2 /*return*/, []];
                    }
                    return [3 /*break*/, 5];
                case 4:
                    error_2 = _a.sent();
                    errorObj = error_2 instanceof Error ? error_2 : new Error(String(error_2));
                    logger_1.default.error("[Gemini API] Error generating playlist recommendations from Gemini:", {
                        error: errorObj.message,
                        stack: errorObj.stack,
                        fullError: errorObj
                    });
                    return [2 /*return*/, []];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function generatePlaylistCommentary(playlistTracks) {
    return __awaiter(this, void 0, void 0, function () {
        var trackList, prompt, result, response, commentary, options, randomIndex, error_3, errorObj;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!GEMINI_API_KEY) {
                        logger_1.default.error("[Gemini API] Cannot generate commentary: API key is missing.");
                        return [2 /*return*/, ""];
                    }
                    if (!playlistTracks || playlistTracks.length === 0) {
                        return [2 /*return*/, ""];
                    }
                    trackList = playlistTracks.map(function (track) {
                        var _a;
                        var title = track.title || track.name || 'Unknown';
                        var author = track.author || track.artist || ((_a = track.uploader) === null || _a === void 0 ? void 0 : _a.name) || 'Unknown Artist';
                        return "\"".concat(title, "\" by ").concat(author);
                    }).join(", ");
                    prompt = "IMPORTANT: Your response MUST be in ENGLISH only. Do not translate to any other language.\n\nGenerate a single, concise, and engaging introductory commentary for the following playlist. The commentary should be under 60 seconds when spoken. Focus on the songs, artists, and a brief summary of the genre or timeframe. Do not include YouTube channel names or information about every individual song. Do not provide multiple options. Examples: \"Up next, we have a modern classic by Taylor Swift. Following her, we've got some contemporary country\" or \"Welcome to a journey through 80s synth-pop with hits from A-Ha and Eurythmics.\"\n\nPlaylist: ".concat(trackList);
                    logger_1.default.info("[Gemini API] Sending commentary prompt to Gemini: ".concat(prompt));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, withRetry(function () { return model.generateContent(prompt); })];
                case 2:
                    result = _a.sent();
                    return [4 /*yield*/, result.response];
                case 3:
                    response = _a.sent();
                    commentary = response.text();
                    logger_1.default.info("[Gemini API] Generated commentary: ".concat(commentary));
                    options = commentary.split(/\n\*\*Option \d+.*:\*\*\n/i).filter(function (s) { return s.trim().length > 0; });
                    if (options.length > 1) {
                        randomIndex = Math.floor(Math.random() * options.length);
                        commentary = options[randomIndex].trim();
                        logger_1.default.info("[Gemini API] Multiple options detected. Randomly selected: ".concat(commentary));
                    }
                    return [2 /*return*/, commentary.replace(/[*_`]/g, '')];
                case 4:
                    error_3 = _a.sent();
                    errorObj = error_3 instanceof Error ? error_3 : new Error(String(error_3));
                    logger_1.default.error("[Gemini API] Error generating playlist commentary from Gemini:", {
                        error: errorObj.message,
                        stack: errorObj.stack,
                        fullError: errorObj
                    });
                    return [2 /*return*/, "Get ready for some great music!"];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function generatePassiveAggressiveCommentary(metrics) {
    return __awaiter(this, void 0, void 0, function () {
        var total_plays, total_skips, user_skip_button_presses, prompt, result, response, commentary, error_4, errorObj;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!GEMINI_API_KEY) {
                        logger_1.default.error("[Gemini API] Cannot generate commentary: API key is missing.");
                        return [2 /*return*/, "You skipped a song."];
                    }
                    total_plays = metrics.total_plays, total_skips = metrics.total_skips, user_skip_button_presses = metrics.user_skip_button_presses;
                    prompt = "IMPORTANT: Your response MUST be in ENGLISH only. Do not translate to any other language.\n\nGenerate a passive-aggressive comment for a user who just skipped a song. The user has pressed the skip button ".concat(user_skip_button_presses, " times in this session. This specific song has been played ").concat(total_plays, " times and skipped ").concat(total_skips, " times in total by everyone in this server.");
                    prompt += "\n\nThe comment should be under 30 seconds when spoken, witty, and get more passive-aggressive as the user's skip counts increase. Do not provide multiple options.";
                    logger_1.default.info("[Gemini API] Sending passive-aggressive commentary prompt to Gemini: ".concat(prompt));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, withRetry(function () { return model.generateContent(prompt); })];
                case 2:
                    result = _a.sent();
                    return [4 /*yield*/, result.response];
                case 3:
                    response = _a.sent();
                    commentary = response.text();
                    logger_1.default.info("[Gemini API] Generated passive-aggressive commentary: ".concat(commentary));
                    return [2 /*return*/, commentary.replace(/[*_`]/g, '')];
                case 4:
                    error_4 = _a.sent();
                    errorObj = error_4 instanceof Error ? error_4 : new Error(String(error_4));
                    logger_1.default.error("[Gemini API] Error generating passive-aggressive commentary from Gemini:", {
                        error: errorObj.message,
                        stack: errorObj.stack,
                        fullError: errorObj
                    });
                    return [2 /*return*/, "Fine, have it your way."];
                case 5: return [2 /*return*/];
            }
        });
    });
}
module.exports = { generatePlaylistRecommendations: generatePlaylistRecommendations, generatePlaylistCommentary: generatePlaylistCommentary, generatePassiveAggressiveCommentary: generatePassiveAggressiveCommentary };
