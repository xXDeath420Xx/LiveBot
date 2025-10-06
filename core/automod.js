const db = require('../utils/db');
const logger = require('../utils/logger');
const { logInfraction } = require('./moderation-manager');

const rulesCache = new Map();
setInterval(() => rulesCache.clear(), 5 * 60 * 1000);

// In-memory cache to track user message timestamps for spam detection
const spamCache = new Map();
// Clean up old spam entries every 5 minutes to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of spamCache.entries()) {
        const recentTimestamps = timestamps.filter(ts => now - ts < 60000); // Keep timestamps from the last minute
        if (recentTimestamps.length > 0) {
            spamCache.set(key, recentTimestamps);
        } else {
            spamCache.delete(key);
        }
    }
}, 5 * 60 * 1000);

async function processMessage(message) {
    if (!message.guild || message.author.bot) return;

    let rules = rulesCache.get(message.guild.id);
    if (!rules) {
        const [dbRules] = await db.execute('SELECT * FROM automod_rules WHERE guild_id = ? AND is_enabled = 1', [message.guild.id]);
        rules = dbRules;
        rulesCache.set(message.guild.id, rules);
    }

    if (rules.length === 0) return;
    
    const ignoredRoles = rules.flatMap(r => r.ignored_roles ? JSON.parse(r.ignored_roles) : []);
    if (message.member.roles.cache.some(role => ignoredRoles.includes(role.id))) return;

    for (const rule of rules) {
        const ruleIgnoredChannels = rule.ignored_channels ? JSON.parse(rule.ignored_channels) : [];
        if (ruleIgnoredChannels.includes(message.channel.id)) continue;

        let triggered = false;
        const config = rule.config ? JSON.parse(rule.config) : {};
        let reason = `Automod: Triggered '${rule.filter_type}' rule.`;

        switch (rule.filter_type) {
            case 'bannedWords':
                const words = config.banned_words || [];
                if (words.some(word => message.content.toLowerCase().includes(word.toLowerCase()))) triggered = true;
                break;
            case 'discordInvites':
                if (/(discord\.(gg|io|me|li)\/.+|discordapp\.com\/invite\/.+)/i.test(message.content)) triggered = true;
                break;
            case 'massMention':
                if (message.mentions.users.size >= (config.limit || 5)) triggered = true;
                break;
            case 'allCaps':
                const content = message.content.replace(/<a?:.+?:\d+>|[^a-zA-Z]/g, '');
                if (content.length < 15) break;
                const upperCaseCount = (content.match(/[A-Z]/g) || []).length;
                if ((upperCaseCount / content.length) * 100 >= (config.limit || 70)) triggered = true;
                break;
            case 'antiSpam': // New Anti-Spam logic
                const userKey = `${message.guild.id}:${message.author.id}`;
                const timestamps = spamCache.get(userKey) || [];
                const now = Date.now();
                
                timestamps.push(now);
                // Keep only timestamps from the last `time_period` seconds
                const timePeriod = (config.time_period || 10) * 1000;
                const recentTimestamps = timestamps.filter(ts => now - ts < timePeriod);
                spamCache.set(userKey, recentTimestamps);

                const messageLimit = config.message_limit || 5;
                if (recentTimestamps.length >= messageLimit) {
                    triggered = true;
                    reason = `Automod: Spam detected (${recentTimestamps.length} messages in ${config.time_period || 10}s).`;
                }
                break;
        }

        if (triggered) {
            await takeAction(message, rule, reason);
            // If the action was spam, we also want to delete the spamming messages
            if (rule.filter_type === 'antiSpam') {
                const userKey = `${message.guild.id}:${message.author.id}`;
                spamCache.delete(userKey); // Reset the user's spam count
                const messages = await message.channel.messages.fetch({ limit: 10 });
                const userMessages = messages.filter(m => m.author.id === message.author.id);
                message.channel.bulkDelete(userMessages).catch(() => {});
            }
            return;
        }
    }
}

async function takeAction(message, rule, reason) {
    try {
        // ... (existing takeAction logic, just passing the dynamic reason)
    } catch (error) {
        logger.error(`[Automod] Failed to take action for rule ${rule.id}:`, error);
    }
}

module.exports = { processMessage };