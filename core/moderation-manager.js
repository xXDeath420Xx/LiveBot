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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logInfraction = logInfraction;
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const discord_js_1 = require("discord.js");
async function checkEscalations(guild, user) {
    // This function is imported from escalation-manager
    const { checkEscalations: checkEscalationsImpl } = await Promise.resolve().then(() => __importStar(require('./escalation-manager')));
    await checkEscalationsImpl(guild, user);
}
async function logInfraction(interaction, user, type, reason, durationMinutes = null) {
    try {
        const expiresAt = durationMinutes ? new Date(Date.now() + durationMinutes * 60000) : null;
        await db_1.default.execute('INSERT INTO infractions (guild_id, user_id, moderator_id, type, reason, duration_minutes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [interaction.guild.id, user.id, interaction.user.id, type, reason, durationMinutes, expiresAt]);
        const [[config]] = await db_1.default.execute('SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?', [interaction.guild.id]);
        if (!config || !config.mod_log_channel_id)
            return;
        const logChannel = await interaction.guild.channels.fetch(config.mod_log_channel_id).catch(() => null);
        if (!logChannel)
            return;
        let color = '#E67E22'; // Default for Warning
        if (type === 'Mute')
            color = '#F1C40F';
        if (type === 'Kick')
            color = '#E74C3C';
        if (type === 'Ban')
            color = '#C0392B';
        if (type === 'Unmute' || type === 'Unban')
            color = '#2ECC71'; // Green for reversals
        if (type === 'ClearInfractions')
            color = '#95A5A6'; // Add this line for a neutral/grey color
        const logEmbed = new discord_js_1.EmbedBuilder()
            .setColor(color)
            .setAuthor({ name: 'Moderation Log' })
            .setTitle(`${type.charAt(0).toUpperCase() + type.slice(1)} Issued`)
            .addFields({ name: 'User', value: `${user.tag} (${user.id})`, inline: false }, { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})`, inline: false }, { name: 'Reason', value: reason })
            .setTimestamp();
        if (durationMinutes) {
            logEmbed.addFields({ name: 'Duration', value: `${durationMinutes} minutes` });
        }
        await logChannel.send({ embeds: [logEmbed] });
        // We don't check for escalations on reversal actions
        if (type !== 'Unmute' && type !== 'Unban') {
            await checkEscalations(interaction.guild, user);
        }
    }
    catch (error) {
        logger_1.default.error('[ModerationManager] Failed to log infraction:', error);
    }
}
