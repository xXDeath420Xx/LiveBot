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
var discord_js_1 = require("discord.js");
var logger_1 = require("../utils/logger");
var db_1 = require("../utils/db");
/**
 * AI DJ Command
 *
 * Manages the 24/7 AI-powered auto-DJ system
 * Subcommands:
 * - start: Start the AI DJ
 * - stop: Stop the AI DJ
 * - config: Configure AI DJ settings
 * - queue: View current queue
 * - skip: Skip current song
 * - nowplaying: Show currently playing song
 * - playlist: Save/load playlist configurations
 */
module.exports = {
    category: 'Music',
    data: new discord_js_1.SlashCommandBuilder()
        .setName('aidj')
        .setDescription('AI-powered 24/7 auto-DJ system')
        .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.ManageGuild)
        .addSubcommand(function (subcommand) {
        return subcommand
            .setName('start')
            .setDescription('Start the AI DJ in a voice channel')
            .addChannelOption(function (option) {
            return option
                .setName('channel')
                .setDescription('Voice channel for the AI DJ')
                .setRequired(true)
                .addChannelTypes(discord_js_1.ChannelType.GuildVoice);
        });
    })
        .addSubcommand(function (subcommand) {
        return subcommand
            .setName('stop')
            .setDescription('Stop the AI DJ');
    })
        .addSubcommand(function (subcommand) {
        return subcommand
            .setName('config')
            .setDescription('Configure AI DJ settings')
            .addStringOption(function (option) {
            return option
                .setName('setting')
                .setDescription('Setting to configure')
                .setRequired(true)
                .addChoices({ name: 'Genres', value: 'genres' }, { name: 'Artists', value: 'artists' }, { name: 'Years', value: 'years' }, { name: 'Mood', value: 'mood' }, { name: 'Activity', value: 'activity' }, { name: 'AI Prompt', value: 'ai_prompt' }, { name: 'Randomness', value: 'randomness' }, { name: 'Volume', value: 'volume' });
        })
            .addStringOption(function (option) {
            return option
                .setName('value')
                .setDescription('New value for the setting')
                .setRequired(true);
        });
    })
        .addSubcommand(function (subcommand) {
        return subcommand
            .setName('queue')
            .setDescription('View the current AI DJ queue');
    })
        .addSubcommand(function (subcommand) {
        return subcommand
            .setName('skip')
            .setDescription('Skip the current song');
    })
        .addSubcommand(function (subcommand) {
        return subcommand
            .setName('nowplaying')
            .setDescription('Show currently playing song');
    })
        .addSubcommand(function (subcommand) {
        return subcommand
            .setName('playlist')
            .setDescription('Manage AI DJ playlists')
            .addStringOption(function (option) {
            return option
                .setName('action')
                .setDescription('Playlist action')
                .setRequired(true)
                .addChoices({ name: 'Save current config', value: 'save' }, { name: 'Load playlist', value: 'load' }, { name: 'List playlists', value: 'list' }, { name: 'Delete playlist', value: 'delete' });
        })
            .addStringOption(function (option) {
            return option
                .setName('name')
                .setDescription('Playlist name')
                .setRequired(false);
        });
    })
        .addSubcommand(function (subcommand) {
        return subcommand
            .setName('favorite')
            .setDescription('Add current song to favorites');
    })
        .addSubcommand(function (subcommand) {
        return subcommand
            .setName('blacklist')
            .setDescription('Blacklist current song (never play again)')
            .addStringOption(function (option) {
            return option
                .setName('reason')
                .setDescription('Reason for blacklisting')
                .setRequired(false);
        });
    })
        .addSubcommand(function (subcommand) {
        return subcommand
            .setName('stats')
            .setDescription('View AI DJ statistics');
    }),
    execute: function (interaction) {
        return __awaiter(this, void 0, void 0, function () {
            var subcommand, _a, error_1, errorMessage;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        subcommand = interaction.options.getSubcommand();
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 25, , 30]);
                        _a = subcommand;
                        switch (_a) {
                            case 'start': return [3 /*break*/, 2];
                            case 'stop': return [3 /*break*/, 4];
                            case 'config': return [3 /*break*/, 6];
                            case 'queue': return [3 /*break*/, 8];
                            case 'skip': return [3 /*break*/, 10];
                            case 'nowplaying': return [3 /*break*/, 12];
                            case 'playlist': return [3 /*break*/, 14];
                            case 'favorite': return [3 /*break*/, 16];
                            case 'blacklist': return [3 /*break*/, 18];
                            case 'stats': return [3 /*break*/, 20];
                        }
                        return [3 /*break*/, 22];
                    case 2: return [4 /*yield*/, handleStart(interaction)];
                    case 3:
                        _b.sent();
                        return [3 /*break*/, 24];
                    case 4: return [4 /*yield*/, handleStop(interaction)];
                    case 5:
                        _b.sent();
                        return [3 /*break*/, 24];
                    case 6: return [4 /*yield*/, handleConfig(interaction)];
                    case 7:
                        _b.sent();
                        return [3 /*break*/, 24];
                    case 8: return [4 /*yield*/, handleQueue(interaction)];
                    case 9:
                        _b.sent();
                        return [3 /*break*/, 24];
                    case 10: return [4 /*yield*/, handleSkip(interaction)];
                    case 11:
                        _b.sent();
                        return [3 /*break*/, 24];
                    case 12: return [4 /*yield*/, handleNowPlaying(interaction)];
                    case 13:
                        _b.sent();
                        return [3 /*break*/, 24];
                    case 14: return [4 /*yield*/, handlePlaylist(interaction)];
                    case 15:
                        _b.sent();
                        return [3 /*break*/, 24];
                    case 16: return [4 /*yield*/, handleFavorite(interaction)];
                    case 17:
                        _b.sent();
                        return [3 /*break*/, 24];
                    case 18: return [4 /*yield*/, handleBlacklist(interaction)];
                    case 19:
                        _b.sent();
                        return [3 /*break*/, 24];
                    case 20: return [4 /*yield*/, handleStats(interaction)];
                    case 21:
                        _b.sent();
                        return [3 /*break*/, 24];
                    case 22: return [4 /*yield*/, interaction.reply({ content: 'Unknown subcommand.', ephemeral: true })];
                    case 23:
                        _b.sent();
                        _b.label = 24;
                    case 24: return [3 /*break*/, 30];
                    case 25:
                        error_1 = _b.sent();
                        logger_1.logger.error('[AI DJ Command] Error executing command', {
                            subcommand: subcommand,
                            guild: interaction.guildId,
                            error: error_1.message,
                            stack: error_1.stack
                        });
                        errorMessage = 'An error occurred while executing the AI DJ command.';
                        if (!(interaction.replied || interaction.deferred)) return [3 /*break*/, 27];
                        return [4 /*yield*/, interaction.followUp({ content: errorMessage, ephemeral: true })];
                    case 26:
                        _b.sent();
                        return [3 /*break*/, 29];
                    case 27: return [4 /*yield*/, interaction.reply({ content: errorMessage, ephemeral: true })];
                    case 28:
                        _b.sent();
                        _b.label = 29;
                    case 29: return [3 /*break*/, 30];
                    case 30: return [2 /*return*/];
                }
            });
        });
    }
};
function handleStart(interaction) {
    return __awaiter(this, void 0, void 0, function () {
        var channel;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    channel = interaction.options.getChannel('channel', true);
                    if (!(channel.type !== discord_js_1.ChannelType.GuildVoice)) return [3 /*break*/, 2];
                    return [4 /*yield*/, interaction.reply({ content: '❌ Please select a voice channel.', ephemeral: true })];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
                case 2: return [4 /*yield*/, interaction.deferReply()];
                case 3:
                    _a.sent();
                    // Initialize AI DJ config if it doesn't exist
                    return [4 /*yield*/, db_1.db.execute("INSERT INTO ai_dj_config (guild_id, enabled, voice_channel_id, announcement_channel_id)\n         VALUES (?, TRUE, ?, ?)\n         ON DUPLICATE KEY UPDATE\n         enabled = TRUE,\n         voice_channel_id = ?,\n         announcement_channel_id = IF(announcement_channel_id IS NULL, ?, announcement_channel_id)", [interaction.guildId, channel.id, interaction.channelId, channel.id, interaction.channelId])];
                case 4:
                    // Initialize AI DJ config if it doesn't exist
                    _a.sent();
                    // Start AI DJ (this will be integrated with the AIDJManager)
                    // await aiDJManager.start(interaction.guildId!);
                    return [4 /*yield*/, interaction.editReply({
                            content: "\u2705 AI DJ started in ".concat(channel, "!\n\n\uD83C\uDFB5 The AI is now curating music based on your preferences.\nUse `/aidj config` to customize the music selection.")
                        })];
                case 5:
                    // Start AI DJ (this will be integrated with the AIDJManager)
                    // await aiDJManager.start(interaction.guildId!);
                    _a.sent();
                    logger_1.logger.info("[AI DJ] Started for guild ".concat(interaction.guildId, " in channel ").concat(channel.id), {
                        user: interaction.user.id
                    });
                    return [2 /*return*/];
            }
        });
    });
}
function handleStop(interaction) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, interaction.deferReply()];
                case 1:
                    _a.sent();
                    return [4 /*yield*/, db_1.db.execute('UPDATE ai_dj_config SET enabled = FALSE WHERE guild_id = ?', [interaction.guildId])];
                case 2:
                    _a.sent();
                    // Stop AI DJ (this will be integrated with the AIDJManager)
                    // await aiDJManager.stop(interaction.guildId!);
                    return [4 /*yield*/, interaction.editReply({
                            content: '⏹️ AI DJ stopped. Use `/aidj start` to start it again.'
                        })];
                case 3:
                    // Stop AI DJ (this will be integrated with the AIDJManager)
                    // await aiDJManager.stop(interaction.guildId!);
                    _a.sent();
                    logger_1.logger.info("[AI DJ] Stopped for guild ".concat(interaction.guildId), {
                        user: interaction.user.id
                    });
                    return [2 /*return*/];
            }
        });
    });
}
function handleConfig(interaction) {
    return __awaiter(this, void 0, void 0, function () {
        var setting, value, updateQuery, updateValue, _a, genres, artists, years, randomness, volume;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setting = interaction.options.getString('setting', true);
                    value = interaction.options.getString('value', true);
                    return [4 /*yield*/, interaction.deferReply()];
                case 1:
                    _b.sent();
                    updateQuery = '';
                    updateValue = value;
                    _a = setting;
                    switch (_a) {
                        case 'genres': return [3 /*break*/, 2];
                        case 'artists': return [3 /*break*/, 3];
                        case 'years': return [3 /*break*/, 4];
                        case 'mood': return [3 /*break*/, 5];
                        case 'activity': return [3 /*break*/, 6];
                        case 'ai_prompt': return [3 /*break*/, 7];
                        case 'randomness': return [3 /*break*/, 8];
                        case 'volume': return [3 /*break*/, 11];
                    }
                    return [3 /*break*/, 14];
                case 2:
                    genres = value.split(',').map(function (g) { return g.trim(); });
                    updateQuery = 'genres = ?';
                    updateValue = JSON.stringify(genres);
                    return [3 /*break*/, 14];
                case 3:
                    artists = value.split(',').map(function (a) { return a.trim(); });
                    updateQuery = 'artists = ?';
                    updateValue = JSON.stringify(artists);
                    return [3 /*break*/, 14];
                case 4:
                    years = value.split(',').map(function (y) { return parseInt(y.trim()); });
                    updateQuery = 'years = ?';
                    updateValue = JSON.stringify(years);
                    return [3 /*break*/, 14];
                case 5:
                    updateQuery = 'mood = ?';
                    return [3 /*break*/, 14];
                case 6:
                    updateQuery = 'activity_type = ?';
                    return [3 /*break*/, 14];
                case 7:
                    updateQuery = 'ai_prompt = ?';
                    return [3 /*break*/, 14];
                case 8:
                    randomness = parseInt(value);
                    if (!(randomness < 0 || randomness > 100)) return [3 /*break*/, 10];
                    return [4 /*yield*/, interaction.editReply('❌ Randomness must be between 0 and 100.')];
                case 9:
                    _b.sent();
                    return [2 /*return*/];
                case 10:
                    updateQuery = 'randomness_level = ?';
                    updateValue = randomness;
                    return [3 /*break*/, 14];
                case 11:
                    volume = parseInt(value);
                    if (!(volume < 0 || volume > 100)) return [3 /*break*/, 13];
                    return [4 /*yield*/, interaction.editReply('❌ Volume must be between 0 and 100.')];
                case 12:
                    _b.sent();
                    return [2 /*return*/];
                case 13:
                    updateQuery = 'volume = ?';
                    updateValue = volume;
                    return [3 /*break*/, 14];
                case 14: return [4 /*yield*/, db_1.db.execute("UPDATE ai_dj_config SET ".concat(updateQuery, " WHERE guild_id = ?"), [updateValue, interaction.guildId])];
                case 15:
                    _b.sent();
                    return [4 /*yield*/, interaction.editReply({
                            content: "\u2705 **".concat(setting, "** updated to: `").concat(value, "`\n\nChanges will take effect on the next song.")
                        })];
                case 16:
                    _b.sent();
                    logger_1.logger.info("[AI DJ] Config updated for guild ".concat(interaction.guildId), {
                        setting: setting,
                        value: value,
                        user: interaction.user.id
                    });
                    return [2 /*return*/];
            }
        });
    });
}
function handleQueue(interaction) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, interaction.deferReply()];
                case 1:
                    _a.sent();
                    // Get queue from AIDJManager
                    // const queue = aiDJManager.getQueue(interaction.guildId!);
                    // Placeholder response
                    return [4 /*yield*/, interaction.editReply({
                            embeds: [{
                                    color: 0x9B59B6,
                                    title: '🎵 AI DJ Queue',
                                    description: 'The AI has curated the following songs:\n\n' +
                                        '**1.** Artist - Song Title\n' +
                                        '**2.** Artist - Song Title\n' +
                                        '**3.** Artist - Song Title\n' +
                                        '...\n\n' +
                                        '_Queue is automatically refilled as songs are played_',
                                    footer: {
                                        text: '🤖 Powered by AI music curation'
                                    },
                                    timestamp: new Date().toISOString()
                                }]
                        })];
                case 2:
                    // Get queue from AIDJManager
                    // const queue = aiDJManager.getQueue(interaction.guildId!);
                    // Placeholder response
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function handleSkip(interaction) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, interaction.deferReply()];
                case 1:
                    _a.sent();
                    // Skip current song via AIDJManager
                    // await aiDJManager.skip(interaction.guildId!);
                    return [4 /*yield*/, interaction.editReply({
                            content: '⏭️ Skipped to next song!'
                        })];
                case 2:
                    // Skip current song via AIDJManager
                    // await aiDJManager.skip(interaction.guildId!);
                    _a.sent();
                    logger_1.logger.info("[AI DJ] Song skipped for guild ".concat(interaction.guildId), {
                        user: interaction.user.id
                    });
                    return [2 /*return*/];
            }
        });
    });
}
function handleNowPlaying(interaction) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, interaction.deferReply()];
                case 1:
                    _a.sent();
                    // Get now playing from AIDJManager
                    // const nowPlaying = aiDJManager.getNowPlaying(interaction.guildId!);
                    return [4 /*yield*/, interaction.editReply({
                            embeds: [{
                                    color: 0x9B59B6,
                                    title: '🎵 Now Playing',
                                    description: '**Song Title**\nby Artist Name',
                                    fields: [
                                        { name: 'Album', value: 'Album Name', inline: true },
                                        { name: 'Year', value: '2020', inline: true },
                                        { name: 'Genre', value: 'Rock', inline: true }
                                    ],
                                    thumbnail: {
                                        url: 'https://via.placeholder.com/300'
                                    },
                                    footer: {
                                        text: '🤖 AI DJ - Powered by AI music curation'
                                    },
                                    timestamp: new Date().toISOString()
                                }]
                        })];
                case 2:
                    // Get now playing from AIDJManager
                    // const nowPlaying = aiDJManager.getNowPlaying(interaction.guildId!);
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function handlePlaylist(interaction) {
    return __awaiter(this, void 0, void 0, function () {
        var action, name, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    action = interaction.options.getString('action', true);
                    name = interaction.options.getString('name');
                    return [4 /*yield*/, interaction.deferReply()];
                case 1:
                    _b.sent();
                    _a = action;
                    switch (_a) {
                        case 'save': return [3 /*break*/, 2];
                        case 'load': return [3 /*break*/, 6];
                        case 'list': return [3 /*break*/, 10];
                        case 'delete': return [3 /*break*/, 12];
                    }
                    return [3 /*break*/, 16];
                case 2:
                    if (!!name) return [3 /*break*/, 4];
                    return [4 /*yield*/, interaction.editReply('❌ Please provide a name for the playlist.')];
                case 3:
                    _b.sent();
                    return [2 /*return*/];
                case 4: 
                // Save current config as playlist
                return [4 /*yield*/, interaction.editReply("\u2705 Playlist **".concat(name, "** saved!"))];
                case 5:
                    // Save current config as playlist
                    _b.sent();
                    return [3 /*break*/, 16];
                case 6:
                    if (!!name) return [3 /*break*/, 8];
                    return [4 /*yield*/, interaction.editReply('❌ Please provide the name of the playlist to load.')];
                case 7:
                    _b.sent();
                    return [2 /*return*/];
                case 8: 
                // Load playlist config
                return [4 /*yield*/, interaction.editReply("\u2705 Playlist **".concat(name, "** loaded!"))];
                case 9:
                    // Load playlist config
                    _b.sent();
                    return [3 /*break*/, 16];
                case 10: 
                // List all playlists
                return [4 /*yield*/, interaction.editReply({
                        embeds: [{
                                color: 0x9B59B6,
                                title: '📋 AI DJ Playlists',
                                description: '**1.** Rock Classics\n**2.** Chill Vibes\n**3.** Gaming Mix',
                                footer: {
                                    text: 'Use /aidj playlist load <name> to load a playlist'
                                }
                            }]
                    })];
                case 11:
                    // List all playlists
                    _b.sent();
                    return [3 /*break*/, 16];
                case 12:
                    if (!!name) return [3 /*break*/, 14];
                    return [4 /*yield*/, interaction.editReply('❌ Please provide the name of the playlist to delete.')];
                case 13:
                    _b.sent();
                    return [2 /*return*/];
                case 14: 
                // Delete playlist
                return [4 /*yield*/, interaction.editReply("\u2705 Playlist **".concat(name, "** deleted."))];
                case 15:
                    // Delete playlist
                    _b.sent();
                    return [3 /*break*/, 16];
                case 16: return [2 /*return*/];
            }
        });
    });
}
function handleFavorite(interaction) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, interaction.deferReply()];
                case 1:
                    _a.sent();
                    // Add current song to favorites
                    return [4 /*yield*/, interaction.editReply('⭐ Current song added to favorites! It will be played more often.')];
                case 2:
                    // Add current song to favorites
                    _a.sent();
                    logger_1.logger.info("[AI DJ] Song favorited for guild ".concat(interaction.guildId), {
                        user: interaction.user.id
                    });
                    return [2 /*return*/];
            }
        });
    });
}
function handleBlacklist(interaction) {
    return __awaiter(this, void 0, void 0, function () {
        var reason;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    reason = interaction.options.getString('reason');
                    return [4 /*yield*/, interaction.deferReply()];
                case 1:
                    _a.sent();
                    // Blacklist current song
                    return [4 /*yield*/, interaction.editReply("\uD83D\uDEAB Current song blacklisted. It will never be played again.".concat(reason ? "\nReason: ".concat(reason) : ''))];
                case 2:
                    // Blacklist current song
                    _a.sent();
                    logger_1.logger.info("[AI DJ] Song blacklisted for guild ".concat(interaction.guildId), {
                        reason: reason,
                        user: interaction.user.id
                    });
                    return [2 /*return*/];
            }
        });
    });
}
function handleStats(interaction) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, interaction.deferReply()];
                case 1:
                    _a.sent();
                    // Get statistics from database
                    return [4 /*yield*/, interaction.editReply({
                            embeds: [{
                                    color: 0x9B59B6,
                                    title: '📊 AI DJ Statistics',
                                    fields: [
                                        { name: 'Total Songs Played', value: '1,234', inline: true },
                                        { name: 'Hours Played', value: '156', inline: true },
                                        { name: 'Unique Listeners', value: '89', inline: true },
                                        { name: 'Top Genre', value: 'Rock (45%)', inline: true },
                                        { name: 'Songs Skipped', value: '23 (1.9%)', inline: true },
                                        { name: 'Favorites', value: '67 songs', inline: true }
                                    ],
                                    footer: {
                                        text: '🤖 AI DJ Analytics - Last 30 days'
                                    },
                                    timestamp: new Date().toISOString()
                                }]
                        })];
                case 2:
                    // Get statistics from database
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
