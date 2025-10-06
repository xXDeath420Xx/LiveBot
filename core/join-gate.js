const db = require('../utils/db');
const logger = require('../utils/logger');
const configCache = new Map();
async function processNewMember(member) {
const guild = member.guild;

let config = configCache.get(guild.id);
if (config === undefined) {
    const [[dbConfig]] = await db.execute('SELECT * FROM join_gate_config WHERE guild_id = ?', [guild.id]);
    config = dbConfig || null;
    configCache.set(guild.id, config);
    setTimeout(() => configCache.delete(guild.id), 5 * 60 * 1000);
}

if (!config || !config.is_enabled || config.action === 'none') {
    return;
}

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
    logger.warn(`[Join Gate] User ${member.user.tag} flagged in ${guild.name}. Reason: ${violationReason}`);
    await takeAction(member, config, violationReason);
}
}
async function takeAction(member, config, reason) {
await member.send(`You were automatically removed from **${member.guild.name}** for the following reason: \n*${reason}*`).catch(() => {});

switch (config.action) {
    case 'timeout':
        if (member.moderatable && config.action_duration_minutes) {
            await member.timeout(config.action_duration_minutes * 60 * 1000, `Join Gate: ${reason}`).catch(e => logger.error('[Join Gate] Failed to timeout member:', e));
        }
        break;
    case 'kick':
        if (member.kickable) {
            await member.kick(`Join Gate: ${reason}`).catch(e => logger.error('[Join Gate] Failed to kick member:', e));
        }
        break;
    case 'ban':
        if (member.bannable) {
            await member.ban({ reason: `Join Gate: ${reason}` }).catch(e => logger.error('[Join Gate] Failed to ban member:', e));
        }
        break;
}
}
module.exports = {
processNewMember,
invalidateJoinGateCache: (guildId) => configCache.delete(guildId)
};