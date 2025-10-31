import { Message, GuildMember, User } from 'discord.js';
import db from '../utils/db';
import logger from '../utils/logger';
import { logInfraction } from './moderation-manager';
import { RowDataPacket } from 'mysql2/promise';

interface AutomodRule extends RowDataPacket {
    id: number;
    guild_id: string;
    filter_type: string;
    config: string;
    action: string;
    action_duration_minutes: number | null;
    is_enabled: boolean;
    ignored_channels: string | null;
    ignored_roles: string | null;
}

interface HeatConfig extends RowDataPacket {
    guild_id: string;
    is_enabled: boolean;
    heat_values: string;
    decay_minutes: number;
    action_thresholds: string;
}

interface HeatInfraction {
    timestamp: number;
    heat: number;
}

interface UserHeatData {
    score: number;
    infractions: HeatInfraction[];
}

interface HeatAction {
    threshold: number;
    type: 'warn' | 'mute' | 'kick' | 'ban';
    duration?: number;
}

// Caches for configs and user heat levels
const rulesCache = new Map<string, AutomodRule[]>();
const heatConfigCache = new Map<string, HeatConfig | null>();
const heatCache = new Map<string, UserHeatData>();

// Clear config caches periodically
setInterval(() => {
    rulesCache.clear();
    heatConfigCache.clear();
}, 5 * 60 * 1000);

export async function processMessage(message: Message): Promise<void> {
    if (!message.guild || message.author.bot || !message.member) return;

    const guildId = message.guild.id;

    // Fetch and cache heat config
    let heatConfig = heatConfigCache.get(guildId);
    if (heatConfig === undefined) {
        const [rows] = await db.execute<HeatConfig[]>('SELECT * FROM automod_heat_config WHERE guild_id = ?', [guildId]);
        heatConfig = rows[0] || null;
        heatConfigCache.set(guildId, heatConfig);
    }

    // If heat system is disabled, do nothing.
    if (!heatConfig || !heatConfig.is_enabled) return;

    // Fetch and cache automod rules
    let rules = rulesCache.get(guildId);
    if (rules === undefined) {
        const [dbRules] = await db.execute<AutomodRule[]>('SELECT * FROM automod_rules WHERE guild_id = ? AND is_enabled = 1', [guildId]);
        rules = dbRules || [];
        rulesCache.set(guildId, rules);
    }

    if (rules.length === 0) return;

    // Check for ignored roles
    const ignoredRoles = rules.flatMap(r => r.ignored_roles ? JSON.parse(r.ignored_roles) : []);
    if (message.member.roles.cache.some(role => ignoredRoles.includes(role.id))) return;

    const heatValues: Record<string, number> = JSON.parse(heatConfig.heat_values || '{}');

    for (const rule of rules) {
        const ruleIgnoredChannels: string[] = rule.ignored_channels ? JSON.parse(rule.ignored_channels) : [];
        if (ruleIgnoredChannels.includes(message.channel.id)) continue;

        let violationType: string | null = null;
        const config: Record<string, any> = rule.config ? JSON.parse(rule.config) : {};

        switch (rule.filter_type) {
            case 'bannedWords':
                if ((config.banned_words || []).some((word: string) => message.content.toLowerCase().includes(word.toLowerCase()))) violationType = 'bannedWords';
                break;
            case 'discordInvites':
                if (/(discord\.(gg|io|me|li)\/.+|discordapp\.com\/invite\/.+)/i.test(message.content)) violationType = 'discordInvites';
                break;
            case 'massMention':
                if (message.mentions.users.size >= (config.limit || 5)) violationType = 'massMention';
                break;
            case 'allCaps':
                const content = message.content.replace(/<a?:.+?:\d+>|[^a-zA-Z]/g, '');
                if (content.length >= 15 && ((content.match(/[A-Z]/g) || []).length / content.length) * 100 >= (config.limit || 70)) violationType = 'allCaps';
                break;
            case 'antiSpam':
                // This is better handled as a direct heat addition rather than a rule.
                break;
        }

        if (violationType) {
            const heatToAdd = heatValues[violationType] || 1;
            await addHeat(message, heatToAdd, `Triggered '${violationType}' rule.`);
            return; // Stop processing after one violation
        }
    }
}

async function addHeat(message: Message, heat: number, reason: string): Promise<void> {
    if (!message.guild) return;

    const guildId = message.guild.id;
    const userKey = `${guildId}:${message.author.id}`;

    const heatConfig = heatConfigCache.get(guildId);
    if (!heatConfig) return;

    const decayMinutes = heatConfig.decay_minutes || 10;
    const now = Date.now();
    const decayTime = decayMinutes * 60 * 1000;

    let userData = heatCache.get(userKey) || { score: 0, infractions: [] };

    // Decay old infractions
    userData.infractions = userData.infractions.filter(inf => now - inf.timestamp < decayTime);
    userData.score = userData.infractions.reduce((sum, inf) => sum + inf.heat, 0);

    // Add new heat
    userData.infractions.push({ timestamp: now, heat });
    userData.score += heat;

    heatCache.set(userKey, userData);
    logger.info(`Added ${heat} heat to ${message.author.tag}. New score: ${userData.score}. Reason: ${reason}`, { guildId, category: 'automod-heat' });

    // Check for action thresholds
    const actionThresholds: HeatAction[] = JSON.parse(heatConfig.action_thresholds || '[]').sort((a: HeatAction, b: HeatAction) => b.threshold - a.threshold);

    for (const action of actionThresholds) {
        if (userData.score >= action.threshold) {
            logger.warn(`${message.author.tag} crossed heat threshold of ${action.threshold}. Taking action: ${action.type}`, { guildId, category: 'automod-heat' });
            await takeHeatAction(message, action);
            heatCache.delete(userKey); // Reset heat after action
            return;
        }
    }
}

async function takeHeatAction(message: Message, action: HeatAction): Promise<void> {
    if (!message.guild || !message.member) return;

    const reason = `Automod: Reached heat threshold of ${action.threshold}.`;
    try {
        const moderator: { guild: typeof message.guild; user: { tag: string; id: string } } = {
            guild: message.guild,
            user: { tag: 'Automod', id: message.client.user.id }
        };

        switch (action.type) {
            case 'warn':
                // Using logInfraction will DM the user and log it.
                await logInfraction(moderator, message.author, 'Warn', reason);
                break;
            case 'mute':
                if (message.member.moderatable) {
                    await message.member.timeout((action.duration || 10) * 60 * 1000, reason);
                    await logInfraction(moderator, message.author, 'Mute', reason, action.duration);
                }
                break;
            case 'kick':
                if (message.member.kickable) {
                    await message.member.kick(reason);
                    await logInfraction(moderator, message.author, 'Kick', reason);
                }
                break;
            case 'ban':
                if (message.member.bannable) {
                    await message.member.ban({ reason });
                    await logInfraction(moderator, message.author, 'Ban', reason);
                }
                break;
        }
        // Clean up user's recent messages that contributed to the heat
        const messages = await message.channel.messages.fetch({ limit: 20 });
        const userMessages = messages.filter(m => m.author.id === message.author.id);
        if (message.channel.isTextBased() && 'bulkDelete' in message.channel) {
            await message.channel.bulkDelete(userMessages).catch(() => {});
        }

    } catch (error: unknown) {
        logger.error(`[Automod-Heat] Failed to take action '${action.type}' on ${message.author.tag}:`, { error: error instanceof Error ? error.stack : error });
    }
}
