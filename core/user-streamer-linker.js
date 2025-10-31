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
exports.UserStreamerLinker = void 0;
var db_1 = require("../utils/db");
var logger_1 = require("../utils/logger");
var UserStreamerLinker = /** @class */ (function () {
    function UserStreamerLinker(client) {
        this.client = client;
    }
    /**
     * Run a full audit across all guilds to find and link Discord users to streamers
     */
    UserStreamerLinker.prototype.runFullAudit = function () {
        return __awaiter(this, void 0, void 0, function () {
            var results, streamers, guilds, _i, guilds_1, _a, guildId, guild, guildStreamers, members, _b, members_1, _c, userId, member, username, displayName, _d, guildStreamers_1, streamer, streamerName, match, match, error_1, _e, _f, match, linked, error_2;
            return __generator(this, function (_g) {
                switch (_g.label) {
                    case 0:
                        logger_1.default.info('[UserStreamerLinker] Starting full audit across all guilds');
                        results = {
                            totalGuilds: 0,
                            totalMembers: 0,
                            totalStreamers: 0,
                            exactMatches: [],
                            fuzzyMatches: [],
                            newLinks: 0,
                            existingLinks: 0,
                            errors: []
                        };
                        _g.label = 1;
                    case 1:
                        _g.trys.push([1, 14, , 15]);
                        return [4 /*yield*/, db_1.default.query('SELECT streamer_id as id, platform, username, platform_user_id FROM streamers')];
                    case 2:
                        streamers = (_g.sent())[0];
                        results.totalStreamers = streamers.length;
                        logger_1.default.info("[UserStreamerLinker] Found ".concat(streamers.length, " streamers to match"));
                        guilds = this.client.guilds.cache;
                        results.totalGuilds = guilds.size;
                        logger_1.default.info("[UserStreamerLinker] Scanning ".concat(guilds.size, " guilds"));
                        _i = 0, guilds_1 = guilds;
                        _g.label = 3;
                    case 3:
                        if (!(_i < guilds_1.length)) return [3 /*break*/, 9];
                        _a = guilds_1[_i], guildId = _a[0], guild = _a[1];
                        _g.label = 4;
                    case 4:
                        _g.trys.push([4, 7, , 8]);
                        return [4 /*yield*/, db_1.default.query("SELECT DISTINCT s.streamer_id as id, s.platform, s.username, s.platform_user_id\n                         FROM streamers s\n                         JOIN subscriptions sub ON s.streamer_id = sub.streamer_id\n                         WHERE sub.guild_id = ?", [guildId])];
                    case 5:
                        guildStreamers = (_g.sent())[0];
                        if (guildStreamers.length === 0)
                            return [3 /*break*/, 8];
                        logger_1.default.info("[UserStreamerLinker] Guild ".concat(guild.name, " has ").concat(guildStreamers.length, " streamers"));
                        // Fetch all members for this guild
                        return [4 /*yield*/, guild.members.fetch()];
                    case 6:
                        // Fetch all members for this guild
                        _g.sent();
                        members = guild.members.cache;
                        results.totalMembers += members.size;
                        logger_1.default.info("[UserStreamerLinker] Scanning ".concat(members.size, " members in ").concat(guild.name));
                        // Check each member against streamers
                        for (_b = 0, members_1 = members; _b < members_1.length; _b++) {
                            _c = members_1[_b], userId = _c[0], member = _c[1];
                            if (member.user.bot)
                                continue;
                            username = member.user.username.toLowerCase();
                            displayName = member.displayName.toLowerCase();
                            // Check against each streamer
                            for (_d = 0, guildStreamers_1 = guildStreamers; _d < guildStreamers_1.length; _d++) {
                                streamer = guildStreamers_1[_d];
                                streamerName = streamer.username.toLowerCase();
                                // Check for exact match
                                if (username === streamerName || displayName === streamerName) {
                                    match = {
                                        streamerId: streamer.id,
                                        streamerUsername: streamer.username,
                                        platform: streamer.platform,
                                        discordUserId: userId,
                                        discordUsername: member.user.username,
                                        guildId: guildId,
                                        guildName: guild.name,
                                        confidence: 'exact'
                                    };
                                    results.exactMatches.push(match);
                                    logger_1.default.info("[UserStreamerLinker] EXACT MATCH: ".concat(member.user.username, " \u2192 ").concat(streamer.username, " (").concat(streamer.platform, ")"));
                                }
                                // Check for fuzzy match (contains username)
                                else if (username.includes(streamerName) ||
                                    displayName.includes(streamerName) ||
                                    streamerName.includes(username)) {
                                    match = {
                                        streamerId: streamer.id,
                                        streamerUsername: streamer.username,
                                        platform: streamer.platform,
                                        discordUserId: userId,
                                        discordUsername: member.user.username,
                                        guildId: guildId,
                                        guildName: guild.name,
                                        confidence: 'medium'
                                    };
                                    results.fuzzyMatches.push(match);
                                    logger_1.default.info("[UserStreamerLinker] FUZZY MATCH: ".concat(member.user.username, " \u2248 ").concat(streamer.username, " (").concat(streamer.platform, ")"));
                                }
                            }
                        }
                        return [3 /*break*/, 8];
                    case 7:
                        error_1 = _g.sent();
                        logger_1.default.error("[UserStreamerLinker] Error scanning guild ".concat(guild.name, ": ").concat(error_1.message));
                        results.errors.push("Guild ".concat(guild.name, ": ").concat(error_1.message));
                        return [3 /*break*/, 8];
                    case 8:
                        _i++;
                        return [3 /*break*/, 3];
                    case 9:
                        _e = 0, _f = results.exactMatches;
                        _g.label = 10;
                    case 10:
                        if (!(_e < _f.length)) return [3 /*break*/, 13];
                        match = _f[_e];
                        return [4 /*yield*/, this.linkUserToStreamer(match.discordUserId, match.streamerId, match.guildId, true // auto-verified for exact matches
                            )];
                    case 11:
                        linked = _g.sent();
                        if (linked.isNew) {
                            results.newLinks++;
                        }
                        else {
                            results.existingLinks++;
                        }
                        _g.label = 12;
                    case 12:
                        _e++;
                        return [3 /*break*/, 10];
                    case 13:
                        logger_1.default.info("[UserStreamerLinker] Audit complete: ".concat(results.exactMatches.length, " exact matches, ").concat(results.fuzzyMatches.length, " fuzzy matches"));
                        return [3 /*break*/, 15];
                    case 14:
                        error_2 = _g.sent();
                        logger_1.default.error("[UserStreamerLinker] Fatal error during audit: ".concat(error_2.message));
                        results.errors.push("Fatal: ".concat(error_2.message));
                        return [3 /*break*/, 15];
                    case 15: return [2 /*return*/, results];
                }
            });
        });
    };
    /**
     * Search for a specific streamer username across all guilds
     */
    UserStreamerLinker.prototype.searchForStreamer = function (streamerUsername, platform) {
        return __awaiter(this, void 0, void 0, function () {
            var matches, query, params, streamers, _i, streamers_1, streamer, guilds, _a, guilds_2, guild_id, guild, members, _b, members_2, _c, userId, member, username, displayName, streamerName, error_3;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        matches = [];
                        _d.label = 1;
                    case 1:
                        _d.trys.push([1, 10, , 11]);
                        query = 'SELECT streamer_id as id, platform, username FROM streamers WHERE LOWER(username) = ?';
                        params = [streamerUsername.toLowerCase()];
                        if (platform) {
                            query += ' AND platform = ?';
                            params.push(platform);
                        }
                        return [4 /*yield*/, db_1.default.query(query, params)];
                    case 2:
                        streamers = (_d.sent())[0];
                        if (streamers.length === 0) {
                            logger_1.default.warn("[UserStreamerLinker] No streamer found with username: ".concat(streamerUsername));
                            return [2 /*return*/, matches];
                        }
                        _i = 0, streamers_1 = streamers;
                        _d.label = 3;
                    case 3:
                        if (!(_i < streamers_1.length)) return [3 /*break*/, 9];
                        streamer = streamers_1[_i];
                        return [4 /*yield*/, db_1.default.query('SELECT DISTINCT guild_id FROM subscriptions WHERE streamer_id = ?', [streamer.id])];
                    case 4:
                        guilds = (_d.sent())[0];
                        _a = 0, guilds_2 = guilds;
                        _d.label = 5;
                    case 5:
                        if (!(_a < guilds_2.length)) return [3 /*break*/, 8];
                        guild_id = guilds_2[_a].guild_id;
                        guild = this.client.guilds.cache.get(guild_id);
                        if (!guild)
                            return [3 /*break*/, 7];
                        return [4 /*yield*/, guild.members.fetch()];
                    case 6:
                        _d.sent();
                        members = guild.members.cache;
                        for (_b = 0, members_2 = members; _b < members_2.length; _b++) {
                            _c = members_2[_b], userId = _c[0], member = _c[1];
                            if (member.user.bot)
                                continue;
                            username = member.user.username.toLowerCase();
                            displayName = member.displayName.toLowerCase();
                            streamerName = streamer.username.toLowerCase();
                            if (username === streamerName || displayName === streamerName) {
                                matches.push({
                                    streamerId: streamer.id,
                                    streamerUsername: streamer.username,
                                    platform: streamer.platform,
                                    discordUserId: userId,
                                    discordUsername: member.user.username,
                                    guildId: guild_id,
                                    guildName: guild.name,
                                    confidence: 'exact'
                                });
                            }
                        }
                        _d.label = 7;
                    case 7:
                        _a++;
                        return [3 /*break*/, 5];
                    case 8:
                        _i++;
                        return [3 /*break*/, 3];
                    case 9: return [3 /*break*/, 11];
                    case 10:
                        error_3 = _d.sent();
                        logger_1.default.error("[UserStreamerLinker] Error searching for streamer: ".concat(error_3.message));
                        return [3 /*break*/, 11];
                    case 11: return [2 /*return*/, matches];
                }
            });
        });
    };
    /**
     * Link a Discord user to a streamer profile
     */
    UserStreamerLinker.prototype.linkUserToStreamer = function (discordUserId_1, streamerId_1, guildId_1) {
        return __awaiter(this, arguments, void 0, function (discordUserId, streamerId, guildId, verified) {
            var existing, error_4;
            if (verified === void 0) { verified = false; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 3, , 4]);
                        return [4 /*yield*/, db_1.default.query('SELECT id FROM streamer_discord_links WHERE discord_user_id = ? AND streamer_id = ?', [discordUserId, streamerId])];
                    case 1:
                        existing = (_a.sent())[0];
                        if (existing.length > 0) {
                            logger_1.default.info("[UserStreamerLinker] Link already exists: User ".concat(discordUserId, " \u2192 Streamer ").concat(streamerId));
                            return [2 /*return*/, { success: true, isNew: false }];
                        }
                        // Create new link
                        return [4 /*yield*/, db_1.default.query("INSERT INTO streamer_discord_links\n                (discord_user_id, streamer_id, guild_id, verified, linked_at)\n                VALUES (?, ?, ?, ?, NOW())", [discordUserId, streamerId, guildId, verified ? 1 : 0])];
                    case 2:
                        // Create new link
                        _a.sent();
                        logger_1.default.info("[UserStreamerLinker] NEW LINK: User ".concat(discordUserId, " \u2192 Streamer ").concat(streamerId, " (verified: ").concat(verified, ")"));
                        return [2 /*return*/, { success: true, isNew: true }];
                    case 3:
                        error_4 = _a.sent();
                        logger_1.default.error("[UserStreamerLinker] Error linking user to streamer: ".concat(error_4.message));
                        return [2 /*return*/, { success: false, isNew: false }];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Get all Discord users linked to a streamer
     */
    UserStreamerLinker.prototype.getLinkedUsers = function (streamerId) {
        return __awaiter(this, void 0, void 0, function () {
            var links, error_5;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, db_1.default.query("SELECT sdl.*, s.username as streamer_username, s.platform\n                 FROM streamer_discord_links sdl\n                 JOIN streamers s ON sdl.streamer_id = s.id\n                 WHERE sdl.streamer_id = ?", [streamerId])];
                    case 1:
                        links = (_a.sent())[0];
                        return [2 /*return*/, links];
                    case 2:
                        error_5 = _a.sent();
                        logger_1.default.error("[UserStreamerLinker] Error getting linked users: ".concat(error_5.message));
                        return [2 /*return*/, []];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Get all streamers linked to a Discord user
     */
    UserStreamerLinker.prototype.getLinkedStreamers = function (discordUserId) {
        return __awaiter(this, void 0, void 0, function () {
            var links, error_6;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, db_1.default.query("SELECT sdl.*, s.username as streamer_username, s.platform\n                 FROM streamer_discord_links sdl\n                 JOIN streamers s ON sdl.streamer_id = s.id\n                 WHERE sdl.discord_user_id = ?", [discordUserId])];
                    case 1:
                        links = (_a.sent())[0];
                        return [2 /*return*/, links];
                    case 2:
                        error_6 = _a.sent();
                        logger_1.default.error("[UserStreamerLinker] Error getting linked streamers: ".concat(error_6.message));
                        return [2 /*return*/, []];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Unlink a Discord user from a streamer
     */
    UserStreamerLinker.prototype.unlinkUserFromStreamer = function (discordUserId, streamerId) {
        return __awaiter(this, void 0, void 0, function () {
            var error_7;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, db_1.default.query('DELETE FROM streamer_discord_links WHERE discord_user_id = ? AND streamer_id = ?', [discordUserId, streamerId])];
                    case 1:
                        _a.sent();
                        logger_1.default.info("[UserStreamerLinker] UNLINKED: User ".concat(discordUserId, " from Streamer ").concat(streamerId));
                        return [2 /*return*/, true];
                    case 2:
                        error_7 = _a.sent();
                        logger_1.default.error("[UserStreamerLinker] Error unlinking: ".concat(error_7.message));
                        return [2 /*return*/, false];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Verify a pending link
     */
    UserStreamerLinker.prototype.verifyLink = function (discordUserId, streamerId) {
        return __awaiter(this, void 0, void 0, function () {
            var error_8;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, db_1.default.query('UPDATE streamer_discord_links SET verified = 1 WHERE discord_user_id = ? AND streamer_id = ?', [discordUserId, streamerId])];
                    case 1:
                        _a.sent();
                        logger_1.default.info("[UserStreamerLinker] VERIFIED: User ".concat(discordUserId, " \u2192 Streamer ").concat(streamerId));
                        return [2 /*return*/, true];
                    case 2:
                        error_8 = _a.sent();
                        logger_1.default.error("[UserStreamerLinker] Error verifying link: ".concat(error_8.message));
                        return [2 /*return*/, false];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    return UserStreamerLinker;
}());
exports.UserStreamerLinker = UserStreamerLinker;
exports.default = UserStreamerLinker;
