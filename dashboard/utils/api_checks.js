"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getYouTubeChannelId = getYouTubeChannelId;
exports.getTrovoUser = getTrovoUser;
exports.getTikTokUser = getTikTokUser;
exports.getFacebookUser = getFacebookUser;
exports.getInstagramUser = getInstagramUser;
exports.checkYouTube = checkYouTube;
exports.checkKick = checkKick;
exports.checkTikTok = checkTikTok;
exports.checkTrovo = checkTrovo;
exports.checkFacebook = checkFacebook;
exports.checkInstagram = checkInstagram;
exports.getLatestYouTubeVideo = getLatestYouTubeVideo;
var axios_1 = __importDefault(require("axios"));
var browserManager_1 = require("./browserManager");
var logger_1 = require("./logger");
var kick_api_1 = require("./kick-api");
// ==================== YOUTUBE FUNCTIONS ====================
function getYouTubeChannelId(identifier) {
    return __awaiter(this, void 0, void 0, function () {
        var searchIdentifier, searchResponse, channelResponse, error_1, axiosError, errorMessage;
        var _a, _b, _c, _d, _e;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0:
                    if (!process.env.YOUTUBE_API_KEY) {
                        logger_1.logger.error("[YouTube API Error] YOUTUBE_API_KEY is not set in the environment variables.");
                        return [2 /*return*/, null];
                    }
                    searchIdentifier = identifier;
                    if (identifier.startsWith('@')) {
                        searchIdentifier = identifier.substring(1);
                    }
                    if (identifier.startsWith('UC')) {
                        return [2 /*return*/, { channelId: identifier, channelName: null }];
                    }
                    _f.label = 1;
                case 1:
                    _f.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, axios_1.default.get('https://www.googleapis.com/youtube/v3/search', {
                            params: {
                                part: 'snippet',
                                q: searchIdentifier,
                                type: 'channel',
                                maxResults: 1,
                                key: process.env.YOUTUBE_API_KEY
                            }
                        })];
                case 2:
                    searchResponse = _f.sent();
                    if ((_a = searchResponse.data.items) === null || _a === void 0 ? void 0 : _a[0]) {
                        return [2 /*return*/, {
                                channelId: searchResponse.data.items[0].id.channelId,
                                channelName: searchResponse.data.items[0].snippet.title
                            }];
                    }
                    return [4 /*yield*/, axios_1.default.get('https://www.googleapis.com/youtube/v3/channels', {
                            params: {
                                part: 'snippet',
                                forUsername: searchIdentifier,
                                key: process.env.YOUTUBE_API_KEY
                            }
                        })];
                case 3:
                    channelResponse = _f.sent();
                    if ((_b = channelResponse.data.items) === null || _b === void 0 ? void 0 : _b[0]) {
                        return [2 /*return*/, {
                                channelId: channelResponse.data.items[0].id,
                                channelName: channelResponse.data.items[0].snippet.title
                            }];
                    }
                    logger_1.logger.warn("[YouTube API Check] Could not find a channel for identifier: \"".concat(identifier, "\""));
                    return [2 /*return*/, null];
                case 4:
                    error_1 = _f.sent();
                    axiosError = error_1;
                    errorMessage = ((_e = (_d = (_c = axiosError.response) === null || _c === void 0 ? void 0 : _c.data) === null || _d === void 0 ? void 0 : _d.error) === null || _e === void 0 ? void 0 : _e.message) || (error_1 instanceof Error ? error_1.message : 'Unknown error');
                    logger_1.logger.error("[YouTube API Check Error] for \"".concat(identifier, "\": ").concat(errorMessage));
                    return [2 /*return*/, null];
                case 5: return [2 /*return*/];
            }
        });
    });
}
// ==================== TROVO FUNCTIONS ====================
function getTrovoUser(username) {
    return __awaiter(this, void 0, void 0, function () {
        var trovoData, error_2, errorMessage;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (typeof username !== 'string' || !username)
                        return [2 /*return*/, null];
                    logger_1.logger.info("[Trovo API] getTrovoUser started for: ".concat(username));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, checkTrovo(username)];
                case 2:
                    trovoData = _a.sent();
                    if (trovoData && trovoData.profileImageUrl) {
                        logger_1.logger.info("[Trovo API] Successfully validated Trovo user ".concat(username, "."));
                        return [2 /*return*/, { userId: username, username: username, profileImageUrl: trovoData.profileImageUrl }];
                    }
                    logger_1.logger.info("[Trovo API] Could not validate Trovo user ".concat(username, ". They may not exist."));
                    return [2 /*return*/, null];
                case 3:
                    error_2 = _a.sent();
                    errorMessage = error_2 instanceof Error ? error_2.message : 'Unknown error';
                    logger_1.logger.error("[Trovo API Check Error] for \"".concat(username, "\": ").concat(errorMessage));
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
// ==================== TIKTOK FUNCTIONS ====================
function getTikTokUser(username) {
    return __awaiter(this, void 0, void 0, function () {
        var tiktokData, error_3, errorMessage;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (typeof username !== 'string' || !username)
                        return [2 /*return*/, null];
                    logger_1.logger.info("[TikTok API] getTikTokUser started for: ".concat(username));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, checkTikTok(username)];
                case 2:
                    tiktokData = _a.sent();
                    if (tiktokData && tiktokData.profileImageUrl) {
                        logger_1.logger.info("[TikTok API] Successfully validated TikTok user ".concat(username, "."));
                        return [2 /*return*/, { userId: username, username: username, profileImageUrl: tiktokData.profileImageUrl }];
                    }
                    logger_1.logger.info("[TikTok API] Could not validate TikTok user ".concat(username, ". They may not exist."));
                    return [2 /*return*/, null];
                case 3:
                    error_3 = _a.sent();
                    errorMessage = error_3 instanceof Error ? error_3.message : 'Unknown error';
                    logger_1.logger.error("[TikTok API Check Error] for \"".concat(username, "\": ").concat(errorMessage));
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
// ==================== KICK FUNCTIONS ====================
function checkKick(username) {
    return __awaiter(this, void 0, void 0, function () {
        var defaultResponse, kickData, profileImageUrl, thumbnail, thumbnailUrl, error_4, errorMessage;
        var _a, _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    logger_1.logger.info("[Kick Check] Starting for username: ".concat(username));
                    defaultResponse = { isLive: false, profileImageUrl: null };
                    _d.label = 1;
                case 1:
                    _d.trys.push([1, 3, 4, 5]);
                    return [4 /*yield*/, (0, kick_api_1.getKickUser)(username)];
                case 2:
                    kickData = _d.sent();
                    if (kickData === null) {
                        return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: null })];
                    }
                    profileImageUrl = ((_a = kickData === null || kickData === void 0 ? void 0 : kickData.user) === null || _a === void 0 ? void 0 : _a.profile_pic) || null;
                    if ((kickData === null || kickData === void 0 ? void 0 : kickData.livestream) && kickData.livestream.id) {
                        thumbnail = kickData.livestream.thumbnail;
                        thumbnailUrl = (thumbnail === null || thumbnail === void 0 ? void 0 : thumbnail.src) || (thumbnail === null || thumbnail === void 0 ? void 0 : thumbnail.url) || profileImageUrl;
                        return [2 /*return*/, {
                                isLive: true,
                                platform: 'kick',
                                username: kickData.user.username,
                                url: "https://kick.com/".concat(kickData.user.username),
                                title: kickData.livestream.session_title || 'Untitled Stream',
                                game: ((_c = (_b = kickData.livestream.categories) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.name) || 'N/A',
                                thumbnailUrl: thumbnailUrl,
                                viewers: kickData.livestream.viewer_count || 0,
                                profileImageUrl: profileImageUrl
                            }];
                    }
                    return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: profileImageUrl })];
                case 3:
                    error_4 = _d.sent();
                    errorMessage = error_4 instanceof Error ? error_4.message : 'Unknown error';
                    logger_1.logger.warn("[Check Kick] Could not determine status for \"".concat(username, "\" due to API errors: ").concat(errorMessage));
                    return [2 /*return*/, { isLive: 'unknown', profileImageUrl: null }];
                case 4:
                    logger_1.logger.info("[Kick Check] Finished for username: ".concat(username));
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    });
}
// ==================== YOUTUBE CHECK FUNCTION ====================
function checkYouTube(channelId) {
    return __awaiter(this, void 0, void 0, function () {
        var defaultResponse, browser, page, url, profileImageUrl, isLiveBadge, title, thumbnailUrl, e_1, errorMessage;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.logger.info("[YouTube Check] Starting for channel ID: ".concat(channelId));
                    defaultResponse = { isLive: false, profileImageUrl: null };
                    browser = null;
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 10, 11, 14]);
                    return [4 /*yield*/, (0, browserManager_1.getBrowser)()];
                case 2:
                    browser = _a.sent();
                    if (!browser) {
                        logger_1.logger.error('[YouTube Check] Browser not available.');
                        return [2 /*return*/, defaultResponse];
                    }
                    return [4 /*yield*/, browser.newPage()];
                case 3:
                    page = _a.sent();
                    page.on('crash', function () { return logger_1.logger.error("[YouTube Check] Page crashed for ".concat(channelId)); });
                    url = "https://www.youtube.com/channel/".concat(channelId, "/live");
                    return [4 /*yield*/, page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 })];
                case 4:
                    _a.sent();
                    if (!page.url().includes(channelId)) {
                        logger_1.logger.info("[YouTube Check] Redirect detected for ".concat(channelId, ". Final URL: ").concat(page.url()));
                        return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: null })];
                    }
                    return [4 /*yield*/, page.locator('#avatar #img').getAttribute('src').catch(function () { return null; })];
                case 5:
                    profileImageUrl = _a.sent();
                    if (!page.url().includes("/watch")) return [3 /*break*/, 9];
                    return [4 /*yield*/, page.locator('span.ytp-live-badge').isVisible({ timeout: 5000 })];
                case 6:
                    isLiveBadge = _a.sent();
                    if (!isLiveBadge) return [3 /*break*/, 9];
                    return [4 /*yield*/, page.title().then(function (t) { return t.replace(' - YouTube', '').trim(); })];
                case 7:
                    title = _a.sent();
                    return [4 /*yield*/, page.locator('meta[property="og:image"]').getAttribute('content').catch(function () { return null; })];
                case 8:
                    thumbnailUrl = _a.sent();
                    return [2 /*return*/, {
                            isLive: true,
                            platform: 'youtube',
                            username: title,
                            url: page.url(),
                            title: title,
                            thumbnailUrl: thumbnailUrl,
                            game: 'N/A',
                            viewers: 'N/A',
                            profileImageUrl: profileImageUrl
                        }];
                case 9: return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: profileImageUrl })];
                case 10:
                    e_1 = _a.sent();
                    errorMessage = e_1 instanceof Error ? e_1.message : 'Unknown error';
                    logger_1.logger.error("[Check YouTube Error] for channel ID \"".concat(channelId, "\": ").concat(errorMessage));
                    return [2 /*return*/, { isLive: 'unknown', profileImageUrl: null }];
                case 11:
                    if (!browser) return [3 /*break*/, 13];
                    return [4 /*yield*/, (0, browserManager_1.closeBrowser)(browser)];
                case 12:
                    _a.sent();
                    _a.label = 13;
                case 13:
                    logger_1.logger.info("[YouTube Check] Finished for channel ID: ".concat(channelId));
                    return [7 /*endfinally*/];
                case 14: return [2 /*return*/];
            }
        });
    });
}
// ==================== TIKTOK CHECK FUNCTION ====================
function checkTikTok(username) {
    return __awaiter(this, void 0, void 0, function () {
        var defaultResponse, browser, page, url, profileImageUrl, isLive, title, viewersText, e_2, errorMessage;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    logger_1.logger.info("[TikTok Check] Starting for username: ".concat(username));
                    defaultResponse = { isLive: false, profileImageUrl: null };
                    browser = null;
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 10, 11, 14]);
                    return [4 /*yield*/, (0, browserManager_1.getBrowser)()];
                case 2:
                    browser = _b.sent();
                    if (!browser) {
                        logger_1.logger.error('[TikTok Check] Browser not available.');
                        return [2 /*return*/, defaultResponse];
                    }
                    return [4 /*yield*/, browser.newPage()];
                case 3:
                    page = _b.sent();
                    page.on('crash', function () { return logger_1.logger.error("[TikTok Check] Page crashed for ".concat(username)); });
                    url = "https://www.tiktok.com/@".concat(username, "/live");
                    return [4 /*yield*/, page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 })];
                case 4:
                    _b.sent();
                    if (!page.url().includes(username)) {
                        logger_1.logger.info("[TikTok Check] Redirect detected for ".concat(username, ". Final URL: ").concat(page.url()));
                        return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: null })];
                    }
                    return [4 /*yield*/, page.locator('img[class*="StyledAvatar"]').getAttribute('src').catch(function () { return null; })];
                case 5:
                    profileImageUrl = _b.sent();
                    return [4 /*yield*/, page.locator('[data-e2e="live-room-normal"]').isVisible({ timeout: 5000 })];
                case 6:
                    isLive = _b.sent();
                    if (!isLive) return [3 /*break*/, 9];
                    return [4 /*yield*/, page.title()];
                case 7:
                    title = _b.sent();
                    return [4 /*yield*/, page.locator('[data-e2e="live-room-user-count"] span').first().textContent({ timeout: 2000 }).catch(function () { return 'N/A'; })];
                case 8:
                    viewersText = (_a = _b.sent()) !== null && _a !== void 0 ? _a : 'N/A';
                    return [2 /*return*/, {
                            isLive: true,
                            platform: 'tiktok',
                            username: username,
                            url: url,
                            title: title.includes(username) ? title : 'Live on TikTok',
                            game: 'N/A',
                            thumbnailUrl: profileImageUrl,
                            viewers: viewersText,
                            profileImageUrl: profileImageUrl
                        }];
                case 9: return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: profileImageUrl })];
                case 10:
                    e_2 = _b.sent();
                    errorMessage = e_2 instanceof Error ? e_2.message : 'Unknown error';
                    logger_1.logger.error("[Check TikTok Error] for \"".concat(username, "\": ").concat(errorMessage));
                    return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: null })];
                case 11:
                    if (!browser) return [3 /*break*/, 13];
                    return [4 /*yield*/, (0, browserManager_1.closeBrowser)(browser)];
                case 12:
                    _b.sent();
                    _b.label = 13;
                case 13:
                    logger_1.logger.info("[TikTok Check] Finished for username: ".concat(username));
                    return [7 /*endfinally*/];
                case 14: return [2 /*return*/];
            }
        });
    });
}
// ==================== TROVO CHECK FUNCTION ====================
function checkTrovo(username) {
    return __awaiter(this, void 0, void 0, function () {
        var defaultResponse, browser, page, url, profileImageUrl, isLive, title, game, thumbnailUrl, viewersText, viewers, e_3, errorMessage;
        var _a, _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    logger_1.logger.info("[Trovo Check] Starting for username: ".concat(username));
                    defaultResponse = { isLive: false, profileImageUrl: null };
                    browser = null;
                    _d.label = 1;
                case 1:
                    _d.trys.push([1, 12, 13, 16]);
                    return [4 /*yield*/, (0, browserManager_1.getBrowser)()];
                case 2:
                    browser = _d.sent();
                    if (!browser) {
                        logger_1.logger.error('[Trovo Check] Browser not available.');
                        return [2 /*return*/, defaultResponse];
                    }
                    return [4 /*yield*/, browser.newPage()];
                case 3:
                    page = _d.sent();
                    page.on('crash', function () { return logger_1.logger.error("[Trovo Check] Page crashed for ".concat(username)); });
                    url = "https://trovo.live/s/".concat(username);
                    return [4 /*yield*/, page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 })];
                case 4:
                    _d.sent();
                    if (!page.url().includes("/s/".concat(username))) {
                        logger_1.logger.info("[Trovo Check] Redirect detected for ".concat(username, ". Final URL: ").concat(page.url()));
                        return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: null })];
                    }
                    return [4 /*yield*/, page.locator('.caster-avatar img').getAttribute('src').catch(function () { return null; })];
                case 5:
                    profileImageUrl = _d.sent();
                    return [4 /*yield*/, page.locator('.live-indicator-ctn').isVisible({ timeout: 5000 })];
                case 6:
                    isLive = _d.sent();
                    if (!isLive) return [3 /*break*/, 11];
                    return [4 /*yield*/, page.title().then(function (t) { var _a, _b; return (_b = (_a = t.split('|')[0]) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : ''; })];
                case 7:
                    title = _d.sent();
                    return [4 /*yield*/, page.locator('div.category-name > a').textContent({ timeout: 2000 }).catch(function () { return 'N/A'; })];
                case 8:
                    game = (_a = _d.sent()) !== null && _a !== void 0 ? _a : 'N/A';
                    return [4 /*yield*/, page.locator('meta[property="og:image"]').getAttribute('content').catch(function () { return null; })];
                case 9:
                    thumbnailUrl = (_b = _d.sent()) !== null && _b !== void 0 ? _b : null;
                    return [4 /*yield*/, page.locator('.viewer-count span').textContent({ timeout: 2000 }).catch(function () { return '0'; })];
                case 10:
                    viewersText = (_c = _d.sent()) !== null && _c !== void 0 ? _c : '0';
                    viewers = parseInt(viewersText, 10) || 0;
                    return [2 /*return*/, {
                            isLive: true,
                            platform: 'trovo',
                            username: username,
                            url: url,
                            title: title || 'Untitled Stream',
                            game: game,
                            thumbnailUrl: thumbnailUrl,
                            viewers: viewers,
                            profileImageUrl: profileImageUrl
                        }];
                case 11: return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: profileImageUrl })];
                case 12:
                    e_3 = _d.sent();
                    errorMessage = e_3 instanceof Error ? e_3.message : 'Unknown error';
                    logger_1.logger.error("[Check Trovo Error] for \"".concat(username, "\": ").concat(errorMessage));
                    return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: null })];
                case 13:
                    if (!browser) return [3 /*break*/, 15];
                    return [4 /*yield*/, (0, browserManager_1.closeBrowser)(browser)];
                case 14:
                    _d.sent();
                    _d.label = 15;
                case 15:
                    logger_1.logger.info("[Trovo Check] Finished for username: ".concat(username));
                    return [7 /*endfinally*/];
                case 16: return [2 /*return*/];
            }
        });
    });
}
// ==================== FACEBOOK FUNCTIONS ====================
function checkFacebook(username) {
    return __awaiter(this, void 0, void 0, function () {
        var defaultResponse, browser, page_1, url, profileImageUrl, isLiveAriaLabel, isLiveText, isLive, title, thumbnailUrl, e_4, errorMessage;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    logger_1.logger.info("[Facebook Check] Starting for username: ".concat(username));
                    defaultResponse = { isLive: false, profileImageUrl: null };
                    browser = null;
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 11, 12, 15]);
                    return [4 /*yield*/, (0, browserManager_1.getBrowser)()];
                case 2:
                    browser = _b.sent();
                    if (!browser) {
                        logger_1.logger.error('[Facebook Check] Browser not available.');
                        return [2 /*return*/, defaultResponse];
                    }
                    return [4 /*yield*/, browser.newPage()];
                case 3:
                    page_1 = _b.sent();
                    page_1.on('crash', function () { return logger_1.logger.error("[Facebook Check] Page crashed for ".concat(username)); });
                    url = "https://www.facebook.com/gaming/".concat(username);
                    return [4 /*yield*/, page_1.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 })];
                case 4:
                    _b.sent();
                    // Check if redirected or user doesn't exist
                    if (!page_1.url().includes(username) && !page_1.url().includes('/gaming/')) {
                        logger_1.logger.info("[Facebook Check] Redirect detected for ".concat(username, ". Final URL: ").concat(page_1.url()));
                        return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: null })];
                    }
                    return [4 /*yield*/, page_1.locator('img[data-imgperflogname="profileCoverPhoto"]').getAttribute('src').catch(function () {
                            return page_1.locator('img[class*="ProfilePhoto"]').getAttribute('src').catch(function () { return null; });
                        })];
                case 5:
                    profileImageUrl = _b.sent();
                    return [4 /*yield*/, page_1.locator('[aria-label*="Live"]').isVisible({ timeout: 5000 }).catch(function () { return false; })];
                case 6:
                    isLiveAriaLabel = _b.sent();
                    return [4 /*yield*/, page_1.locator('text=/LIVE/i').isVisible({ timeout: 5000 }).catch(function () { return false; })];
                case 7:
                    isLiveText = _b.sent();
                    isLive = isLiveAriaLabel || isLiveText;
                    if (!isLive) return [3 /*break*/, 10];
                    return [4 /*yield*/, page_1.title().then(function (t) { var _a, _b; return (_b = (_a = t.split('|')[0]) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : ''; })];
                case 8:
                    title = _b.sent();
                    return [4 /*yield*/, page_1.locator('meta[property="og:image"]').getAttribute('content').catch(function () { return null; })];
                case 9:
                    thumbnailUrl = (_a = _b.sent()) !== null && _a !== void 0 ? _a : null;
                    return [2 /*return*/, {
                            isLive: true,
                            platform: 'facebook',
                            username: username,
                            url: url,
                            title: title || 'Live on Facebook Gaming',
                            game: 'N/A', // Facebook doesn't always expose game category via scraping
                            thumbnailUrl: thumbnailUrl,
                            viewers: 'N/A', // Viewer count often hidden or requires login
                            profileImageUrl: profileImageUrl
                        }];
                case 10: return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: profileImageUrl })];
                case 11:
                    e_4 = _b.sent();
                    errorMessage = e_4 instanceof Error ? e_4.message : 'Unknown error';
                    logger_1.logger.error("[Check Facebook Error] for \"".concat(username, "\": ").concat(errorMessage));
                    return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: null })];
                case 12:
                    if (!browser) return [3 /*break*/, 14];
                    return [4 /*yield*/, (0, browserManager_1.closeBrowser)(browser)];
                case 13:
                    _b.sent();
                    _b.label = 14;
                case 14:
                    logger_1.logger.info("[Facebook Check] Finished for username: ".concat(username));
                    return [7 /*endfinally*/];
                case 15: return [2 /*return*/];
            }
        });
    });
}
function getFacebookUser(username) {
    return __awaiter(this, void 0, void 0, function () {
        var facebookData, error_5, errorMessage;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (typeof username !== 'string' || !username)
                        return [2 /*return*/, null];
                    logger_1.logger.info("[Facebook API] getFacebookUser started for: ".concat(username));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, checkFacebook(username)];
                case 2:
                    facebookData = _a.sent();
                    if (facebookData && facebookData.profileImageUrl) {
                        logger_1.logger.info("[Facebook API] Successfully validated Facebook Gaming user ".concat(username, "."));
                        return [2 /*return*/, { userId: username, username: username, profileImageUrl: facebookData.profileImageUrl }];
                    }
                    logger_1.logger.info("[Facebook API] Could not validate Facebook Gaming user ".concat(username, ". They may not exist."));
                    return [2 /*return*/, null];
                case 3:
                    error_5 = _a.sent();
                    errorMessage = error_5 instanceof Error ? error_5.message : 'Unknown error';
                    logger_1.logger.error("[Facebook API Check Error] for \"".concat(username, "\": ").concat(errorMessage));
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
// ==================== INSTAGRAM FUNCTIONS ====================
function checkInstagram(username) {
    return __awaiter(this, void 0, void 0, function () {
        var defaultResponse, browser, page_2, url, profileImageUrl, isLiveAriaLabel, isLiveText, isLive, title, e_5, errorMessage;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.logger.info("[Instagram Check] Starting for username: ".concat(username));
                    defaultResponse = { isLive: false, profileImageUrl: null };
                    browser = null;
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 10, 11, 14]);
                    return [4 /*yield*/, (0, browserManager_1.getBrowser)()];
                case 2:
                    browser = _a.sent();
                    if (!browser) {
                        logger_1.logger.error('[Instagram Check] Browser not available.');
                        return [2 /*return*/, defaultResponse];
                    }
                    return [4 /*yield*/, browser.newPage()];
                case 3:
                    page_2 = _a.sent();
                    page_2.on('crash', function () { return logger_1.logger.error("[Instagram Check] Page crashed for ".concat(username)); });
                    url = "https://www.instagram.com/".concat(username, "/live/");
                    return [4 /*yield*/, page_2.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 })];
                case 4:
                    _a.sent();
                    // Check if redirected or user doesn't exist
                    if (!page_2.url().includes(username)) {
                        logger_1.logger.info("[Instagram Check] Redirect detected for ".concat(username, ". Final URL: ").concat(page_2.url()));
                        return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: null })];
                    }
                    return [4 /*yield*/, page_2.locator('img[class*="xpdipgo"]').getAttribute('src').catch(function () {
                            return page_2.locator('meta[property="og:image"]').getAttribute('content').catch(function () { return null; });
                        })];
                case 5:
                    profileImageUrl = _a.sent();
                    return [4 /*yield*/, page_2.locator('[aria-label*="Live"]').isVisible({ timeout: 5000 }).catch(function () { return false; })];
                case 6:
                    isLiveAriaLabel = _a.sent();
                    return [4 /*yield*/, page_2.locator('text=/LIVE/i').first().isVisible({ timeout: 5000 }).catch(function () { return false; })];
                case 7:
                    isLiveText = _a.sent();
                    isLive = isLiveAriaLabel || isLiveText;
                    if (!isLive) return [3 /*break*/, 9];
                    return [4 /*yield*/, page_2.title().then(function (t) { return t.replace(' • Instagram', '').trim(); })];
                case 8:
                    title = _a.sent();
                    return [2 /*return*/, {
                            isLive: true,
                            platform: 'instagram',
                            username: username,
                            url: "https://www.instagram.com/".concat(username, "/"),
                            title: title || "".concat(username, " is live on Instagram"),
                            game: 'N/A',
                            thumbnailUrl: profileImageUrl,
                            viewers: 'N/A', // Viewer count requires login to see
                            profileImageUrl: profileImageUrl
                        }];
                case 9: return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: profileImageUrl })];
                case 10:
                    e_5 = _a.sent();
                    errorMessage = e_5 instanceof Error ? e_5.message : 'Unknown error';
                    logger_1.logger.error("[Check Instagram Error] for \"".concat(username, "\": ").concat(errorMessage));
                    return [2 /*return*/, __assign(__assign({}, defaultResponse), { profileImageUrl: null })];
                case 11:
                    if (!browser) return [3 /*break*/, 13];
                    return [4 /*yield*/, (0, browserManager_1.closeBrowser)(browser)];
                case 12:
                    _a.sent();
                    _a.label = 13;
                case 13:
                    logger_1.logger.info("[Instagram Check] Finished for username: ".concat(username));
                    return [7 /*endfinally*/];
                case 14: return [2 /*return*/];
            }
        });
    });
}
function getInstagramUser(username) {
    return __awaiter(this, void 0, void 0, function () {
        var instagramData, error_6, errorMessage;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (typeof username !== 'string' || !username)
                        return [2 /*return*/, null];
                    logger_1.logger.info("[Instagram API] getInstagramUser started for: ".concat(username));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, checkInstagram(username)];
                case 2:
                    instagramData = _a.sent();
                    if (instagramData && instagramData.profileImageUrl) {
                        logger_1.logger.info("[Instagram API] Successfully validated Instagram user ".concat(username, "."));
                        return [2 /*return*/, { userId: username, username: username, profileImageUrl: instagramData.profileImageUrl }];
                    }
                    logger_1.logger.info("[Instagram API] Could not validate Instagram user ".concat(username, ". They may not exist."));
                    return [2 /*return*/, null];
                case 3:
                    error_6 = _a.sent();
                    errorMessage = error_6 instanceof Error ? error_6.message : 'Unknown error';
                    logger_1.logger.error("[Instagram API Check Error] for \"".concat(username, "\": ").concat(errorMessage));
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/**
 * Get the latest YouTube video for a channel
 * @param channelId - YouTube channel ID
 * @returns Latest video data or null if not found
 */
function getLatestYouTubeVideo(channelId) {
    return __awaiter(this, void 0, void 0, function () {
        var response, item, error_7;
        var _a, _b, _c, _d, _e, _f;
        return __generator(this, function (_g) {
            switch (_g.label) {
                case 0:
                    _g.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, axios_1.default.get('https://www.googleapis.com/youtube/v3/search', {
                            params: {
                                part: 'snippet',
                                channelId: channelId,
                                order: 'date',
                                maxResults: 1,
                                type: 'video',
                                key: process.env.YOUTUBE_API_KEY
                            }
                        })];
                case 1:
                    response = _g.sent();
                    item = (_a = response.data.items) === null || _a === void 0 ? void 0 : _a[0];
                    if (!item)
                        return [2 /*return*/, null];
                    return [2 /*return*/, {
                            videoId: item.id.videoId,
                            title: item.snippet.title,
                            url: "https://www.youtube.com/watch?v=".concat(item.id.videoId),
                            thumbnailUrl: ((_c = (_b = item.snippet.thumbnails) === null || _b === void 0 ? void 0 : _b.high) === null || _c === void 0 ? void 0 : _c.url) || ((_e = (_d = item.snippet.thumbnails) === null || _d === void 0 ? void 0 : _d.default) === null || _e === void 0 ? void 0 : _e.url) || null,
                            publishedAt: item.snippet.publishedAt,
                            channelTitle: item.snippet.channelTitle
                        }];
                case 2:
                    error_7 = _g.sent();
                    logger_1.logger.error("[YouTube API] Error fetching latest video for channel ".concat(channelId, ":"), { error: ((_f = error_7.response) === null || _f === void 0 ? void 0 : _f.data) || error_7.message });
                    return [2 /*return*/, null];
                case 3: return [2 /*return*/];
            }
        });
    });
}
