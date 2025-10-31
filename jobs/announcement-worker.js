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
// BigInt JSON serialization
BigInt.prototype.toJSON = function () { return this.toString(); };
var bullmq_1 = require("bullmq");
var logger_1 = __importDefault(require("../utils/logger"));
var db_1 = __importDefault(require("../utils/db"));
var cache_1 = require("../utils/cache");
var announcer_1 = require("../utils/announcer");
var role_manager_1 = require("../core/role-manager");
var getWebhookClient = announcer_1.getAndUpdateWebhook;
module.exports = function startAnnouncementWorker(client) {
    var _this = this;
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.
    logger_1.default.info('[Announcement Worker] Initializing BullMQ Worker.');
    function cleanupOldAnnouncements(discordClient_1, subscriptionId_1, guildId_1, platform_1, username_1) {
        return __awaiter(this, arguments, void 0, function (discordClient, subscriptionId, guildId, platform, username, messageIdToKeep) {
            var oldAnnouncements, _loop_1, _i, _a, oldAnn, error_1;
            if (messageIdToKeep === void 0) { messageIdToKeep = null; }
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 6, , 7]);
                        return [4 /*yield*/, db_1.default.execute("SELECT announcement_id, message_id, channel_id FROM announcements WHERE subscription_id = ?", [subscriptionId])];
                    case 1:
                        oldAnnouncements = (_b.sent())[0];
                        _loop_1 = function (oldAnn) {
                            var webhookClient;
                            return __generator(this, function (_c) {
                                switch (_c.label) {
                                    case 0:
                                        if (!(oldAnn.message_id && oldAnn.message_id !== messageIdToKeep)) return [3 /*break*/, 3];
                                        return [4 /*yield*/, getWebhookClient(discordClient, oldAnn.channel_id, '', '')];
                                    case 1:
                                        webhookClient = _c.sent();
                                        if (!webhookClient) return [3 /*break*/, 3];
                                        return [4 /*yield*/, webhookClient.deleteMessage(oldAnn.message_id).catch(function (e) {
                                                if (e.code !== 10008)
                                                    logger_1.default.warn("[Worker] Failed to delete old message ".concat(oldAnn.message_id, "."), { error: e });
                                            })];
                                    case 2:
                                        _c.sent();
                                        _c.label = 3;
                                    case 3:
                                        if (!(oldAnn.message_id !== messageIdToKeep)) return [3 /*break*/, 6];
                                        return [4 /*yield*/, db_1.default.execute('DELETE FROM announcements WHERE announcement_id = ?', [oldAnn.announcement_id])];
                                    case 4:
                                        _c.sent();
                                        // Also delete from live_announcements table
                                        return [4 /*yield*/, db_1.default.execute('DELETE FROM live_announcements WHERE guild_id = ? AND platform = ? AND username = ? AND channel_id = ?', [guildId, platform, username, oldAnn.channel_id]).catch(function (error) {
                                                if (error.code !== 'ER_NO_SUCH_TABLE') {
                                                    logger_1.default.warn("[Worker] Failed to delete from live_announcements:", { error: error.message });
                                                }
                                            })];
                                    case 5:
                                        // Also delete from live_announcements table
                                        _c.sent();
                                        _c.label = 6;
                                    case 6: return [2 /*return*/];
                                }
                            });
                        };
                        _i = 0, _a = oldAnnouncements;
                        _b.label = 2;
                    case 2:
                        if (!(_i < _a.length)) return [3 /*break*/, 5];
                        oldAnn = _a[_i];
                        return [5 /*yield**/, _loop_1(oldAnn)];
                    case 3:
                        _b.sent();
                        _b.label = 4;
                    case 4:
                        _i++;
                        return [3 /*break*/, 2];
                    case 5: return [3 /*break*/, 7];
                    case 6:
                        error_1 = _b.sent();
                        logger_1.default.error("[Worker] Error during cleanupOldAnnouncements for subscription ".concat(subscriptionId, ":"), { error: error_1 });
                        return [3 /*break*/, 7];
                    case 7: return [2 /*return*/];
                }
            });
        });
    }
    var announcementWorker = new bullmq_1.Worker('announcements', function (job) { return __awaiter(_this, void 0, void 0, function () {
        var _a, sub, liveData, guildSettings, teamSettings, _b, targetChannelId, channelSettings, existingAnnouncements, existingAnnouncementFromDb, sentMessage, query, params, rolesToApply, guild, member, error_2;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!client.isReady()) {
                        logger_1.default.warn("[Worker] Discord client not ready. Retrying job ".concat(job.id, "..."));
                        throw new Error('Discord client not ready');
                    }
                    _a = job.data, sub = _a.sub, liveData = _a.liveData;
                    logger_1.default.info("[Worker] Processing job ".concat(job.id, " for ").concat(sub.username, "."), { guildId: sub.guild_id });
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 16, , 17]);
                    return [4 /*yield*/, db_1.default.execute('SELECT * FROM guilds WHERE guild_id = ?', [sub.guild_id])];
                case 2:
                    guildSettings = (_c.sent())[0][0];
                    if (!sub.team_subscription_id) return [3 /*break*/, 4];
                    return [4 /*yield*/, db_1.default.execute('SELECT * FROM twitch_teams WHERE id = ?', [sub.team_subscription_id])];
                case 3:
                    _b = _c.sent();
                    return [3 /*break*/, 5];
                case 4:
                    _b = [[null]];
                    _c.label = 5;
                case 5:
                    teamSettings = (_b)[0][0];
                    targetChannelId = sub.announcement_channel_id;
                    if (sub.team_subscription_id && teamSettings) {
                        targetChannelId = teamSettings.announcement_channel_id;
                    }
                    if (!targetChannelId) {
                        logger_1.default.warn("[Worker] No announcement channel found for subscription ".concat(sub.subscription_id, ". Skipping."), { guildId: sub.guild_id });
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, db_1.default.execute('SELECT * FROM channel_settings WHERE channel_id = ?', [targetChannelId])];
                case 6:
                    channelSettings = (_c.sent())[0][0];
                    return [4 /*yield*/, db_1.default.execute("SELECT * FROM announcements WHERE subscription_id = ? AND channel_id = ? ORDER BY announcement_id DESC LIMIT 1", [sub.subscription_id, targetChannelId])];
                case 7:
                    existingAnnouncements = (_c.sent())[0];
                    existingAnnouncementFromDb = existingAnnouncements[0] || null;
                    return [4 /*yield*/, cleanupOldAnnouncements(client, sub.subscription_id, sub.guild_id, liveData.platform, sub.username, (existingAnnouncementFromDb === null || existingAnnouncementFromDb === void 0 ? void 0 : existingAnnouncementFromDb.message_id) || null)];
                case 8:
                    _c.sent();
                    return [4 /*yield*/, (0, announcer_1.updateAnnouncement)(client, {
                            streamer_id: sub.streamer_id,
                            username: sub.username,
                            guild_id: sub.guild_id,
                            profile_image_url: null,
                            custom_message: null,
                            override_nickname: null,
                            override_avatar_url: null,
                            discord_user_id: sub.discord_user_id || null
                        }, liveData, existingAnnouncementFromDb ? {
                            message_id: existingAnnouncementFromDb.message_id || '',
                            channel_id: existingAnnouncementFromDb.channel_id
                        } : null, guildSettings, channelSettings, teamSettings, targetChannelId)];
                case 9:
                    sentMessage = _c.sent();
                    if (!(sentMessage && sentMessage.id && targetChannelId)) return [3 /*break*/, 15];
                    query = existingAnnouncementFromDb
                        ? "UPDATE announcements SET message_id = ?, stream_game = ?, stream_title = ?, stream_thumbnail_url = ? WHERE announcement_id = ?"
                        : "INSERT INTO announcements (subscription_id, streamer_id, guild_id, message_id, channel_id, stream_game, stream_title, platform, stream_thumbnail_url, stream_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
                    params = existingAnnouncementFromDb
                        ? [sentMessage.id, liveData.game || null, liveData.title || null, liveData.thumbnailUrl || null, existingAnnouncementFromDb.announcement_id]
                        : [sub.subscription_id, sub.streamer_id, sub.guild_id, sentMessage.id, targetChannelId, liveData.game || null, liveData.title || null, liveData.platform, liveData.thumbnailUrl || null, liveData.url || null];
                    return [4 /*yield*/, db_1.default.execute(query, params)];
                case 10:
                    _c.sent();
                    // Update live_announcements table for stream manager tracking
                    return [4 /*yield*/, db_1.default.execute("INSERT INTO live_announcements (guild_id, platform, username, channel_id, message_id, streamer_id, discord_user_id, stream_started_at)\n                     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())\n                     ON DUPLICATE KEY UPDATE message_id = VALUES(message_id), updated_at = CURRENT_TIMESTAMP", [sub.guild_id, liveData.platform, sub.username, targetChannelId, sentMessage.id, sub.streamer_id, sub.discord_user_id || null]).catch(function (error) {
                            if (error.code !== 'ER_NO_SUCH_TABLE') {
                                logger_1.default.warn("[Worker] Failed to update live_announcements table:", { error: error.message });
                            }
                        })];
                case 11:
                    // Update live_announcements table for stream manager tracking
                    _c.sent();
                    rolesToApply = __spreadArray([], new Set([
                        guildSettings === null || guildSettings === void 0 ? void 0 : guildSettings.live_role_id,
                        teamSettings === null || teamSettings === void 0 ? void 0 : teamSettings.live_role_id,
                        sub.live_role_id
                    ].filter(Boolean)), true);
                    if (!(rolesToApply.length > 0 && sub.discord_user_id)) return [3 /*break*/, 15];
                    return [4 /*yield*/, client.guilds.fetch(sub.guild_id).catch(function () { return null; })];
                case 12:
                    guild = _c.sent();
                    if (!guild) return [3 /*break*/, 15];
                    return [4 /*yield*/, guild.members.fetch(sub.discord_user_id).catch(function () { return null; })];
                case 13:
                    member = _c.sent();
                    if (!member) return [3 /*break*/, 15];
                    return [4 /*yield*/, (0, role_manager_1.processRole)(member, rolesToApply, 'add', sub.guild_id)];
                case 14:
                    _c.sent();
                    _c.label = 15;
                case 15: return [3 /*break*/, 17];
                case 16:
                    error_2 = _c.sent();
                    logger_1.default.error("[Worker] Job ".concat(job.id, " failed for ").concat(sub.username, ":"), { error: error_2.message, stack: error_2.stack, guildId: sub.guild_id });
                    throw error_2;
                case 17: return [2 /*return*/];
            }
        });
    }); }, { connection: cache_1.redisOptions, concurrency: 10 });
    announcementWorker.on('error', function (err) { return logger_1.default.error('[Announcement Worker] Worker error:', { error: err }); });
    announcementWorker.on('completed', function (job) { return logger_1.default.info("[Announcement Worker] Job ".concat(job.id, " has completed for ").concat(job.data.sub.username, ".")); });
    announcementWorker.on('failed', function (job, err) { var _a, _b; return logger_1.default.error("[Announcement Worker] Job ".concat(job === null || job === void 0 ? void 0 : job.id, " for ").concat((_b = (_a = job === null || job === void 0 ? void 0 : job.data) === null || _a === void 0 ? void 0 : _a.sub) === null || _b === void 0 ? void 0 : _b.username, " has failed."), { error: err }); });
    return announcementWorker;
};
