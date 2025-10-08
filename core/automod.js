const db = require('../utils/db');
const logger = require('../utils/logger');
const { logInfraction } = require('./moderation-manager');

// Caches for configs and user heat levels
const rulesCache = new Map();
const heatConfigCache = new Map();
const heatCache = new Map(); // Stores { score: number, infractions: [{ timestamp: number, heat: number }] }

// Clear config caches periodically
setInterval(() => {
    rulesCache.clear();
    heatConfigCache.clear();
}, 5 * 60 * 1000);

async function processMessage(message) {
    if (!message.guild || message.author.bot) return;

    const guildId = message.guild.id;

    // Fetch and cache heat config
    let heatConfig = heatConfigCache.get(guildId);
    if (heatConfig === undefined) {
        const [[dbConfig]] = await db.execute('SELECT * FROM automod_heat_config WHERE guild_id = ?', [guildId]);
        heatConfig = dbConfig || null;
        heatConfigCache.set(guildId, heatConfig);
    }

    // If heat system is disabled, do nothing.
    if (!heatConfig || !heatConfig.is_enabled) return;

    // Fetch and cache automod rules
    let rules = rulesCache.get(guildId);
    if (rules === undefined) {
        const [dbRules] = await db.execute('SELECT * FROM automod_rules WHERE guild_id = ? AND is_enabled = 1', [guildId]);
        rules = dbRules || [];
        rulesCache.set(guildId, rules);
    }

    if (rules.length === 0) return;

    // Check for ignored roles
    const ignoredRoles = rules.flatMap(r => r.ignored_roles ? JSON.parse(r.ignored_roles) : []);
    if (message.member.roles.cache.some(role => ignoredRoles.includes(role.id))) return;

    const heatValues = JSON.parse(heatConfig.heat_values || '{}');

    for (const rule of rules) {
        const ruleIgnoredChannels = rule.ignored_channels ? JSON.parse(rule.ignored_channels) : [];
        if (ruleIgnoredChannels.includes(message.channel.id)) continue;

        let violationType = null;
        const config = rule.config ? JSON.parse(rule.config) : {};

        switch (rule.filter_type) {
            case 'bannedWords':
                if ((config.banned_words || []).some(word => message.content.toLowerCase().includes(word.toLowerCase()))) violationType = 'bannedWords';
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

async function addHeat(message, heat, reason) {
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
    const actionThresholds = JSON.parse(heatConfig.action_thresholds || '[]').sort((a, b) => b.threshold - a.threshold);

    for (const action of actionThresholds) {
        if (userData.score >= action.threshold) {
            logger.warn(`${message.author.tag} crossed heat threshold of ${action.threshold}. Taking action: ${action.type}`, { guildId, category: 'automod-heat' });
            await takeHeatAction(message, action);
            heatCache.delete(userKey); // Reset heat after action
            return;
        }
    }
}

async function takeHeatAction(message, action) {
    const reason = `Automod: Reached heat threshold of ${action.threshold}.`;
    try {
        switch (action.type) {
            case 'warn':
                // Using logInfraction will DM the user and log it.
                await logInfraction({ guild: message.guild, user: { tag: 'Automod', id: message.client.user.id } }, message.author, 'Warn', reason);
                break;
            case 'mute':
                if (message.member.moderatable) {
                    await message.member.timeout(action.duration * 60 * 1000, reason);
                    await logInfraction({ guild: message.guild, user: { tag: 'Automod', id: message.client.user.id } }, message.author, 'Mute', reason, action.duration);
                }
                break;
            case 'kick':
                if (message.member.kickable) {
                    await message.member.kick(reason);
                    await logInfraction({ guild: message.guild, user: { tag: 'Automod', id: message.client.user.id } }, message.author, 'Kick', reason);
                }
                break;
            case 'ban':
                if (message.member.bannable) {
                    await message.member.ban({ reason });
                    await logInfraction({ guild: message.guild, user: { tag: 'Automod', id: message.client.user.id } }, message.author, 'Ban', reason);
                }
                break;
        }
        // Clean up user's recent messages that contributed to the heat
        const messages = await message.channel.messages.fetch({ limit: 20 });
        const userMessages = messages.filter(m => m.author.id === message.author.id);
        message.channel.bulkDelete(userMessages).catch(() => {});

    } catch (error) {
        logger.error(`[Automod-Heat] Failed to take action '${action.type}' on ${message.author.tag}:`, error);
    }
}

module.exports = { processMessage };
