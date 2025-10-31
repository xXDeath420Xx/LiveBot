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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getKickUser = getKickUser;
exports.isStreamerLive = isStreamerLive;
exports.getStreamDetails = getStreamDetails;
var logger_1 = require("./logger");
var tls_manager_1 = require("./tls-manager");
function getKickUser(username) {
    return __awaiter(this, void 0, void 0, function () {
        var MAX_RETRIES, RETRY_DELAY, attempt, cycleTLS, requestUrl, timeoutPromise, cycleTLSRequest, response, data, error_1, errorMessage;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (typeof username !== 'string' || !username)
                        return [2 /*return*/, null];
                    logger_1.logger.info("[Kick API] getKickUser started for: ".concat(username));
                    MAX_RETRIES = 3;
                    RETRY_DELAY = 5000;
                    attempt = 1;
                    _a.label = 1;
                case 1:
                    if (!(attempt <= MAX_RETRIES)) return [3 /*break*/, 9];
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, (0, tls_manager_1.getCycleTLSInstance)()];
                case 3:
                    cycleTLS = _a.sent();
                    requestUrl = "https://kick.com/api/v1/channels/".concat(username);
                    logger_1.logger.info("[Kick API] Initiating cycleTLS request for ".concat(username, " to ").concat(requestUrl, " (Attempt ").concat(attempt, ")"));
                    timeoutPromise = new Promise(function (_, reject) {
                        return setTimeout(function () { return reject(new Error("CycleTLS request timed out after 30 seconds for ".concat(username))); }, 30000);
                    });
                    cycleTLSRequest = cycleTLS(requestUrl, {
                        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                    });
                    return [4 /*yield*/, Promise.race([cycleTLSRequest, timeoutPromise])];
                case 4:
                    response = _a.sent();
                    logger_1.logger.info("[Kick API] cycleTLS request completed for ".concat(username, ". Status: ").concat(response.status));
                    if (response.status === 200 && response.body) {
                        data = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
                        if (!data || !data.user) {
                            logger_1.logger.info("[Kick API] No 'user' object in response for '".concat(username, "', assuming non-existent."));
                            return [2 /*return*/, null];
                        }
                        logger_1.logger.info("[Kick API] Successfully retrieved Kick user data for ".concat(username, "."));
                        return [2 /*return*/, data];
                    }
                    if (response.status === 404) {
                        logger_1.logger.warn("[Kick API] Received 404 for ".concat(username, ", user likely does not exist. Not retrying."));
                        return [2 /*return*/, null];
                    }
                    logger_1.logger.warn("[Kick API] Received status ".concat(response.status, " for ").concat(username, ". Retrying in ").concat(RETRY_DELAY / 1000, "s..."));
                    return [3 /*break*/, 6];
                case 5:
                    error_1 = _a.sent();
                    errorMessage = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    logger_1.logger.error("[Kick API Check Error] for \"".concat(username, "\" on attempt ").concat(attempt, ": ").concat(errorMessage));
                    return [3 /*break*/, 6];
                case 6:
                    if (!(attempt < MAX_RETRIES)) return [3 /*break*/, 8];
                    return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, RETRY_DELAY); })];
                case 7:
                    _a.sent();
                    _a.label = 8;
                case 8:
                    attempt++;
                    return [3 /*break*/, 1];
                case 9:
                    logger_1.logger.error("[Kick API] All retries failed for ".concat(username, "."));
                    return [2 /*return*/, null];
            }
        });
    });
}
function isStreamerLive(username) {
    return __awaiter(this, void 0, void 0, function () {
        var user, error_2;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, getKickUser(username)];
                case 1:
                    user = _b.sent();
                    return [2 /*return*/, ((_a = user === null || user === void 0 ? void 0 : user.livestream) === null || _a === void 0 ? void 0 : _a.is_live) || false];
                case 2:
                    error_2 = _b.sent();
                    logger_1.logger.error("[Kick API] Error checking live status for ".concat(username, ":"), { error: error_2 });
                    return [2 /*return*/, false];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function getStreamDetails(username) {
    return __awaiter(this, void 0, void 0, function () {
        var user, error_3;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, getKickUser(username)];
                case 1:
                    user = _c.sent();
                    if (!user || !user.livestream || !user.livestream.is_live) {
                        return [2 /*return*/, null];
                    }
                    return [2 /*return*/, {
                            title: user.livestream.session_title,
                            game_name: ((_a = user.livestream.categories[0]) === null || _a === void 0 ? void 0 : _a.name) || 'Not Set',
                            viewer_count: user.livestream.viewer_count || 0,
                            thumbnail_url: ((_b = user.livestream.thumbnail) === null || _b === void 0 ? void 0 : _b.url) || null,
                            started_at: user.livestream.created_at || null, // Kick uses created_at for stream start time
                        }];
                case 2:
                    error_3 = _c.sent();
                    logger_1.logger.error("[Kick API] Failed to get stream details for ".concat(username, ":"), { error: error_3 });
                    return [2 /*return*/, null];
                case 3: return [2 /*return*/];
            }
        });
    });
}
