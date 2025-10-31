"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.init = init;
exports.checkStreamers = checkStreamers;
exports.getLiveAnnouncements = getLiveAnnouncements;
var discord_js_1 = require("discord.js");
var db_1 = __importDefault(require("../utils/db"));
var twitchApi = __importStar(require("../utils/twitch-api"));
var kickApi = __importStar(require("../utils/kick-api"));
var facebookApi = __importStar(require("../utils/facebook-api"));
var instagramApi = __importStar(require("../utils/instagram-api"));
var youtubeApi = __importStar(require("../utils/youtube-api"));
var tiktokApi = __importStar(require("../utils/tiktok-api"));
var trovoApi = __importStar(require("../utils/trovo-api"));
var logger_1 = __importDefault(require("../utils/logger"));
var announcer_1 = require("../utils/announcer");
var liveAnnouncements = new Map();
// Counter to track stream check passes for embed updates
var streamCheckPassCounter = 0;
var EMBED_UPDATE_INTERVAL = 5; // Update embeds every 5th pass
// Load active announcements from database on startup
function loadAnnouncementsFromDatabase() {
    return __awaiter(this, void 0, void 0, function () {
        var connection, rows, _i, rows_1, row, key, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, 4, 5]);
                    return [4 /*yield*/, db_1.default.getConnection()];
                case 1:
                    connection = _a.sent();
                    return [4 /*yield*/, connection.query('SELECT * FROM live_announcements')];
                case 2:
                    rows = (_a.sent())[0];
                    for (_i = 0, rows_1 = rows; _i < rows_1.length; _i++) {
                        row = rows_1[_i];
                        key = "".concat(row.guild_id, "-").concat(row.platform, "-").concat(row.username, "-").concat(row.channel_id);
                        liveAnnouncements.set(key, {
                            messageId: row.message_id,
                            streamerId: row.streamer_id,
                            platform: row.platform,
                            username: row.username,
                            discordUserId: row.discord_user_id
                        });
                    }
                    logger_1.default.info("Loaded ".concat(rows.length, " active announcements from database"), { category: "streams" });
                    return [3 /*break*/, 5];
                case 3:
                    error_1 = _a.sent();
                    // If table doesn't exist yet, just log a warning
                    if (error_1.code === 'ER_NO_SUCH_TABLE') {
                        logger_1.default.warn('live_announcements table does not exist yet. Run stream-state-migration.sql to create it.', { category: "streams" });
                    }
                    else {
                        logger_1.default.error('Failed to load announcements from database:', { error: error_1, category: "streams" });
                    }
                    return [3 /*break*/, 5];
                case 4:
                    if (connection)
                        connection.release();
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    });
}
// Save announcement to database
function saveAnnouncementToDatabase(guildId_1, platform_1, username_1, channelId_1, messageId_1, streamerId_1, discordUserId_1) {
    return __awaiter(this, arguments, void 0, function (guildId, platform, username, channelId, messageId, streamerId, discordUserId, streamStartedAt) {
        var connection, error_2;
        if (streamStartedAt === void 0) { streamStartedAt = null; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, 4, 5]);
                    return [4 /*yield*/, db_1.default.getConnection()];
                case 1:
                    connection = _a.sent();
                    return [4 /*yield*/, connection.query("INSERT INTO live_announcements (guild_id, platform, username, channel_id, message_id, streamer_id, discord_user_id, stream_started_at)\n             VALUES (?, ?, ?, ?, ?, ?, ?, ?)\n             ON DUPLICATE KEY UPDATE message_id = VALUES(message_id), stream_started_at = VALUES(stream_started_at), updated_at = CURRENT_TIMESTAMP", [guildId, platform, username, channelId, messageId, streamerId, discordUserId, streamStartedAt])];
                case 2:
                    _a.sent();
                    return [3 /*break*/, 5];
                case 3:
                    error_2 = _a.sent();
                    if (error_2.code !== 'ER_NO_SUCH_TABLE') {
                        logger_1.default.error('Failed to save announcement to database:', { error: error_2, guildId: guildId, platform: platform, username: username, category: "streams" });
                    }
                    return [3 /*break*/, 5];
                case 4:
                    if (connection)
                        connection.release();
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    });
}
// Delete announcement from database
function deleteAnnouncementFromDatabase(guildId, platform, username, channelId) {
    return __awaiter(this, void 0, void 0, function () {
        var connection, error_3;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, 4, 5]);
                    return [4 /*yield*/, db_1.default.getConnection()];
                case 1:
                    connection = _a.sent();
                    return [4 /*yield*/, connection.query('DELETE FROM live_announcements WHERE guild_id = ? AND platform = ? AND username = ? AND channel_id = ?', [guildId, platform, username, channelId])];
                case 2:
                    _a.sent();
                    return [3 /*break*/, 5];
                case 3:
                    error_3 = _a.sent();
                    if (error_3.code !== 'ER_NO_SUCH_TABLE') {
                        logger_1.default.error('Failed to delete announcement from database:', { error: error_3, guildId: guildId, platform: platform, username: username, category: "streams" });
                    }
                    return [3 /*break*/, 5];
                case 4:
                    if (connection)
                        connection.release();
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    });
}
// Clear all announcements from both memory and database
function clearAllAnnouncements() {
    return __awaiter(this, void 0, void 0, function () {
        var connection, error_4;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, 4, 5]);
                    return [4 /*yield*/, db_1.default.getConnection()];
                case 1:
                    connection = _a.sent();
                    return [4 /*yield*/, connection.query('DELETE FROM live_announcements')];
                case 2:
                    _a.sent();
                    liveAnnouncements.clear();
                    logger_1.default.info('Cleared all announcement state from memory and database', { category: "streams" });
                    return [3 /*break*/, 5];
                case 3:
                    error_4 = _a.sent();
                    if (error_4.code !== 'ER_NO_SUCH_TABLE') {
                        logger_1.default.error('Failed to clear announcements from database:', { error: error_4, category: "streams" });
                    }
                    // Still clear memory even if database fails
                    liveAnnouncements.clear();
                    return [3 /*break*/, 5];
                case 4:
                    if (connection)
                        connection.release();
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    });
}
var platformModules = {
    twitch: twitchApi,
    kick: kickApi,
    facebook: facebookApi,
    instagram: instagramApi,
    youtube: youtubeApi,
    tiktok: tiktokApi,
    trovo: trovoApi,
};
function aggressiveCleanup(client) {
    return __awaiter(this, void 0, void 0, function () {
        var connection, allGuilds, membersToProcess, liveStatusCache, _loop_1, _i, allGuilds_1, g, _a, _b, _c, member, guilds, streamerRows, isActuallyLive, _d, streamerRows_1, streamer, cacheKey, api, liveStatus, _loop_2, _e, _f, _g, guildId, roleIds, e_1, error_5;
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0:
                    logger_1.default.info("Starting aggressive cleanup of stale live roles...", { category: "streams" });
                    _h.label = 1;
                case 1:
                    _h.trys.push([1, 24, 25, 26]);
                    return [4 /*yield*/, db_1.default.getConnection()];
                case 2:
                    connection = _h.sent();
                    return [4 /*yield*/, connection.query('SELECT guild_id FROM guilds')];
                case 3:
                    allGuilds = (_h.sent())[0];
                    membersToProcess = new Map();
                    liveStatusCache = new Map();
                    _loop_1 = function (g) {
                        var guild, guildRoles, teamRoles, subRoles, allRoleIds, members, _j, _k, member, memberRoles;
                        return __generator(this, function (_l) {
                            switch (_l.label) {
                                case 0: return [4 /*yield*/, client.guilds.fetch(g.guild_id).catch(function () { return null; })];
                                case 1:
                                    guild = _l.sent();
                                    if (!guild)
                                        return [2 /*return*/, "continue"];
                                    return [4 /*yield*/, connection.query('SELECT live_role_id FROM guilds WHERE guild_id = ? AND live_role_id IS NOT NULL', [guild.id])];
                                case 2:
                                    guildRoles = (_l.sent())[0];
                                    return [4 /*yield*/, connection.query('SELECT live_role_id FROM twitch_teams WHERE guild_id = ? AND live_role_id IS NOT NULL', [guild.id])];
                                case 3:
                                    teamRoles = (_l.sent())[0];
                                    return [4 /*yield*/, connection.query('SELECT live_role_id FROM subscriptions WHERE guild_id = ? AND live_role_id IS NOT NULL', [guild.id])];
                                case 4:
                                    subRoles = (_l.sent())[0];
                                    allRoleIds = new Set(__spreadArray(__spreadArray(__spreadArray([], guildRoles.map(function (r) { return r.live_role_id; }), true), teamRoles.map(function (r) { return r.live_role_id; }), true), subRoles.map(function (r) { return r.live_role_id; }), true));
                                    if (allRoleIds.size === 0)
                                        return [2 /*return*/, "continue"];
                                    return [4 /*yield*/, guild.members.fetch().catch(function () {
                                            logger_1.default.warn("Failed to fetch members for guild ".concat(guild.id, "."), { guildId: guild.id, category: "streams" });
                                            return new Map();
                                        })];
                                case 5:
                                    members = _l.sent();
                                    for (_j = 0, _k = members.values(); _j < _k.length; _j++) {
                                        member = _k[_j];
                                        memberRoles = member.roles.cache.filter(function (role) { return allRoleIds.has(role.id); });
                                        if (memberRoles.size > 0) {
                                            if (!membersToProcess.has(member.id)) {
                                                membersToProcess.set(member.id, { member: member, guilds: new Map() });
                                            }
                                            membersToProcess.get(member.id).guilds.set(guild.id, new Set(memberRoles.keys()));
                                        }
                                    }
                                    return [2 /*return*/];
                            }
                        });
                    };
                    _i = 0, allGuilds_1 = allGuilds;
                    _h.label = 4;
                case 4:
                    if (!(_i < allGuilds_1.length)) return [3 /*break*/, 7];
                    g = allGuilds_1[_i];
                    return [5 /*yield**/, _loop_1(g)];
                case 5:
                    _h.sent();
                    _h.label = 6;
                case 6:
                    _i++;
                    return [3 /*break*/, 4];
                case 7:
                    logger_1.default.info("Found ".concat(membersToProcess.size, " unique members with live roles across all guilds for cleanup check."));
                    _a = 0, _b = membersToProcess.values();
                    _h.label = 8;
                case 8:
                    if (!(_a < _b.length)) return [3 /*break*/, 23];
                    _c = _b[_a], member = _c.member, guilds = _c.guilds;
                    _h.label = 9;
                case 9:
                    _h.trys.push([9, 21, , 22]);
                    return [4 /*yield*/, connection.query('SELECT username, platform FROM streamers WHERE discord_user_id = ?', [member.id])];
                case 10:
                    streamerRows = (_h.sent())[0];
                    isActuallyLive = false;
                    if (!(streamerRows.length > 0)) return [3 /*break*/, 16];
                    _d = 0, streamerRows_1 = streamerRows;
                    _h.label = 11;
                case 11:
                    if (!(_d < streamerRows_1.length)) return [3 /*break*/, 16];
                    streamer = streamerRows_1[_d];
                    cacheKey = "".concat(streamer.platform, ":").concat(streamer.username);
                    if (!liveStatusCache.has(cacheKey)) return [3 /*break*/, 12];
                    isActuallyLive = liveStatusCache.get(cacheKey);
                    return [3 /*break*/, 14];
                case 12:
                    api = platformModules[streamer.platform];
                    if (!api) return [3 /*break*/, 14];
                    return [4 /*yield*/, api.isStreamerLive(streamer.username)];
                case 13:
                    liveStatus = _h.sent();
                    liveStatusCache.set(cacheKey, liveStatus);
                    isActuallyLive = liveStatus;
                    _h.label = 14;
                case 14:
                    if (isActuallyLive)
                        return [3 /*break*/, 16];
                    _h.label = 15;
                case 15:
                    _d++;
                    return [3 /*break*/, 11];
                case 16:
                    if (!!isActuallyLive) return [3 /*break*/, 20];
                    _loop_2 = function (guildId, roleIds) {
                        var guild, guildMember, _loop_3, _m, roleIds_1, roleId;
                        return __generator(this, function (_o) {
                            switch (_o.label) {
                                case 0: return [4 /*yield*/, client.guilds.fetch(guildId).catch(function () { return null; })];
                                case 1:
                                    guild = _o.sent();
                                    if (!guild)
                                        return [2 /*return*/, "continue"];
                                    return [4 /*yield*/, guild.members.fetch(member.id).catch(function () { return null; })];
                                case 2:
                                    guildMember = _o.sent();
                                    if (!guildMember)
                                        return [2 /*return*/, "continue"];
                                    _loop_3 = function (roleId) {
                                        var roleToRemove;
                                        return __generator(this, function (_p) {
                                            switch (_p.label) {
                                                case 0:
                                                    if (!guildMember.roles.cache.has(roleId)) return [3 /*break*/, 3];
                                                    return [4 /*yield*/, guild.roles.fetch(roleId).catch(function () { return null; })];
                                                case 1:
                                                    roleToRemove = _p.sent();
                                                    if (!roleToRemove) return [3 /*break*/, 3];
                                                    logger_1.default.info("Removing stale role '".concat(roleToRemove.name, "' from ").concat(guildMember.user.tag, " in guild ").concat(guild.name, "."), { guildId: guild.id, userId: guildMember.id, category: "streams" });
                                                    return [4 /*yield*/, guildMember.roles.remove(roleToRemove).catch(function (e) { return logger_1.default.error("Failed to remove role ".concat(roleId, " from member ").concat(guildMember.id, " in guild ").concat(guild.id), { error: e }); })];
                                                case 2:
                                                    _p.sent();
                                                    _p.label = 3;
                                                case 3: return [2 /*return*/];
                                            }
                                        });
                                    };
                                    _m = 0, roleIds_1 = roleIds;
                                    _o.label = 3;
                                case 3:
                                    if (!(_m < roleIds_1.length)) return [3 /*break*/, 6];
                                    roleId = roleIds_1[_m];
                                    return [5 /*yield**/, _loop_3(roleId)];
                                case 4:
                                    _o.sent();
                                    _o.label = 5;
                                case 5:
                                    _m++;
                                    return [3 /*break*/, 3];
                                case 6: return [2 /*return*/];
                            }
                        });
                    };
                    _e = 0, _f = guilds.entries();
                    _h.label = 17;
                case 17:
                    if (!(_e < _f.length)) return [3 /*break*/, 20];
                    _g = _f[_e], guildId = _g[0], roleIds = _g[1];
                    return [5 /*yield**/, _loop_2(guildId, roleIds)];
                case 18:
                    _h.sent();
                    _h.label = 19;
                case 19:
                    _e++;
                    return [3 /*break*/, 17];
                case 20: return [3 /*break*/, 22];
                case 21:
                    e_1 = _h.sent();
                    logger_1.default.error("Error processing member ".concat(member.id, " in global cleanup"), { error: e_1, userId: member.id, category: "streams" });
                    return [3 /*break*/, 22];
                case 22:
                    _a++;
                    return [3 /*break*/, 8];
                case 23: return [3 /*break*/, 26];
                case 24:
                    error_5 = _h.sent();
                    logger_1.default.error("Critical _error during aggressive cleanup.", { _error: _error, category: "streams" });
                    return [3 /*break*/, 26];
                case 25:
                    if (connection)
                        connection.release();
                    logger_1.default.info("Aggressive role cleanup finished.", { category: "streams" });
                    return [7 /*endfinally*/];
                case 26: return [2 /*return*/];
            }
        });
    });
}
function purgeOldAnnouncements(client) {
    return __awaiter(this, void 0, void 0, function () {
        var connection, guildCh, teamCh, subCh, allChannelIds, _i, allChannelIds_1, channelId, channel, messages, botMessages, e_2, error_6;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.default.info("Purging all old bot announcements from configured channels...", { category: "streams" });
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 15, 16, 17]);
                    return [4 /*yield*/, db_1.default.getConnection()];
                case 2:
                    connection = _a.sent();
                    return [4 /*yield*/, connection.query('SELECT announcement_channel_id FROM guilds WHERE announcement_channel_id IS NOT NULL')];
                case 3:
                    guildCh = (_a.sent())[0];
                    return [4 /*yield*/, connection.query('SELECT announcement_channel_id FROM twitch_teams WHERE announcement_channel_id IS NOT NULL')];
                case 4:
                    teamCh = (_a.sent())[0];
                    return [4 /*yield*/, connection.query('SELECT announcement_channel_id FROM subscriptions WHERE announcement_channel_id IS NOT NULL')];
                case 5:
                    subCh = (_a.sent())[0];
                    allChannelIds = new Set(__spreadArray(__spreadArray(__spreadArray([], guildCh.map(function (r) { return r.announcement_channel_id; }), true), teamCh.map(function (r) { return r.announcement_channel_id; }), true), subCh.map(function (r) { return r.announcement_channel_id; }), true));
                    _i = 0, allChannelIds_1 = allChannelIds;
                    _a.label = 6;
                case 6:
                    if (!(_i < allChannelIds_1.length)) return [3 /*break*/, 14];
                    channelId = allChannelIds_1[_i];
                    _a.label = 7;
                case 7:
                    _a.trys.push([7, 12, , 13]);
                    return [4 /*yield*/, client.channels.fetch(channelId)];
                case 8:
                    channel = _a.sent();
                    return [4 /*yield*/, channel.messages.fetch({ limit: 100 })];
                case 9:
                    messages = _a.sent();
                    botMessages = messages.filter(function (m) { var _a; return m.author.id === ((_a = client.user) === null || _a === void 0 ? void 0 : _a.id) || m.webhookId; });
                    if (!(botMessages.size > 0)) return [3 /*break*/, 11];
                    return [4 /*yield*/, channel.bulkDelete(botMessages)];
                case 10:
                    _a.sent();
                    logger_1.default.info("Purged ".concat(botMessages.size, " old announcements from #").concat(channel.name, "."), { category: "streams" });
                    _a.label = 11;
                case 11: return [3 /*break*/, 13];
                case 12:
                    e_2 = _a.sent();
                    logger_1.default.warn("Could not purge announcements from channel ".concat(channelId, ". It may no longer exist or permissions are missing."), { error: e_2.message, category: "streams" });
                    return [3 /*break*/, 13];
                case 13:
                    _i++;
                    return [3 /*break*/, 6];
                case 14: return [3 /*break*/, 17];
                case 15:
                    error_6 = _a.sent();
                    logger_1.default.error("Critical _error during announcement purge.", { _error: _error, category: "streams" });
                    return [3 /*break*/, 17];
                case 16:
                    if (connection)
                        connection.release();
                    logger_1.default.info("Announcement purge finished.", { category: "streams" });
                    return [7 /*endfinally*/];
                case 17: return [2 /*return*/];
            }
        });
    });
}
function checkStreamers(client) {
    return __awaiter(this, void 0, void 0, function () {
        var shouldUpdateEmbeds, connection, _a, subscriptions, teams, guildSettings, teamsMap, guildsMap, streamersToCheck, _i, _b, sub, key, roleOperationsByGuild, processedCount, _c, _d, _e, streamerInfo, subscriptions_1, _f, _g, _h, guildId, userRoleMap, _j, _k, _l, discordUserId, roleMap, _loop_4, _m, _o, _p, roleId, _q, shouldHaveRole, member, streamerName, error_7;
        return __generator(this, function (_r) {
            switch (_r.label) {
                case 0: return [4 /*yield*/, loadAnnouncementsFromDatabase()];
                case 1:
                    _r.sent();
                    // Increment and check pass counter for embed updates
                    streamCheckPassCounter++;
                    shouldUpdateEmbeds = streamCheckPassCounter >= EMBED_UPDATE_INTERVAL;
                    if (shouldUpdateEmbeds) {
                        logger_1.default.info("[Stream Manager] Pass #".concat(streamCheckPassCounter, ": Will update embeds for live streamers"), { category: "streams" });
                        streamCheckPassCounter = 0; // Reset counter
                    }
                    else {
                        logger_1.default.info("[Stream Manager] Pass #".concat(streamCheckPassCounter, "/").concat(EMBED_UPDATE_INTERVAL), { category: "streams" });
                    }
                    _r.label = 2;
                case 2:
                    _r.trys.push([2, 17, 18, 19]);
                    return [4 /*yield*/, db_1.default.getConnection()];
                case 3:
                    connection = _r.sent();
                    return [4 /*yield*/, Promise.all([
                            connection.query("SELECT sub.subscription_id, sub.guild_id, sub.announcement_channel_id AS sub_channel_id, sub.live_role_id AS sub_role_id, sub.override_nickname, sub.override_avatar_url, sub.team_subscription_id, sub.delete_on_end, s.streamer_id, s.discord_user_id, s.username, s.platform, s.profile_image_url\n                 FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id"),
                            connection.query('SELECT id, announcement_channel_id AS team_channel_id, live_role_id AS team_role_id, webhook_name AS team_webhook_name, webhook_avatar_url AS team_webhook_avatar FROM twitch_teams'),
                            connection.query('SELECT guild_id, announcement_channel_id AS guild_channel_id, live_role_id AS guild_role_id, bot_nickname AS guild_webhook_name, webhook_avatar_url AS guild_webhook_avatar FROM guilds')
                        ])];
                case 4:
                    _a = _r.sent(), subscriptions = _a[0], teams = _a[1], guildSettings = _a[2];
                    logger_1.default.info("[Stream Manager] Loaded ".concat(subscriptions[0].length, " subscriptions, ").concat(teams[0].length, " teams, ").concat(guildSettings[0].length, " guilds"), { category: "streams" });
                    teamsMap = new Map(teams[0].map(function (t) { return [t.id, t]; }));
                    guildsMap = new Map(guildSettings[0].map(function (g) { return [g.guild_id, g]; }));
                    streamersToCheck = new Map();
                    for (_i = 0, _b = subscriptions[0]; _i < _b.length; _i++) {
                        sub = _b[_i];
                        key = "".concat(sub.platform, "-").concat(sub.username);
                        if (!streamersToCheck.has(key)) {
                            streamersToCheck.set(key, {
                                streamerInfo: {
                                    streamer_id: sub.streamer_id,
                                    discord_user_id: sub.discord_user_id,
                                    username: sub.username,
                                    platform: sub.platform,
                                    profile_image_url: sub.profile_image_url,
                                },
                                subscriptions: []
                            });
                        }
                        streamersToCheck.get(key).subscriptions.push(sub);
                    }
                    logger_1.default.info("[Stream Manager] Checking ".concat(streamersToCheck.size, " unique streamers now..."), { category: "streams" });
                    roleOperationsByGuild = new Map();
                    processedCount = 0;
                    _c = 0, _d = Array.from(streamersToCheck.values());
                    _r.label = 5;
                case 5:
                    if (!(_c < _d.length)) return [3 /*break*/, 8];
                    _e = _d[_c], streamerInfo = _e.streamerInfo, subscriptions_1 = _e.subscriptions;
                    processedCount++;
                    logger_1.default.info("[Stream Manager] Processing streamer ".concat(processedCount, "/").concat(streamersToCheck.size, ": ").concat(streamerInfo.username, " (").concat(streamerInfo.platform, ")"), {
                        category: "streams",
                        progress: "".concat(processedCount, "/").concat(streamersToCheck.size),
                        streamer: streamerInfo.username,
                        platform: streamerInfo.platform
                    });
                    return [4 /*yield*/, processUniqueStreamer(client, streamerInfo, subscriptions_1, guildsMap, teamsMap, roleOperationsByGuild, shouldUpdateEmbeds)];
                case 6:
                    _r.sent();
                    logger_1.default.info("[Stream Manager] Completed processing streamer ".concat(processedCount, "/").concat(streamersToCheck.size, ": ").concat(streamerInfo.username), {
                        category: "streams",
                        progress: "".concat(processedCount, "/").concat(streamersToCheck.size)
                    });
                    _r.label = 7;
                case 7:
                    _c++;
                    return [3 /*break*/, 5];
                case 8:
                    logger_1.default.info("[Stream Manager] Finished checking all ".concat(processedCount, " streamers"), { category: "streams" });
                    _f = 0, _g = roleOperationsByGuild.entries();
                    _r.label = 9;
                case 9:
                    if (!(_f < _g.length)) return [3 /*break*/, 16];
                    _h = _g[_f], guildId = _h[0], userRoleMap = _h[1];
                    _j = 0, _k = userRoleMap.entries();
                    _r.label = 10;
                case 10:
                    if (!(_j < _k.length)) return [3 /*break*/, 15];
                    _l = _k[_j], discordUserId = _l[0], roleMap = _l[1];
                    _loop_4 = function (roleId, shouldHaveRole, member, streamerName) {
                        var guild_1, liveRole_1, hasRole, error_8;
                        return __generator(this, function (_s) {
                            switch (_s.label) {
                                case 0:
                                    _s.trys.push([0, 6, , 7]);
                                    guild_1 = member.guild;
                                    return [4 /*yield*/, guild_1.roles.fetch(roleId).catch(function () { return null; })];
                                case 1:
                                    liveRole_1 = _s.sent();
                                    if (!liveRole_1)
                                        return [2 /*return*/, "continue"];
                                    hasRole = member.roles.cache.has(roleId);
                                    if (!(shouldHaveRole && !hasRole)) return [3 /*break*/, 3];
                                    return [4 /*yield*/, member.roles.add(liveRole_1).catch(function (e) {
                                            return logger_1.default.error("Failed to add role:", { error: e, guildId: guild_1.id, memberId: member.id, roleId: liveRole_1.id, category: "streams" });
                                        })];
                                case 2:
                                    _s.sent();
                                    logger_1.default.info("Added live role '".concat(liveRole_1.name, "' to ").concat(member.user.tag), { guildId: guild_1.id, userId: member.id, streamer: streamerName, category: "streams" });
                                    return [3 /*break*/, 5];
                                case 3:
                                    if (!(!shouldHaveRole && hasRole)) return [3 /*break*/, 5];
                                    return [4 /*yield*/, member.roles.remove(liveRole_1).catch(function (e) {
                                            return logger_1.default.error("Failed to remove role:", { error: e, guildId: guild_1.id, memberId: member.id, roleId: liveRole_1.id, category: "streams" });
                                        })];
                                case 4:
                                    _s.sent();
                                    logger_1.default.info("Removed live role '".concat(liveRole_1.name, "' from ").concat(member.user.tag), { guildId: guild_1.id, userId: member.id, category: "streams" });
                                    _s.label = 5;
                                case 5: return [3 /*break*/, 7];
                                case 6:
                                    error_8 = _s.sent();
                                    logger_1.default.error("Error applying role changes for user ".concat(discordUserId, ":"), { _error: _error, guildId: guildId, category: "streams" });
                                    return [3 /*break*/, 7];
                                case 7: return [2 /*return*/];
                            }
                        });
                    };
                    _m = 0, _o = roleMap.entries();
                    _r.label = 11;
                case 11:
                    if (!(_m < _o.length)) return [3 /*break*/, 14];
                    _p = _o[_m], roleId = _p[0], _q = _p[1], shouldHaveRole = _q.shouldHaveRole, member = _q.member, streamerName = _q.streamerName;
                    return [5 /*yield**/, _loop_4(roleId, shouldHaveRole, member, streamerName)];
                case 12:
                    _r.sent();
                    _r.label = 13;
                case 13:
                    _m++;
                    return [3 /*break*/, 11];
                case 14:
                    _j++;
                    return [3 /*break*/, 10];
                case 15:
                    _f++;
                    return [3 /*break*/, 9];
                case 16: return [3 /*break*/, 19];
                case 17:
                    error_7 = _r.sent();
                    logger_1.default.error("Failed to run stream checker process:", { _error: _error, category: "streams" });
                    return [3 /*break*/, 19];
                case 18:
                    if (connection)
                        connection.release();
                    return [7 /*endfinally*/];
                case 19: return [2 /*return*/];
            }
        });
    });
}
function processUniqueStreamer(client_1, streamer_1, subscriptions_2, guildsMap_1, teamsMap_1, roleOperationsByGuild_1) {
    return __awaiter(this, arguments, void 0, function (client, streamer, subscriptions, guildsMap, teamsMap, roleOperationsByGuild, shouldUpdateEmbeds) {
        var api, isLive, streamData, guildOperations, _i, subscriptions_3, sub, guildDefault, guild, member, guildOp, team, finalRoleId, finalChannelId, webhookConfig, guildOperationsArray, _loop_5, _a, guildOperationsArray_1, _b, guildId, guildOp, error_9;
        var _c, _d;
        if (shouldUpdateEmbeds === void 0) { shouldUpdateEmbeds = false; }
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    logger_1.default.info("[processUniqueStreamer] ENTRY: Processing ".concat(streamer.username, " on ").concat(streamer.platform), {
                        category: "streams",
                        streamer: streamer.username,
                        platform: streamer.platform,
                        subscriptionCount: subscriptions.length
                    });
                    api = platformModules[streamer.platform];
                    if (!api) {
                        logger_1.default.error("[processUniqueStreamer] No API module found for platform: ".concat(streamer.platform), {
                            category: "streams",
                            platform: streamer.platform,
                            availablePlatforms: Object.keys(platformModules)
                        });
                        return [2 /*return*/];
                    }
                    logger_1.default.info("[processUniqueStreamer] API module found, checking if ".concat(streamer.username, " is live..."), {
                        category: "streams",
                        apiType: typeof api,
                        hasIsStreamerLive: typeof api.isStreamerLive,
                        hasGetStreamDetails: typeof api.getStreamDetails
                    });
                    _e.label = 1;
                case 1:
                    _e.trys.push([1, 17, , 18]);
                    logger_1.default.info("[processUniqueStreamer] Calling api.isStreamerLive for ".concat(streamer.username, "..."), { category: "streams" });
                    return [4 /*yield*/, api.isStreamerLive(streamer.username)];
                case 2:
                    isLive = _e.sent();
                    logger_1.default.info("[processUniqueStreamer] isStreamerLive returned: ".concat(isLive, " for ").concat(streamer.username), {
                        category: "streams",
                        isLive: isLive,
                        streamer: streamer.username,
                        platform: streamer.platform
                    });
                    streamData = null;
                    if (!isLive) return [3 /*break*/, 4];
                    logger_1.default.info("[processUniqueStreamer] Streamer ".concat(streamer.username, " is LIVE, fetching details..."), { category: "streams" });
                    return [4 /*yield*/, api.getStreamDetails(streamer.username)];
                case 3:
                    streamData = _e.sent();
                    logger_1.default.info("[processUniqueStreamer] getStreamDetails returned for ".concat(streamer.username, ":"), {
                        category: "streams",
                        hasData: !!streamData,
                        title: streamData === null || streamData === void 0 ? void 0 : streamData.title,
                        viewers: streamData === null || streamData === void 0 ? void 0 : streamData.viewer_count
                    });
                    if (!streamData) {
                        logger_1.default.warn("[Stream Manager] Streamer ".concat(streamer.username, " on ").concat(streamer.platform, " reported live but getStreamDetails returned null. Skipping announcement."), { category: "streams" });
                    }
                    return [3 /*break*/, 5];
                case 4:
                    logger_1.default.info("[processUniqueStreamer] Streamer ".concat(streamer.username, " is NOT live"), { category: "streams" });
                    _e.label = 5;
                case 5:
                    guildOperations = new Map();
                    logger_1.default.info("[processUniqueStreamer] Processing ".concat(subscriptions.length, " subscriptions for ").concat(streamer.username), {
                        category: "streams",
                        subscriptionCount: subscriptions.length
                    });
                    _i = 0, subscriptions_3 = subscriptions;
                    _e.label = 6;
                case 6:
                    if (!(_i < subscriptions_3.length)) return [3 /*break*/, 12];
                    sub = subscriptions_3[_i];
                    guildDefault = guildsMap.get(sub.guild_id);
                    logger_1.default.info("[processUniqueStreamer] Processing subscription for guild ".concat(sub.guild_id), {
                        category: "streams",
                        hasGuildDefault: !!guildDefault,
                        subChannelId: sub.sub_channel_id,
                        guildId: sub.guild_id
                    });
                    if (!guildDefault) {
                        logger_1.default.warn("[processUniqueStreamer] No guild default found for ".concat(sub.guild_id, ", skipping"), {
                            category: "streams"
                        });
                        return [3 /*break*/, 11];
                    }
                    if (!!guildOperations.has(sub.guild_id)) return [3 /*break*/, 10];
                    return [4 /*yield*/, client.guilds.fetch(sub.guild_id).catch(function () { return null; })];
                case 7:
                    guild = _e.sent();
                    if (!guild)
                        return [3 /*break*/, 11];
                    member = null;
                    if (!streamer.discord_user_id) return [3 /*break*/, 9];
                    return [4 /*yield*/, guild.members.fetch(streamer.discord_user_id).catch(function () { return null; })];
                case 8:
                    member = _e.sent();
                    _e.label = 9;
                case 9:
                    guildOperations.set(sub.guild_id, {
                        guild: guild,
                        member: member,
                        guildDefault: guildDefault,
                        roleIds: new Set(),
                        channelAnnouncements: new Map()
                    });
                    _e.label = 10;
                case 10:
                    guildOp = guildOperations.get(sub.guild_id);
                    team = sub.team_subscription_id ? teamsMap.get(sub.team_subscription_id) : null;
                    finalRoleId = sub.sub_role_id || (team === null || team === void 0 ? void 0 : team.team_role_id) || guildDefault.guild_role_id;
                    finalChannelId = sub.sub_channel_id || (team === null || team === void 0 ? void 0 : team.team_channel_id) || guildDefault.guild_channel_id;
                    logger_1.default.info("[processUniqueStreamer] Subscription channel resolution for ".concat(streamer.username), {
                        category: "streams",
                        finalChannelId: finalChannelId,
                        finalRoleId: finalRoleId,
                        subChannelId: sub.sub_channel_id,
                        teamChannelId: team === null || team === void 0 ? void 0 : team.team_channel_id,
                        guildChannelId: guildDefault.guild_channel_id
                    });
                    if (finalRoleId) {
                        guildOp.roleIds.add(finalRoleId);
                    }
                    if (finalChannelId) {
                        if (!guildOp.channelAnnouncements.has(finalChannelId)) {
                            webhookConfig = {
                                username: sub.override_nickname || (team === null || team === void 0 ? void 0 : team.team_webhook_name) || guildDefault.guild_webhook_name || (guildOp.member ? guildOp.member.user.username : streamer.username),
                                avatarURL: sub.override_avatar_url || (guildOp.member ? guildOp.member.user.displayAvatarURL() : null) || streamer.profile_image_url || (team === null || team === void 0 ? void 0 : team.team_webhook_avatar) || guildDefault.guild_webhook_avatar
                            };
                            guildOp.channelAnnouncements.set(finalChannelId, {
                                deleteOnEnd: sub.delete_on_end !== 0,
                                webhookConfig: webhookConfig
                            });
                        }
                    }
                    _e.label = 11;
                case 11:
                    _i++;
                    return [3 /*break*/, 6];
                case 12:
                    logger_1.default.info("[processUniqueStreamer] Starting guild operations for ".concat(streamer.username), {
                        category: "streams",
                        guildCount: guildOperations.size,
                        streamer: streamer.username
                    });
                    guildOperationsArray = Array.from(guildOperations.entries());
                    _loop_5 = function (guildId, guildOp) {
                        var guild, member, roleIds, channelAnnouncements, _f, roleIds_2, roleId, userRoleMap, channelAnnouncementsArray, _loop_6, _g, channelAnnouncementsArray_1, _h, channelId, _j, deleteOnEnd, webhookConfig;
                        return __generator(this, function (_k) {
                            switch (_k.label) {
                                case 0:
                                    guild = guildOp.guild, member = guildOp.member, roleIds = guildOp.roleIds, channelAnnouncements = guildOp.channelAnnouncements;
                                    logger_1.default.info("[processUniqueStreamer] Processing guild ".concat(guildId, " for ").concat(streamer.username), {
                                        category: "streams",
                                        guildId: guildId,
                                        channelAnnouncementCount: channelAnnouncements.size,
                                        roleIdCount: roleIds.size,
                                        hasMember: !!member
                                    });
                                    if (member && roleIds.size > 0 && streamer.discord_user_id) {
                                        for (_f = 0, roleIds_2 = roleIds; _f < roleIds_2.length; _f++) {
                                            roleId = roleIds_2[_f];
                                            if (!roleOperationsByGuild.has(guildId)) {
                                                roleOperationsByGuild.set(guildId, new Map());
                                            }
                                            if (!roleOperationsByGuild.get(guildId).has(streamer.discord_user_id)) {
                                                roleOperationsByGuild.get(guildId).set(streamer.discord_user_id, new Map());
                                            }
                                            userRoleMap = roleOperationsByGuild.get(guildId).get(streamer.discord_user_id);
                                            if (isLive && streamData) {
                                                userRoleMap.set(roleId, {
                                                    shouldHaveRole: true,
                                                    member: member,
                                                    streamerName: streamer.username
                                                });
                                            }
                                            else if (!userRoleMap.has(roleId)) {
                                                userRoleMap.set(roleId, {
                                                    shouldHaveRole: false,
                                                    member: member,
                                                    streamerName: streamer.username
                                                });
                                            }
                                        }
                                    }
                                    channelAnnouncementsArray = Array.from(channelAnnouncements.entries());
                                    _loop_6 = function (channelId, deleteOnEnd, webhookConfig) {
                                        var announcementKey, announcementData, announcementChannel, recentMessages, streamerPattern_1, orphanedMessages, _loop_7, _l, orphanedMessages_1, _m, orphanedMsg, platformColors, platformUrls, platformColor, platformUrl, embed, webhookClient, message, announcementInfo, webhookError_1, announcementChannel, message, platformColors, platformUrls, platformColor, platformUrl, updatedEmbed, updateError_1, shouldDelete, announcementChannel, message;
                                        return __generator(this, function (_o) {
                                            switch (_o.label) {
                                                case 0:
                                                    announcementKey = "".concat(guild.id, "-").concat(streamer.platform, "-").concat(streamer.username, "-").concat(channelId);
                                                    announcementData = liveAnnouncements.get(announcementKey);
                                                    logger_1.default.info("[processUniqueStreamer] Processing channel ".concat(channelId, " for ").concat(streamer.username), {
                                                        category: "streams",
                                                        channelId: channelId,
                                                        isLive: isLive,
                                                        hasStreamData: !!streamData,
                                                        hasAnnouncementData: !!announcementData,
                                                        announcementKey: announcementKey
                                                    });
                                                    if (!(isLive && streamData)) return [3 /*break*/, 24];
                                                    logger_1.default.info("[processUniqueStreamer] Streamer is LIVE with data for ".concat(streamer.username), {
                                                        category: "streams",
                                                        hasAnnouncementData: !!announcementData
                                                    });
                                                    if (!!announcementData) return [3 /*break*/, 16];
                                                    logger_1.default.info("[processUniqueStreamer] Creating NEW announcement for ".concat(streamer.username), {
                                                        category: "streams",
                                                        channelId: channelId,
                                                        guildId: guild.id
                                                    });
                                                    _o.label = 1;
                                                case 1:
                                                    _o.trys.push([1, 14, , 15]);
                                                    return [4 /*yield*/, guild.channels.fetch(channelId).catch(function () { return null; })];
                                                case 2:
                                                    announcementChannel = _o.sent();
                                                    if (!announcementChannel) return [3 /*break*/, 7];
                                                    return [4 /*yield*/, announcementChannel.messages.fetch({ limit: 50 }).catch(function () { return null; })];
                                                case 3:
                                                    recentMessages = _o.sent();
                                                    if (!recentMessages) return [3 /*break*/, 7];
                                                    streamerPattern_1 = new RegExp("".concat(streamer.username, ".*is now live on ").concat(streamer.platform), 'i');
                                                    orphanedMessages = recentMessages.filter(function (msg) {
                                                        var _a, _b;
                                                        return msg.author.bot &&
                                                            msg.embeds.length > 0 &&
                                                            ((_b = (_a = msg.embeds[0].author) === null || _a === void 0 ? void 0 : _a.name) === null || _b === void 0 ? void 0 : _b.match(streamerPattern_1));
                                                    });
                                                    if (!(orphanedMessages.size > 0)) return [3 /*break*/, 7];
                                                    logger_1.default.warn("[processUniqueStreamer] Found ".concat(orphanedMessages.size, " orphaned announcement(s) for ").concat(streamer.username, ", cleaning up..."), {
                                                        category: "streams",
                                                        orphanCount: orphanedMessages.size
                                                    });
                                                    _loop_7 = function (orphanedMsg) {
                                                        return __generator(this, function (_p) {
                                                            switch (_p.label) {
                                                                case 0: return [4 /*yield*/, orphanedMsg.delete().catch(function (err) {
                                                                        return logger_1.default.error("Failed to delete orphaned announcement:", {
                                                                            error: err.message,
                                                                            messageId: orphanedMsg.id,
                                                                            category: "streams"
                                                                        });
                                                                    })];
                                                                case 1:
                                                                    _p.sent();
                                                                    return [2 /*return*/];
                                                            }
                                                        });
                                                    };
                                                    _l = 0, orphanedMessages_1 = orphanedMessages;
                                                    _o.label = 4;
                                                case 4:
                                                    if (!(_l < orphanedMessages_1.length)) return [3 /*break*/, 7];
                                                    _m = orphanedMessages_1[_l], orphanedMsg = _m[1];
                                                    return [5 /*yield**/, _loop_7(orphanedMsg)];
                                                case 5:
                                                    _o.sent();
                                                    _o.label = 6;
                                                case 6:
                                                    _l++;
                                                    return [3 /*break*/, 4];
                                                case 7:
                                                    platformColors = {
                                                        twitch: 0x6441A5, // Twitch purple
                                                        kick: 0x00FF00, // Kick green
                                                        youtube: 0xFF0000, // YouTube red
                                                        tiktok: 0x000000, // TikTok black
                                                        trovo: 0x1DBF73, // Trovo green
                                  