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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStreamerLive = isStreamerLive;
exports.getStreamDetails = getStreamDetails;
exports.getAccessToken = getAccessToken;
exports.getStreamSchedule = getStreamSchedule;
exports.getTwitchUser = getTwitchUser;
exports.getTwitchUsers = getTwitchUsers;
exports.getTwitchTeamMembers = getTwitchTeamMembers;
exports.getApiStatus = getApiStatus;
var axios_1 = __importDefault(require("axios"));
var logger_1 = __importDefault(require("./logger"));
var accessToken = null;
var tokenExpiresAt = 0;
function getAccessToken() {
    return __awaiter(this, void 0, void 0, function () {
        var response, error_1, errorData;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (accessToken && Date.now() < tokenExpiresAt) {
                        return [2 /*return*/, accessToken];
                    }
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, axios_1.default.post("https://id.twitch.tv/oauth2/token?client_id=".concat(process.env.TWITCH_CLIENT_ID, "&client_secret=").concat(process.env.TWITCH_CLIENT_SECRET, "&grant_type=client_credentials"))];
                case 2:
                    response = _b.sent();
                    accessToken = response.data.access_token;
                    tokenExpiresAt = Date.now() + (response.data.expires_in * 1000) - (5 * 60 * 1000); // Refresh 5 mins before expiry
                    logger_1.default.info('Successfully refreshed Twitch API token.', { category: 'twitch' });
                    return [2 /*return*/, accessToken];
                case 3:
                    error_1 = _b.sent();
                    errorData = axios_1.default.isAxiosError(error_1) ? (((_a = error_1.response) === null || _a === void 0 ? void 0 : _a.data) || error_1.message) : 'Unknown error';
                    logger_1.default.error('Failed to get Twitch API token:', { error: errorData, category: 'twitch' });
                    throw new Error('Could not get Twitch API token.');
                case 4: return [2 /*return*/];
            }
        });
    });
}
function isStreamerLive(twitchUsername) {
    return __awaiter(this, void 0, void 0, function () {
        var token, response, error_2, errorData;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, getAccessToken()];
                case 1:
                    token = _b.sent();
                    return [4 /*yield*/, axios_1.default.get("https://api.twitch.tv/helix/streams?user_login=".concat(twitchUsername), {
                            headers: {
                                'Client-ID': process.env.TWITCH_CLIENT_ID,
                                'Authorization': "Bearer ".concat(token)
                            }
                        })];
                case 2:
                    response = _b.sent();
                    return [2 /*return*/, response.data.data.length > 0];
                case 3:
                    error_2 = _b.sent();
                    errorData = axios_1.default.isAxiosError(error_2) ? (((_a = error_2.response) === null || _a === void 0 ? void 0 : _a.data) || error_2.message) : 'Unknown error';
                    logger_1.default.error("Error checking if streamer ".concat(twitchUsername, " is live:"), { error: errorData, category: 'twitch' });
                    return [2 /*return*/, false];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function getStreamDetails(twitchUsername) {
    return __awaiter(this, void 0, void 0, function () {
        var token, response, error_3, errorData;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, getAccessToken()];
                case 1:
                    token = _b.sent();
                    return [4 /*yield*/, axios_1.default.get("https://api.twitch.tv/helix/streams?user_login=".concat(twitchUsername), {
                            headers: {
                                'Client-ID': process.env.TWITCH_CLIENT_ID,
                                'Authorization': "Bearer ".concat(token)
                            }
                        })];
                case 2:
                    response = _b.sent();
                    return [2 /*return*/, response.data.data[0] || null];
                case 3:
                    error_3 = _b.sent();
                    errorData = axios_1.default.isAxiosError(error_3) ? (((_a = error_3.response) === null || _a === void 0 ? void 0 : _a.data) || error_3.message) : 'Unknown error';
                    logger_1.default.error("Error getting stream details for ".concat(twitchUsername, ":"), { error: errorData, category: 'twitch' });
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function getStreamSchedule(twitchUserId) {
    return __awaiter(this, void 0, void 0, function () {
        var token, error_4, errorData;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, getAccessToken()];
                case 1:
                    token = _b.sent();
                    return [4 /*yield*/, axios_1.default.get("https://api.twitch.tv/helix/schedule?broadcaster_id=".concat(twitchUserId), {
                            headers: {
                                'Client-ID': process.env.TWITCH_CLIENT_ID,
                                'Authorization': "Bearer ".concat(token)
                            }
                        })];
                case 2: return [2 /*return*/, _b.sent()];
                case 3:
                    error_4 = _b.sent();
                    errorData = axios_1.default.isAxiosError(error_4) ? (((_a = error_4.response) === null || _a === void 0 ? void 0 : _a.data) || error_4.message) : 'Unknown error';
                    logger_1.default.error("Error getting stream schedule for ".concat(twitchUserId, ":"), { error: errorData, category: 'twitch' });
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function getTwitchUser(identifier) {
    return __awaiter(this, void 0, void 0, function () {
        var token, isUserId, param, response, error_5, errorData;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, getAccessToken()];
                case 1:
                    token = _c.sent();
                    if (!token)
                        return [2 /*return*/, null];
                    isUserId = /^[0-9]+$/.test(identifier);
                    param = isUserId ? 'id' : 'login';
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, axios_1.default.get("https://api.twitch.tv/helix/users?".concat(param, "=").concat(identifier.toLowerCase()), {
                            headers: {
                                'Client-ID': process.env.TWITCH_CLIENT_ID,
                                'Authorization': "Bearer ".concat(token)
                            }
                        })];
                case 3:
                    response = _c.sent();
                    return [2 /*return*/, ((_a = response.data.data) === null || _a === void 0 ? void 0 : _a[0]) || null];
                case 4:
                    error_5 = _c.sent();
                    errorData = axios_1.default.isAxiosError(error_5) ? (((_b = error_5.response) === null || _b === void 0 ? void 0 : _b.data) || error_5.message) : 'Unknown error';
                    logger_1.default.error("[Twitch User Check Error] for \"".concat(identifier, "\":"), { error: errorData, category: 'twitch' });
                    return [2 /*return*/, null];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function getTwitchTeamMembers(teamName) {
    return __awaiter(this, void 0, void 0, function () {
        var token, response, error_6, errorData;
        var _a, _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0: return [4 /*yield*/, getAccessToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, null];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, axios_1.default.get("https://api.twitch.tv/helix/teams?name=".concat(teamName.toLowerCase()), {
                            headers: {
                                'Client-ID': process.env.TWITCH_CLIENT_ID,
                                'Authorization': "Bearer ".concat(token)
                            }
                        })];
                case 3:
                    response = _d.sent();
                    return [2 /*return*/, ((_b = (_a = response.data.data) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.users) || null];
                case 4:
                    error_6 = _d.sent();
                    errorData = axios_1.default.isAxiosError(error_6) ? (((_c = error_6.response) === null || _c === void 0 ? void 0 : _c.data) || error_6.message) : 'Unknown error';
                    logger_1.default.error("[Twitch Team Check Error] for \"".concat(teamName, "\":"), { error: errorData, category: 'twitch' });
                    return [2 /*return*/, null];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function getTwitchUsers(usernames) {
    return __awaiter(this, void 0, void 0, function () {
        var token, maxPerRequest, chunks, i, allUsers, _i, chunks_1, chunk, loginParams, response, error_7, errorData;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, getAccessToken()];
                case 1:
                    token = _b.sent();
                    if (!token || usernames.length === 0)
                        return [2 /*return*/, []];
                    maxPerRequest = 100;
                    chunks = [];
                    for (i = 0; i < usernames.length; i += maxPerRequest) {
                        chunks.push(usernames.slice(i, i + maxPerRequest));
                    }
                    allUsers = [];
                    _i = 0, chunks_1 = chunks;
                    _b.label = 2;
                case 2:
                    if (!(_i < chunks_1.length)) return [3 /*break*/, 7];
                    chunk = chunks_1[_i];
                    loginParams = chunk.map(function (u) { return "login=".concat(encodeURIComponent(u.toLowerCase())); }).join('&');
                    _b.label = 3;
                case 3:
                    _b.trys.push([3, 5, , 6]);
                    return [4 /*yield*/, axios_1.default.get("https://api.twitch.tv/helix/users?".concat(loginParams), {
                            headers: {
                                'Client-ID': process.env.TWITCH_CLIENT_ID,
                                'Authorization': "Bearer ".concat(token)
                            }
                        })];
                case 4:
                    response = _b.sent();
                    if (response.data.data) {
                        allUsers.push.apply(allUsers, response.data.data);
                    }
                    return [3 /*break*/, 6];
                case 5:
                    error_7 = _b.sent();
                    errorData = axios_1.default.isAxiosError(error_7) ? (((_a = error_7.response) === null || _a === void 0 ? void 0 : _a.data) || error_7.message) : 'Unknown error';
                    logger_1.default.error("[Twitch Batch User Check Error]:", { error: errorData, category: 'twitch' });
                    return [3 /*break*/, 6];
                case 6:
                    _i++;
                    return [3 /*break*/, 2];
                case 7: return [2 /*return*/, allUsers];
            }
        });
    });
}
function getApiStatus() {
    return __awaiter(this, void 0, void 0, function () {
        var error_8;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, getAccessToken()];
                case 1:
                    _a.sent();
                    return [2 /*return*/, true];
                case 2:
                    error_8 = _a.sent();
                    return [2 /*return*/, false];
                case 3: return [2 /*return*/];
            }
        });
    });
}
