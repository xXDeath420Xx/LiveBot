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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.blacklistUser = blacklistUser;
exports.unblacklistUser = unblacklistUser;
exports.isBlacklisted = isBlacklisted;
exports.purgeStreamerData = purgeStreamerData;
var db_1 = __importDefault(require("../utils/db"));
var logger_1 = __importDefault(require("../utils/logger"));
var role_manager_1 = require("./role-manager");
/**
 * Checks if a user is blacklisted based on their platform ID.
 * @param platform The platform (e.g., 'twitch', 'kick').
 * @param platformUserId The user's ID on the platform.
 * @returns True if the user is blacklisted, false otherwise.
 */
function isBlacklisted(platform, platformUserId) {
    return __awaiter(this, void 0, void 0, function () {
        var rows;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, db_1.default.execute("SELECT 1 FROM blacklisted_users WHERE platform = ? AND platform_user_id = ?", [platform, platformUserId])];
                case 1:
                    rows = (_a.sent())[0];
                    return [2 /*return*/, rows.length > 0];
            }
        });
    });
}
/**
 * Purges all data associated with a given streamer ID.
 * @param streamerId The internal streamer ID to purge.
 * @param client The Discord client instance for API actions.
 */
function purgeStreamerData(streamerId, client) {
    return __awaiter(this, void 0, void 0, function () {
        var streamerInfoRows, streamerInfo, subscriptions, announcements, _loop_1, _i, announcements_1, ann, guildIds, _a, guildIds_1, guildId, guild, member, liveRolesRows, liveRoles, teamRolesRows, teamRoles, roleIdsToRemove, _b, roleIdsToRemove_1, roleId, e_1;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    logger_1.default.warn("[Blacklist] Starting data purge for streamer ID: ".concat(streamerId));
                    return [4 /*yield*/, db_1.default.execute("SELECT * FROM streamers WHERE streamer_id = ?", [streamerId])];
                case 1:
                    streamerInfoRows = (_c.sent())[0];
                    streamerInfo = streamerInfoRows[0];
                    if (!streamerInfo) {
                        logger_1.default.warn("[Blacklist] No streamer found with ID ".concat(streamerId, " for purging. It might have been deleted already."));
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, db_1.default.execute("SELECT * FROM subscriptions WHERE streamer_id = ?", [streamerId])];
                case 2:
                    subscriptions = (_c.sent())[0];
                    return [4 /*yield*/, db_1.default.execute("SELECT * FROM announcements WHERE streamer_id = ?", [streamerId])];
                case 3:
                    announcements = (_c.sent())[0];
                    _loop_1 = function (ann) {
                        var channel, e_2;
                        return __generator(this, function (_d) {
                            switch (_d.label) {
                                case 0:
                                    _d.trys.push([0, 4, , 5]);
                                    return [4 /*yield*/, client.channels.fetch(ann.channel_id).catch(function () { return null; })];
                                case 1:
                                    channel = _d.sent();
                                    if (!(channel === null || channel === void 0 ? void 0 : channel.isTextBased())) return [3 /*break*/, 3];
                                    return [4 /*yield*/, channel.messages.delete(ann.message_id).catch(function (err) {
                                            if (err.code !== 10008)
                                                logger_1.default.warn("[Blacklist] Could not delete message ".concat(ann.message_id, ": ").concat(err.message));
                                        })];
                                case 2:
                                    _d.sent();
                                    _d.label = 3;
                                case 3: return [3 /*break*/, 5];
                                case 4:
                                    e_2 = _d.sent();
                                    logger_1.default.error("[Blacklist] Error fetching channel or deleting message for announcement ".concat(ann.announcement_id, ":"), e_2);
                                    return [3 /*break*/, 5];
                                case 5: return [2 /*return*/];
                            }
                        });
                    };
                    _i = 0, announcements_1 = announcements;
                    _c.label = 4;
                case 4:
                    if (!(_i < announcements_1.length)) return [3 /*break*/, 7];
                    ann = announcements_1[_i];
                    return [5 /*yield**/, _loop_1(ann)];
                case 5:
                    _c.sent();
                    _c.label = 6;
                case 6:
                    _i++;
                    return [3 /*break*/, 4];
                case 7:
                    if (!streamerInfo.discord_user_id) return [3 /*break*/, 20];
                    guildIds = __spreadArray([], new Set(subscriptions.map(function (s) { return s.guild_id; })), true);
                    _a = 0, guildIds_1 = guildIds;
                    _c.label = 8;
                case 8:
                    if (!(_a < guildIds_1.length)) return [3 /*break*/, 20];
                    guildId = guildIds_1[_a];
                    _c.label = 9;
                case 9:
                    _c.trys.push([9, 18, , 19]);
                    return [4 /*yield*/, client.guilds.fetch(guildId)];
                case 10:
                    guild = _c.sent();
                    return [4 /*yield*/, guild.members.fetch(streamerInfo.discord_user_id).catch(function () { return null; })];
                case 11:
                    member = _c.sent();
                    if (!member) return [3 /*break*/, 17];
                    return [4 /*yield*/, db_1.default.execute("SELECT live_role_id FROM guilds WHERE guild_id = ? AND live_role_id IS NOT NULL", [guildId])];
                case 12:
                    liveRolesRows = (_c.sent())[0];
                    liveRoles = liveRolesRows.map(function (r) { return r.live_role_id; });
                    return [4 /*yield*/, db_1.default.execute("SELECT live_role_id FROM twitch_teams WHERE guild_id = ? AND live_role_id IS NOT NULL", [guildId])];
                case 13:
                    teamRolesRows = (_c.sent())[0];
                    teamRoles = teamRolesRows.map(function (r) { return r.live_role_id; });
                    roleIdsToRemove = __spreadArray([], new Set(__spreadArray(__spreadArray([], liveRoles, true), teamRoles, true).filter(Boolean)), true);
                    _b = 0, roleIdsToRemove_1 = roleIdsToRemove;
                    _c.label = 14;
                case 14:
                    if (!(_b < roleIdsToRemove_1.length)) return [3 /*break*/, 17];
                    roleId = roleIdsToRemove_1[_b];
                    if (!member.roles.cache.has(roleId)) return [3 /*break*/, 16];
                    return [4 /*yield*/, (0, role_manager_1.handleRole)(member, [roleId], "remove", guildId, "User blacklisted")];
                case 15:
                    _c.sent();
                    _c.label = 16;
                case 16:
                    _b++;
                    return [3 /*break*/, 14];
                case 17: return [3 /*break*/, 19];
                case 18:
                    e_1 = _c.sent();
                    logger_1.default.error("[Blacklist] Error removing roles from user ".concat(streamerInfo.discord_user_id, " in guild ").concat(guildId, ":"), e_1);
                    return [3 /*break*/, 19];
                case 19:
                    _a++;
                    return [3 /*break*/, 8];
                case 20:
                    logger_1.default.info("[Blacklist] Deleting database records for streamer ID: ".concat(streamerId));
                    return [4 /*yield*/, db_1.default.execute("DELETE FROM announcements WHERE streamer_id = ?", [streamerId])];
                case 21:
                    _c.sent();
                    return [4 /*yield*/, db_1.default.execute("DELETE FROM subscriptions WHERE streamer_id = ?", [streamerId])];
                case 22:
                    _c.sent();
                    return [4 /*yield*/, db_1.default.execute("DELETE FROM stream_sessions WHERE streamer_id = ?", [streamerId])];
                case 23:
                    _c.sent();
                    return [4 /*yield*/, db_1.default.execute("DELETE FROM streamers WHERE streamer_id = ?", [streamerId])];
                case 24:
                    _c.sent();
                    logger_1.default.warn("[Blacklist] Purge complete for streamer ID: ".concat(streamerId));
                    return [2 /*return*/];
            }
        });
    });
}
/**
 * Adds a user and all their associated accounts to the blacklist and initiates a purge of their data.
 * @param identifier The username or Discord ID of the user to blacklist.
 * @param blacklistedBy The Discord client instance.
 * @param client The Discord client instance.
 * @returns Object with blacklistedCount
 */
function blacklistUser(identifier, blacklistedBy, client) {
    return __awaiter(this, void 0, void 0, function () {
        var accountsToBlacklist, isDiscordId, streamers, streamers, discordIds, placeholders, linkedStreamers, uniqueAccounts, _i, uniqueAccounts_1, account;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    accountsToBlacklist = [];
                    isDiscordId = /^\d{17,19}$/.test(identifier);
                    if (!isDiscordId) return [3 /*break*/, 2];
                    return [4 /*yield*/, db_1.default.execute("SELECT * FROM streamers WHERE discord_user_id = ?", [identifier])];
                case 1:
                    streamers = (_a.sent())[0];
                    accountsToBlacklist.push.apply(accountsToBlacklist, streamers);
                    return [3 /*break*/, 6];
                case 2: return [4 /*yield*/, db_1.default.execute("SELECT * FROM streamers WHERE username = ?", [identifier])];
                case 3:
                    streamers = (_a.sent())[0];
                    if (!(streamers.length > 0)) return [3 /*break*/, 6];
                    discordIds = __spreadArray([], new Set(streamers.map(function (s) { return s.discord_user_id; }).filter(Boolean)), true);
                    if (!(discordIds.length > 0)) return [3 /*break*/, 5];
                    placeholders = discordIds.map(function () { return '?'; }).join(',');
                    return [4 /*yield*/, db_1.default.execute("SELECT * FROM streamers WHERE discord_user_id IN (".concat(placeholders, ")"), discordIds)];
                case 4:
                    linkedStreamers = (_a.sent())[0];
                    accountsToBlacklist.push.apply(accountsToBlacklist, linkedStreamers);
                    return [3 /*break*/, 6];
                case 5:
                    accountsToBlacklist.push.apply(accountsToBlacklist, streamers);
                    _a.label = 6;
                case 6:
                    uniqueAccounts = __spreadArray([], new Map(accountsToBlacklist.map(function (item) { return [item.streamer_id, item]; })).values(), true);
                    if (uniqueAccounts.length === 0) {
                        throw new Error("No streamer accounts found for identifier \"".concat(identifier, "\"."));
                    }
                    _i = 0, uniqueAccounts_1 = uniqueAccounts;
                    _a.label = 7;
                case 7:
                    if (!(_i < uniqueAccounts_1.length)) return [3 /*break*/, 11];
                    account = uniqueAccounts_1[_i];
                    return [4 /*yield*/, db_1.default.execute("INSERT INTO blacklisted_users (platform, platform_user_id, username, discord_user_id, blacklisted_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), blacklisted_at = NOW()", [account.platform, account.platform_user_id, account.username, account.discord_user_id, blacklistedBy])];
                case 8:
                    _a.sent();
                    return [4 /*yield*/, purgeStreamerData(account.streamer_id, client)];
                case 9:
                    _a.sent();
                    _a.label = 10;
                case 10:
                    _i++;
                    return [3 /*break*/, 7];
                case 11:
                    logger_1.default.info("[Blacklist] Blacklisted and purged ".concat(uniqueAccounts.length, " account(s) for identifier \"").concat(identifier, "\"."));
                    return [2 /*return*/, { blacklistedCount: uniqueAccounts.length }];
            }
        });
    });
}
/**
 * Removes a user from the blacklist by their blacklist ID.
 * @param id The ID of the entry in the blacklisted_users table.
 * @returns True if successful, false otherwise
 */
function unblacklistUser(id) {
    return __awaiter(this, void 0, void 0, function () {
        var result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, db_1.default.execute("DELETE FROM blacklisted_users WHERE id = ?", [id])];
                case 1:
                    result = (_a.sent())[0];
                    if (result.affectedRows > 0) {
                        logger_1.default.info("[Blacklist] User with blacklist ID ".concat(id, " has been removed from the blacklist."));
                        return [2 /*return*/, true];
                    }
                    return [2 /*return*/, false];
            }
        });
    });
}
