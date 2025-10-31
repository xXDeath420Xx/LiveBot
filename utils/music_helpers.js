"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkMusicPermissions = checkMusicPermissions;
const db_1 = __importDefault(require("./db"));
const discord_js_1 = require("discord.js");
const configCache = new Map();
setInterval(() => configCache.clear(), 5 * 60 * 1000);
async function checkMusicPermissions(interaction) {
    const guildId = interaction.guild.id;
    let config = configCache.get(guildId);
    if (config === undefined) {
        const [dbConfigRows] = await db_1.default.execute('SELECT * FROM music_config WHERE guild_id = ?', [guildId]);
        config = dbConfigRows[0] || null;
        configCache.set(guildId, config);
    }
    // FIX: Check config.enabled instead of config.is_enabled
    if (!config || !config.enabled) {
        return { permitted: false, message: 'The music system is disabled on this server.' };
    }
    const textChannels = config.text_channel_ids ? JSON.parse(config.text_channel_ids) : [];
    if (textChannels.length > 0 && !textChannels.includes(interaction.channelId)) {
        return {
            permitted: false,
            message: `Music commands can only be used in the following channels: ${textChannels.map(id => `<#${id}>`).join(', ')}.`
        };
    }
    const member = interaction.member;
    const djRoleId = config.dj_role_id;
    if (!djRoleId) {
        return { permitted: true }; // No DJ role configured, so everyone is permitted
    }
    const isDJ = member.roles.cache.has(djRoleId);
    const isAdmin = member.permissions.has(discord_js_1.PermissionsBitField.Flags.Administrator);
    const isAlone = member.voice.channel ? member.voice.channel.members.size === 1 : false;
    if (isDJ || isAdmin || isAlone) {
        return { permitted: true };
    }
    else {
        return {
            permitted: false,
            message: `You need the <@&${djRoleId}> role, be an Administrator, or be alone in the voice channel to use this command.`
        };
    }
}
