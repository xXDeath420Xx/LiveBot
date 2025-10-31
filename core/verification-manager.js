"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
class VerificationManager {
    constructor(client) {
        this.client = client;
        this.pendingVerifications = new Map();
        logger_1.default.info('[VerificationManager] Verification manager initialized');
    }
    async getConfig(guildId) {
        try {
            const [[config]] = await db_1.default.execute('SELECT * FROM verification_config WHERE guild_id = ?', [guildId]);
            return config || null;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[VerificationManager] Failed to get config: ${errorMessage}`, { guildId, error: errorMessage });
            return null;
        }
    }
    async handleMemberJoin(member) {
        try {
            const config = await this.getConfig(member.guild.id);
            if (!config || !config.enabled)
                return;
            const accountAge = Date.now() - member.user.createdTimestamp;
            const requiredAge = config.require_account_age * 24 * 60 * 60 * 1000;
            if (config.require_account_age > 0 && accountAge < requiredAge) {
                const accountDays = Math.floor(accountAge / 86400000);
                await member.kick(`Account too new (${accountDays} days old, required ${config.require_account_age} days)`);
                logger_1.default.info(`[VerificationManager] Kicked ${member.user.tag} - account too new`, { guildId: member.guild.id, userId: member.id });
                return;
            }
            if (config.unverified_role_id) {
                const role = member.guild.roles.cache.get(config.unverified_role_id);
                if (role)
                    await member.roles.add(role);
            }
            if (config.method === 'button') {
                await this.sendButtonVerification(member, config);
            }
            else if (config.method === 'reaction') {
                await this.sendReactionVerification(member, config);
            }
            else if (config.method === 'dm_code') {
                await this.sendDMCodeVerification(member, config);
            }
            else if (config.method === 'captcha') {
                await this.sendCaptchaVerification(member, config);
            }
            await db_1.default.execute('INSERT INTO pending_verifications (user_id, guild_id, verification_code, joined_at) VALUES (?, ?, ?, NOW())', [member.id, member.guild.id, this.generateCode()]);
            if (config.kick_timeout > 0) {
                setTimeout(async () => {
                    await this.checkAndKickUnverified(member, config);
                }, config.kick_timeout * 1000);
            }
            logger_1.default.info(`[VerificationManager] Started verification for ${member.user.tag}`, { guildId: member.guild.id, userId: member.id, method: config.method });
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[VerificationManager] Failed to handle member join: ${errorMessage}`, { guildId: member.guild.id, userId: member.id, error: errorMessage });
        }
    }
    async sendButtonVerification(member, config) {
        const channel = member.guild.channels.cache.get(config.verification_channel_id);
        if (!channel)
            return;
        const embed = new discord_js_1.EmbedBuilder()
            .setColor('#3498db')
            .setTitle('Welcome to ' + member.guild.name)
            .setDescription(config.verification_message || 'Please click the button below to verify yourself and gain access to the server.')
            .setFooter({ text: 'Click the button within ' + (config.kick_timeout || 300) + ' seconds' });
        const row = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId('verify_' + member.id).setLabel('Verify').setStyle(discord_js_1.ButtonStyle.Success).setEmoji('✅'));
        await channel.send({ content: `<@${member.id}>`, embeds: [embed], components: [row] });
    }
    async sendReactionVerification(member, config) {
        const channel = member.guild.channels.cache.get(config.verification_channel_id);
        if (!channel)
            return;
        const embed = new discord_js_1.EmbedBuilder()
            .setColor('#3498db')
            .setTitle('Welcome to ' + member.guild.name)
            .setDescription(config.verification_message || 'Please react with ✅ to verify yourself.')
            .setFooter({ text: 'React within ' + (config.kick_timeout || 300) + ' seconds' });
        const message = await channel.send({ content: `<@${member.id}>`, embeds: [embed] });
        await message.react('✅');
        this.pendingVerifications.set(member.id, { messageId: message.id, guildId: member.guild.id });
    }
    async sendDMCodeVerification(member, config) {
        const code = this.generateCode();
        await db_1.default.execute('UPDATE pending_verifications SET verification_code = ? WHERE user_id = ? AND guild_id = ?', [code, member.id, member.guild.id]);
        try {
            await member.send({
                embeds: [new discord_js_1.EmbedBuilder()
                        .setColor('#3498db')
                        .setTitle('Verification Required')
                        .setDescription(`Welcome to **${member.guild.name}**!\n\nYour verification code is: \`${code}\`\n\nPlease send this code in the verification channel to gain access.`)]
            });
        }
        catch (error) {
            logger_1.default.warn(`[VerificationManager] Could not DM ${member.user.tag}`, { guildId: member.guild.id, userId: member.id });
        }
    }
    async sendCaptchaVerification(member, config) {
        const num1 = Math.floor(Math.random() * 10);
        const num2 = Math.floor(Math.random() * 10);
        const answer = num1 + num2;
        await db_1.default.execute('UPDATE pending_verifications SET verification_code = ? WHERE user_id = ? AND guild_id = ?', [answer.toString(), member.id, member.guild.id]);
        const channel = member.guild.channels.cache.get(config.verification_channel_id);
        if (!channel)
            return;
        const embed = new discord_js_1.EmbedBuilder()
            .setColor('#3498db')
            .setTitle('Math Verification')
            .setDescription(`${member}, please solve: **${num1} + ${num2} = ?**\n\nType your answer in this channel within ${config.kick_timeout || 300} seconds.`)
            .setFooter({ text: 'Answer with just the number' });
        await channel.send({ embeds: [embed] });
    }
    async verifyMember(member, config) {
        try {
            if (config.unverified_role_id) {
                const unverifiedRole = member.guild.roles.cache.get(config.unverified_role_id);
                if (unverifiedRole && member.roles.cache.has(config.unverified_role_id)) {
                    await member.roles.remove(unverifiedRole);
                }
            }
            if (config.verified_role_id) {
                const verifiedRole = member.guild.roles.cache.get(config.verified_role_id);
                if (verifiedRole)
                    await member.roles.add(verifiedRole);
            }
            await db_1.default.execute('DELETE FROM pending_verifications WHERE user_id = ? AND guild_id = ?', [member.id, member.guild.id]);
            this.pendingVerifications.delete(member.id);
            logger_1.default.info(`[VerificationManager] Verified ${member.user.tag}`, { guildId: member.guild.id, userId: member.id });
            return true;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[VerificationManager] Failed to verify member: ${errorMessage}`, { guildId: member.guild.id, userId: member.id, error: errorMessage });
            return false;
        }
    }
    async checkAndKickUnverified(member, config) {
        try {
            const [[pending]] = await db_1.default.execute('SELECT * FROM pending_verifications WHERE user_id = ? AND guild_id = ?', [member.id, member.guild.id]);
            if (pending) {
                await member.kick('Failed to verify within time limit');
                await db_1.default.execute('DELETE FROM pending_verifications WHERE user_id = ? AND guild_id = ?', [member.id, member.guild.id]);
                logger_1.default.info(`[VerificationManager] Kicked ${member.user.tag} - verification timeout`, { guildId: member.guild.id, userId: member.id });
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[VerificationManager] Failed to kick unverified: ${errorMessage}`, { guildId: member.guild.id, userId: member.id, error: errorMessage });
        }
    }
    generateCode() {
        return Math.random().toString(36).substring(2, 8).toUpperCase();
    }
    async handleButtonInteraction(interaction) {
        if (!interaction.customId.startsWith('verify_'))
            return false;
        const userId = interaction.customId.split('_')[1];
        if (interaction.user.id !== userId) {
            await interaction.reply({ content: '❌ This verification is not for you.', ephemeral: true });
            return true;
        }
        const config = await this.getConfig(interaction.guild.id);
        if (!config) {
            await interaction.reply({ content: '❌ Verification not configured.', ephemeral: true });
            return true;
        }
        const success = await this.verifyMember(interaction.member, config);
        if (success) {
            await interaction.reply({ content: '✅ You have been verified! Welcome to the server.', ephemeral: true });
            await interaction.message.delete().catch(() => { });
        }
        else {
            await interaction.reply({ content: '❌ Verification failed. Please contact a moderator.', ephemeral: true });
        }
        return true;
    }
}
exports.default = VerificationManager;
