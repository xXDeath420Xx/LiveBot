"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processNewMember = processNewMember;
exports.invalidateJoinGateCache = invalidateJoinGateCache;
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const discord_js_1 = require("discord.js");
const configCache = new Map();
async function processNewMember(member) {
    const guild = member.guild;
    const guildId = guild.id;
    try {
        let config = configCache.get(guildId);
        if (config === undefined) {
            const [[dbConfig]] = await db_1.default.execute('SELECT * FROM join_gate_config WHERE guild_id = ?', [guildId]);
            config = dbConfig || null;
            configCache.set(guildId, config);
            setTimeout(() => configCache.delete(guildId), 5 * 60 * 1000);
        }
        if (!config || !config.is_enabled) {
            return;
        }
        // Verification flow takes precedence
        if (config.verification_enabled) {
            const [[welcomeConfig]] = await db_1.default.execute('SELECT channel_id FROM welcome_settings WHERE guild_id = ?', [guildId]);
            const verificationChannelId = welcomeConfig ? welcomeConfig.channel_id : null;
            if (!verificationChannelId) {
                logger_1.default.warn('Join gate verification is enabled, but no welcome/verification channel is set.', { guildId, category: 'join-gate' });
                return;
            }
            const channel = await guild.channels.fetch(verificationChannelId).catch(() => null);
            if (!channel) {
                logger_1.default.warn(`Verification channel ${verificationChannelId} not found.`, { guildId, category: 'join-gate' });
                return;
            }
            const verifyButton = new discord_js_1.ButtonBuilder()
                .setCustomId(`joingate_verify_${member.id}`)
                .setLabel('Accept Rules & Verify')
                .setStyle(discord_js_1.ButtonStyle.Success);
            const row = new discord_js_1.ActionRowBuilder().addComponents(verifyButton);
            await channel.send({
                content: `Welcome ${member.toString()}! Please accept the server rules to gain access to the rest of the server.`,
                components: [row]
            });
            logger_1.default.info(`Sent verification prompt for ${member.user.tag}.`, { guildId, category: 'join-gate' });
            return;
        }
        // If verification is disabled, proceed with violation checks
        if (config.action === 'none')
            return;
        let violationReason = null;
        if (config.block_default_avatar && member.user.avatar === null) {
            violationReason = 'Account has a default Discord avatar.';
        }
        if (!violationReason && config.min_account_age_days > 0) {
            const accountAgeDays = (Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24);
            if (accountAgeDays < config.min_account_age_days) {
                violationReason = `Account is too new (created ${accountAgeDays.toFixed(1)} days ago, minimum is ${config.min_account_age_days}).`;
            }
        }
        if (violationReason) {
            logger_1.default.warn(`User ${member.user.tag} flagged. Reason: ${violationReason}`, { guildId, category: 'join-gate' });
            await takeAction(member, config, violationReason);
        }
    }
    catch (error) {
        logger_1.default.error('Error in join-gate processNewMember.', { guildId, category: 'join-gate', error: error.stack });
    }
}
async function takeAction(member, config, reason) {
    const guildId = member.guild.id;
    try {
        await member.send(`You were automatically removed from **${member.guild.name}** for the following reason: \n*${reason}*`).catch(() => { });
        switch (config.action) {
            case 'timeout':
                if (member.moderatable && config.action_duration_minutes) {
                    await member.timeout(config.action_duration_minutes * 60 * 1000, `Join Gate: ${reason}`);
                }
                break;
            case 'kick':
                if (member.kickable) {
                    await member.kick(`Join Gate: ${reason}`);
                }
                break;
            case 'ban':
                if (member.bannable) {
                    await member.ban({ reason: `Join Gate: ${reason}` });
                }
                break;
        }
    }
    catch (e) {
        logger_1.default.error(`Failed to ${config.action} member.`, { guildId, category: 'join-gate', error: e.stack });
    }
}
function invalidateJoinGateCache(guildId) {
    configCache.delete(guildId);
}
