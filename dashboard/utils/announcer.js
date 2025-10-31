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
exports.updateAnnouncement = updateAnnouncement;
exports.getWebhookClient = getWebhookClient;
exports.getAndUpdateWebhook = getWebhookClient;
exports.getOrCreateWebhook = getWebhookClient;
var discord_js_1 = require("discord.js");
var db_1 = require("./db");
var logger_1 = require("./logger");
var platformColors = {
    twitch: '#9146FF',
    youtube: '#FF0000',
    kick: '#52E252',
    tiktok: '#00f2ea',
    trovo: '#21d464',
    default: '#36393f'
};
var WEBHOOK_NAME_PREFIX = 'CertiFried MultiTool';
/**
 * Retrieves or creates a webhook client for a given channel
 * @param client - Discord client instance
 * @param channelId - ID of the channel to get webhook for
 * @param desiredName - Desired webhook name (unused in current implementation)
 * @param desiredAvatarURL - Desired webhook avatar URL (unused in current implementation)
 * @returns WebhookClient or null if failed
 */
function getWebhookClient(client, channelId, _desiredName, _desiredAvatarURL) {
    return __awaiter(this, void 0, void 0, function () {
        var getCachedGuildId, rows, channelSettings, channel, textChannel, botMember, permissions, webhooks, webhook, newWebhook, e_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    getCachedGuildId = function (chId) {
                        var _a;
                        var ch = client.channels.cache.get(chId);
                        if (ch && 'guild' in ch) {
                            return (_a = ch.guild) === null || _a === void 0 ? void 0 : _a.id;
                        }
                        return undefined;
                    };
                    logger_1.logger.debug("[Webhook Manager] Processing channel ".concat(channelId, "."), {
                        guildId: getCachedGuildId(channelId),
                        category: 'announcer'
                    });
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 7, , 8]);
                    return [4 /*yield*/, db_1.pool.execute('SELECT webhook_url FROM channel_settings WHERE channel_id = ?', [channelId])];
                case 2:
                    rows = (_a.sent())[0];
                    channelSettings = rows[0];
                    if (channelSettings && channelSettings.webhook_url) {
                        logger_1.logger.info("[Webhook Manager] Using custom webhook URL for channel ".concat(channelId, "."), {
                            guildId: getCachedGuildId(channelId),
                            channelId: channelId,
                            category: 'announcer'
                        });
                        return [2 /*return*/, new discord_js_1.WebhookClient({ url: channelSettings.webhook_url })];
                    }
                    return [4 /*yield*/, client.channels.fetch(channelId).catch(function () { return null; })];
                case 3:
                    channel = _a.sent();
                    if (!channel || !channel.isTextBased()) {
                        logger_1.logger.warn("[Webhook Manager] Channel ".concat(channelId, " not found, not in a guild, or not a text channel."), {
                            category: 'announcer'
                        });
                        return [2 /*return*/, null];
                    }
                    // Type guard for text channels with guild - must be TextChannel for webhook operations
                    if (!('guild' in channel) || !channel.guild) {
                        logger_1.logger.warn("[Webhook Manager] Channel ".concat(channelId, " not found, not in a guild, or not a text channel."), {
                            category: 'announcer'
                        });
                        return [2 /*return*/, null];
                    }
                    textChannel = channel;
                    return [4 /*yield*/, textChannel.guild.members.fetch(client.user.id).catch(function () { return null; })];
                case 4:
                    botMember = _a.sent();
                    if (!botMember) {
                        logger_1.logger.error("[Webhook Manager] Could not fetch bot's own member object in guild ".concat(textChannel.guild.id, "."), {
                            guildId: textChannel.guild.id,
                            category: 'announcer'
                        });
                        return [2 /*return*/, null];
                    }
                    permissions = textChannel.permissionsFor(botMember);
                    if (!permissions || !permissions.has(['ManageWebhooks', 'SendMessages'])) {
                        logger_1.logger.warn("[Webhook Manager] Missing ManageWebhooks or SendMessages permission in channel ".concat(channelId, "."), {
                            guildId: textChannel.guild.id,
                            category: 'announcer'
                        });
                        return [2 /*return*/, null];
                    }
                    return [4 /*yield*/, textChannel.fetchWebhooks()];
                case 5:
                    webhooks = _a.sent();
                    webhook = webhooks.find(function (wh) { var _a; return ((_a = wh.owner) === null || _a === void 0 ? void 0 : _a.id) === client.user.id && wh.name.startsWith(WEBHOOK_NAME_PREFIX); });
                    if (webhook) {
                        // Reuse existing webhook - DO NOT edit it, username/avatar are overridden per message
                        logger_1.logger.debug("[Webhook Manager] Reusing existing webhook ".concat(webhook.id, " in channel ").concat(channelId, "."), {
                            guildId: textChannel.guild.id,
                            channelId: channelId,
                            category: 'announcer'
                        });
                        return [2 /*return*/, new discord_js_1.WebhookClient({ id: webhook.id, token: webhook.token })];
                    }
                    // If no existing webhook, check limit before creating
                    if (webhooks.size >= 15) {
                        logger_1.logger.error("[Webhook Manager] Maximum number of webhooks (15) reached in channel ".concat(channelId, ". Cannot create new webhook. Please clear some or add a custom webhook URL in the dashboard."), {
                            guildId: textChannel.guild.id,
                            channelId: channelId,
                            category: 'announcer'
                        });
                        return [2 /*return*/, null];
                    }
                    // Create new webhook with generic name - username/avatar are overridden per message
                    logger_1.logger.info("[Webhook Manager] Creating new webhook in channel ".concat(channelId, "."), {
                        guildId: textChannel.guild.id,
                        channelId: channelId,
                        category: 'announcer'
                    });
                    return [4 /*yield*/, textChannel.createWebhook({
                            name: WEBHOOK_NAME_PREFIX,
                            avatar: client.user.displayAvatarURL(),
                            reason: 'For stream announcements - username/avatar set per message'
                        })];
                case 6:
                    newWebhook = _a.sent();
                    return [2 /*return*/, new discord_js_1.WebhookClient({ id: newWebhook.id, token: newWebhook.token })];
                case 7:
                    e_1 = _a.sent();
                    logger_1.logger.error("[Webhook Manager] Failed to get or update webhook.", {
                        guildId: getCachedGuildId(channelId) || 'N/A',
                        channelId: channelId,
                        errorMessage: e_1.message,
                        errorStack: e_1.stack,
                        category: 'announcer'
                    });
                    return [2 /*return*/, null];
                case 8: return [2 /*return*/];
            }
        });
    });
}
/**
 * Updates or creates a stream announcement
 * @param client - Discord client instance
 * @param subContext - Streamer subscription context
 * @param liveData - Live stream data
 * @param existingAnnouncement - Existing announcement to edit (if any)
 * @param guildSettings - Guild-level settings
 * @param channelSettings - Channel-level settings
 * @param teamSettings - Team-level settings
 * @param targetChannelId - Channel ID to send announcement to
 * @returns Message result or null if failed
 */
function updateAnnouncement(client, subContext, liveData, existingAnnouncement, guildSettings, channelSettings, teamSettings, targetChannelId) {
    return __awaiter(this, void 0, void 0, function () {
        var platformName, platformColor, embed, content, finalNickname, finalAvatarURL, webhookClient, messageOptions, editedMessage, e_2, sentMessage, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!liveData || typeof liveData.platform !== 'string') {
                        logger_1.logger.error("[Announcer] Invalid liveData for ".concat(subContext.username, "."), {
                            guildId: subContext.guild_id,
                            category: 'announcer'
                        });
                        return [2 /*return*/, null];
                    }
                    if (liveData.profileImageUrl && liveData.profileImageUrl !== subContext.profile_image_url) {
                        db_1.pool.execute('UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?', [liveData.profileImageUrl, subContext.streamer_id]).catch(function (dbError) {
                            logger_1.logger.error("[Announcer] Failed to update profile image.", {
                                error: dbError,
                                guildId: subContext.guild_id,
                                category: 'announcer'
                            });
                        });
                    }
                    if (!targetChannelId)
                        return [2 /*return*/, null];
                    platformName = liveData.platform.charAt(0).toUpperCase() + liveData.platform.slice(1);
                    platformColor = (platformColors[liveData.platform] || platformColors.default);
                    embed = new discord_js_1.EmbedBuilder()
                        .setColor(platformColor)
                        .setAuthor({ name: "".concat(liveData.username, " is LIVE on ").concat(platformName, "!"), url: liveData.url })
                        .setTitle(liveData.title || 'Untitled Stream')
                        .setURL(liveData.url)
                        .addFields({ name: 'Playing', value: liveData.game || 'N/A', inline: true })
                        .setTimestamp();
                    if (liveData.thumbnailUrl) {
                        embed.setImage("".concat(liveData.thumbnailUrl, "?t=").concat(Date.now()));
                    }
                    content = subContext.custom_message
                        ? subContext.custom_message
                            .replace(/{username}/g, liveData.username)
                            .replace(/{platform}/g, platformName)
                            .replace(/{url}/g, liveData.url)
                            .replace(/{title}/g, liveData.title || 'Untitled Stream')
                            .replace(/{game}/g, liveData.game || 'N/A')
                        : null;
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 10, , 11]);
                    finalNickname = (teamSettings === null || teamSettings === void 0 ? void 0 : teamSettings.webhook_name) || (guildSettings === null || guildSettings === void 0 ? void 0 : guildSettings.bot_nickname) || WEBHOOK_NAME_PREFIX;
                    finalAvatarURL = (teamSettings === null || teamSettings === void 0 ? void 0 : teamSettings.webhook_avatar_url) || (guildSettings === null || guildSettings === void 0 ? void 0 : guildSettings.webhook_avatar_url) || client.user.displayAvatarURL();
                    if (channelSettings === null || channelSettings === void 0 ? void 0 : channelSettings.override_nickname)
                        finalNickname = channelSettings.override_nickname;
                    if (channelSettings === null || channelSettings === void 0 ? void 0 : channelSettings.override_avatar_url)
                        finalAvatarURL = channelSettings.override_avatar_url;
                    if (subContext.override_nickname)
                        finalNickname = subContext.override_nickname;
                    if (subContext.override_avatar_url)
                        finalAvatarURL = subContext.override_avatar_url;
                    return [4 /*yield*/, getWebhookClient(client, targetChannelId, finalNickname, finalAvatarURL)];
                case 2:
                    webhookClient = _a.sent();
                    if (!webhookClient) {
                        logger_1.logger.error("[Announcer] Webhook client is null for channel ".concat(targetChannelId, ". Cannot send/edit message."), {
                            guildId: subContext.guild_id,
                            channelId: targetChannelId,
                            category: 'announcer'
                        });
                        return [2 /*return*/, null];
                    }
                    messageOptions = {
                        username: finalNickname,
                        avatarURL: finalAvatarURL,
                        content: content || undefined,
                        embeds: [embed]
                    };
                    if (!(existingAnnouncement === null || existingAnnouncement === void 0 ? void 0 : existingAnnouncement.message_id)) return [3 /*break*/, 7];
                    _a.label = 3;
                case 3:
                    _a.trys.push([3, 5, , 6]);
                    return [4 /*yield*/, webhookClient.editMessage(existingAnnouncement.message_id, messageOptions)];
                case 4:
                    editedMessage = _a.sent();
                    return [2 /*return*/, editedMessage];
                case 5:
                    e_2 = _a.sent();
                    if (e_2 instanceof discord_js_1.DiscordAPIError && e_2.code === 10008) { // Unknown Message
                        return [2 /*return*/, { deleted: true }];
                    }
                    else {
                        logger_1.logger.error("[Announcer] Failed to edit existing announcement.", {
                            guildId: subContext.guild_id,
                            messageId: existingAnnouncement.message_id,
                            error: e_2,
                            category: 'announcer'
                        });
                        return [2 /*return*/, null];
                    }
                    return [3 /*break*/, 6];
                case 6: return [3 /*break*/, 9];
                case 7: return [4 /*yield*/, webhookClient.send(messageOptions)];
                case 8:
                    sentMessage = _a.sent();
                    db_1.pool.execute('INSERT INTO global_stats (id, total_announcements) VALUES (1, 1) ON DUPLICATE KEY UPDATE total_announcements = total_announcements + 1');
                    return [2 /*return*/, sentMessage];
                case 9: return [3 /*break*/, 11];
                case 10:
                    error_1 = _a.sent();
                    logger_1.logger.error("[Announcer] CRITICAL Failure for ".concat(liveData.username, "."), {
                        error: error_1,
                        guildId: subContext.guild_id,
                        channelId: targetChannelId,
                        category: 'announcer'
                    });
                    return [2 /*return*/, null];
                case 11: return [2 /*return*/];
            }
        });
    });
}
exports.default = { updateAnnouncement: updateAnnouncement, getWebhookClient: getWebhookClient, getAndUpdateWebhook: getWebhookClient, getOrCreateWebhook: getWebhookClient };
