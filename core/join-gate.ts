import db from '../utils/db';
import logger from '../utils/logger';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, GuildMember, TextChannel } from 'discord.js';
import { RowDataPacket } from 'mysql2';

interface JoinGateConfig extends RowDataPacket {
    guild_id: string;
    is_enabled: boolean;
    verification_enabled: boolean;
    action: 'none' | 'timeout' | 'kick' | 'ban';
    action_duration_minutes: number | null;
    block_default_avatar: boolean;
    min_account_age_days: number;
}

interface WelcomeConfig extends RowDataPacket {
    channel_id: string | null;
}

const configCache = new Map<string, JoinGateConfig | null>();

async function processNewMember(member: GuildMember): Promise<void> {
    const guild = member.guild;
    const guildId = guild.id;

    try {
        let config = configCache.get(guildId);
        if (config === undefined) {
            const [[dbConfig]] = await db.execute<JoinGateConfig[]>('SELECT * FROM join_gate_config WHERE guild_id = ?', [guildId]);
            config = dbConfig || null;
            configCache.set(guildId, config);
            setTimeout(() => configCache.delete(guildId), 5 * 60 * 1000);
        }

        if (!config || !config.is_enabled) {
            return;
        }

        // Verification flow takes precedence
        if (config.verification_enabled) {
            const [[welcomeConfig]] = await db.execute<WelcomeConfig[]>('SELECT channel_id FROM welcome_settings WHERE guild_id = ?', [guildId]);
            const verificationChannelId = welcomeConfig ? welcomeConfig.channel_id : null;
            if (!verificationChannelId) {
                logger.warn('Join gate verification is enabled, but no welcome/verification channel is set.', { guildId, category: 'join-gate' });
                return;
            }
            const channel = await guild.channels.fetch(verificationChannelId).catch(() => null) as TextChannel | null;
            if (!channel) {
                logger.warn(`Verification channel ${verificationChannelId} not found.`, { guildId, category: 'join-gate' });
                return;
            }

            const verifyButton = new ButtonBuilder()
                .setCustomId(`joingate_verify_${member.id}`)
                .setLabel('Accept Rules & Verify')
                .setStyle(ButtonStyle.Success);

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(verifyButton);

            await channel.send({
                content: `Welcome ${member.toString()}! Please accept the server rules to gain access to the rest of the server.`,
                components: [row]
            });
            logger.info(`Sent verification prompt for ${member.user.tag}.`, { guildId, category: 'join-gate' });
            return;
        }

        // If verification is disabled, proceed with violation checks
        if (config.action === 'none') return;

        let violationReason: string | null = null;

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
            logger.warn(`User ${member.user.tag} flagged. Reason: ${violationReason}`, { guildId, category: 'join-gate' });
            await takeAction(member, config, violationReason);
        }
    } catch (error: any) {
        logger.error('Error in join-gate processNewMember.', { guildId, category: 'join-gate', error: error.stack });
    }
}

async function takeAction(member: GuildMember, config: JoinGateConfig, reason: string): Promise<void> {
    const guildId = member.guild.id;
    try {
        await member.send(`You were automatically removed from **${member.guild.name}** for the following reason: \n*${reason}*`).catch(() => {});

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
    } catch (e: any) {
        logger.error(`Failed to ${config.action} member.`, { guildId, category: 'join-gate', error: e.stack });
    }
}

function invalidateJoinGateCache(guildId: string): void {
    configCache.delete(guildId);
}

export {
    processNewMember,
    invalidateJoinGateCache
};
