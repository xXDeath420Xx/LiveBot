import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder } from 'discord.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { contextFromReason, guildTrust } from './global-ban-confidence.js';
import configCache from '../utils/configCache.js';
import { themeColor } from './guild-theme.js';

/** Server-log titles for the infraction types that have a moderation.* log action. */
const FEATURE_LOG_TITLES = {
  Warn: '⚠️ Member Warned',
  Mute: '⏱️ Member Timed Out',
  Unmute: '✅ Timeout Removed',
  Kick: '👢 Member Kicked',
  Ban: '🔨 Member Banned',
  Unban: '🔓 Member Unbanned',
  ClearInfractions: '🧹 Infractions Cleared'
};

/**
 * Every value the `infractions.type` ENUM accepts. The server runs STRICT_TRANS_TABLES, so any other
 * string fails the INSERT outright — which is how `/admin mod warn` (type 'Warning') recorded nothing,
 * posted no mod-log and never fed escalation for as long as it shipped.
 */
export const INFRACTION_TYPES = new Set([
  'Ban', 'Unban', 'Kick', 'Mute', 'Unmute', 'Warn', 'ClearInfractions',
  'RaidDetection', 'SelfbotDetection', 'AdaptiveSpam', 'AntiSpam'
]);

/**
 * Log a moderation action (infraction) to the database and mod log channel
 * @param {CommandInteraction} interaction - The interaction that triggered the moderation action
 * @param {User} user - The user being moderated
 * @param {string} type - Type of infraction; must be one of INFRACTION_TYPES
 * @param {string} reason - Reason for the action
 * @param {number|null} durationMinutes - Duration in minutes (for mutes)
 * @returns {Promise<boolean>} true when the infraction row was saved
 */
export async function logInfraction(interaction, user, type, reason, durationMinutes = null) {
  const guildId = interaction.guild?.id;

  if (!INFRACTION_TYPES.has(type)) {
    logger.error('[ModerationManager] Refusing to record infraction: type is not a value of infractions.type', {
      guildId, userId: user?.id, moderatorId: interaction.user?.id, type
    });
    return false;
  }

  // 1. The record itself. If this fails nothing else is meaningful (no case id, nothing to
  //    escalate on), so say so loudly and tell the caller.
  let caseId = null;
  try {
    const expiresAt = durationMinutes ? new Date(Date.now() + durationMinutes * 60000) : null;
    const inserted = await pool.execute(
      'INSERT INTO infractions (guild_id, user_id, moderator_id, type, reason, duration_minutes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [guildId, user.id, interaction.user.id, type, reason, durationMinutes, expiresAt]
    );
    caseId = inserted?.[0]?.insertId ?? null;
  } catch (error) {
    logger.error('[ModerationManager] FAILED to record infraction — nothing was saved, no mod-log posted, no escalation checked', {
      guildId,
      userId: user?.id,
      moderatorId: interaction.user?.id,
      type,
      code: error.code,
      error: error.message,
      stack: error.stack
    });
    return false;
  }

  // 2. Mod-log post. A missing or broken log channel must not stop escalation below — it used to
  //    `return` here, so guilds without a mod-log channel never escalated at all.
  const modLogChannelId = await postModLog(interaction, user, type, reason, durationMinutes);

  // Server log (core/feature-log.js), skipped when it would land in the mod-log channel just posted to.
  if (FEATURE_LOG_TITLES[type]) {
    void logFeatureEvent(() => (interaction.guild),
      () => (type === 'Warn' ? 'moderation.warn'
        : type === 'Mute' ? 'moderation.mute'
          : type === 'Unmute' ? 'moderation.unmute'
            : type === 'Kick' ? 'moderation.kick'
              : type === 'Ban' ? 'moderation.ban'
                : type === 'Unban' ? 'moderation.unban'
                  : 'moderation.clearInfractions'),
      () => ({
        title: FEATURE_LOG_TITLES[type],
        fields: [
          ['Member', userLabel(user)],
          ['Moderator', userLabel(interaction.user)],
          ['Case', caseId ? `#${caseId}` : null],
          ['Duration', durationMinutes ? `${durationMinutes} minutes` : null],
          ['Reason', reason || 'No reason given', false],
        ],
        avoidChannelIds: [modLogChannelId],
      }));
  }

  // 3. Escalation + cross-guild aggregation (not for reversal actions).
  if (type !== 'Unmute' && type !== 'Unban' && type !== 'ClearInfractions') {
    try {
      // Import escalation checker dynamically to avoid circular dependency
      const { checkEscalations } = await import('./escalation-manager.js');
      await checkEscalations(interaction.guild, user);
    } catch (error) {
      logger.error('[ModerationManager] Escalation check failed', {
        guildId, userId: user.id, type, error: error.message, stack: error.stack
      });
    }

    // Record cross-guild action for global ban auto-aggregation. Automod passes a stand-in
    // interaction without `client`, so fall back to the guild's client.
    const client = interaction.client ?? interaction.guild?.client;
    if (client?.globalBanManager && (type === 'Ban' || type === 'Kick' || type === 'Mute')) {
      try {
        // A stand-in "interaction" whose user is a bot is one of our protections acting; anyone else
        // is staff using a command. The ban event that follows is de-duplicated against this row.
        const automated = !!interaction.user?.bot;
        await client.globalBanManager.recordCrossGuildAction(
          user.id, guildId, type.toLowerCase(), reason, interaction.user.id,
          {
            source: automated ? 'protection' : 'moderator',
            context: automated ? (contextFromReason(reason) || 'automod') : null,
            trust: interaction.guild ? guildTrust({ createdAt: interaction.guild.createdTimestamp, memberCount: interaction.guild.memberCount }) : null,
            ownerId: interaction.guild?.ownerId || null,
          }
        );
      } catch (gbError) {
        logger.error('[ModerationManager] Failed to record global ban aggregate', { error: gbError.message, guildId, userId: user.id });
      }
    }
  }

  logger.info('[ModerationManager] Infraction logged', {
    guildId,
    userId: user.id,
    type,
    moderator: interaction.user.id
  });
  return true;
}

// ── Moderation DMs, protected roles and default durations ──────────────────────────────────────────
// Set on the Moderation page (moderation_config, migration 420; PUT /api/guilds/:id/moderation/messages).
// Every bot moderation command DMs through sendModerationDm and checks protectedRoleFor, so the page's
// settings apply to all of them from here. Read through utils/configCache.js, which the dashboard clears
// when it saves.

/** The DMs the Moderation page can switch off and reword. 'mute' is a Discord timeout. */
export const MOD_DM_ACTIONS = Object.freeze(['warn', 'mute', 'unmute', 'kick', 'ban', 'unban']);
/** Before migration 420 every action but unban sent a DM; a missing column keeps that. */
const MOD_DM_DEFAULT_ON = Object.freeze({ warn: true, mute: true, unmute: true, kick: true, ban: true, unban: false });
export const MOD_DM_TEMPLATE_MAX = 1500;
export const MOD_PROTECTED_ROLES_MAX = 25;
/** Longest default timeout Discord allows (28 days) and longest temporary ban (365 days), in minutes. */
export const MOD_DEFAULT_MUTE_MAX = 28 * 24 * 60;
export const MOD_DEFAULT_BAN_MAX = 365 * 24 * 60;

const MOD_DM_WORDING = Object.freeze({
  warn: { title: 'You have been warned in {server}', past: 'warned', tone: 'warning' },
  mute: { title: 'You have been muted in {server}', past: 'muted', tone: 'danger' },
  unmute: { title: 'You have been unmuted in {server}', past: 'unmuted', tone: 'success' },
  kick: { title: 'You have been kicked from {server}', past: 'kicked', tone: 'warning' },
  ban: { title: 'You have been banned from {server}', past: 'banned', tone: 'danger' },
  unban: { title: 'You have been unbanned from {server}', past: 'unbanned', tone: 'success' },
});

const positiveInt = (value, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= max ? n : null;
};

/** A moderation_config row (or nothing) → the settings every moderation command uses. */
export function normaliseModerationSettings(row) {
  const r = row || {};
  let templates = {};
  try {
    const parsed = typeof r.dm_templates === 'string' ? JSON.parse(r.dm_templates) : (r.dm_templates || {});
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const action of MOD_DM_ACTIONS) {
        const text = typeof parsed[action] === 'string' ? parsed[action].trim() : '';
        if (text) templates[action] = text.slice(0, MOD_DM_TEMPLATE_MAX);
      }
    }
  } catch { templates = {}; }
  let protectedRoleIds = [];
  try {
    const parsed = typeof r.protected_role_ids === 'string' ? JSON.parse(r.protected_role_ids) : (r.protected_role_ids || []);
    if (Array.isArray(parsed)) protectedRoleIds = parsed.map(String).filter(id => /^\d{17,20}$/.test(id));
  } catch { protectedRoleIds = []; }
  const dmOn = {};
  for (const action of MOD_DM_ACTIONS) {
    const value = r[`dm_on_${action}`];
    dmOn[action] = value === undefined || value === null ? MOD_DM_DEFAULT_ON[action] : !!Number(value);
  }
  return {
    dmOn,
    templates,
    showModerator: !!Number(r.dm_show_moderator || 0),
    appealLink: typeof r.appeal_link === 'string' && r.appeal_link.trim() ? r.appeal_link.trim() : null,
    protectedRoleIds,
    defaultMuteMinutes: positiveInt(r.default_mute_minutes, MOD_DEFAULT_MUTE_MAX),
    defaultBanMinutes: positiveInt(r.default_ban_minutes, MOD_DEFAULT_BAN_MAX),
    // The Moderation page's mute role: given for as long as a member is timed out (core/mute-role.js).
    mutedRoleId: /^\d{17,20}$/.test(String(r.muted_role_id ?? '')) ? String(r.muted_role_id) : null,
  };
}

/** A guild's moderation settings. Never throws: on a DB error the old behaviour (defaults) applies. */
export async function getModerationSettings(guildId) {
  if (!guildId) return normaliseModerationSettings(null);
  try {
    return await configCache.get('moderation_messages', String(guildId), async () => {
      const [rows] = await pool.execute('SELECT * FROM moderation_config WHERE guild_id = ?', [String(guildId)]);
      return normaliseModerationSettings(rows[0]);
    });
  } catch (error) {
    logger.warn('[ModerationManager] Could not read moderation settings; using the defaults', { guildId, error: error.message });
    return normaliseModerationSettings(null);
  }
}

/**
 * The protected role a member holds (Moderation page), or null. Bot moderation commands refuse to act on
 * such a member. Someone not in the server holds no roles, so is never protected.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember|import('discord.js').User|string|null} target
 * @returns {Promise<import('discord.js').Role|null>}
 */
export async function protectedRoleFor(guild, target) {
  if (!guild || !target) return null;
  const { protectedRoleIds } = await getModerationSettings(guild.id);
  if (!protectedRoleIds.length) return null;
  const member = target.roles?.cache ? target
    : await guild.members.fetch(String(target.id ?? target)).catch(() => null);
  if (!member) return null;
  for (const id of protectedRoleIds) {
    const role = member.roles.cache.get(id);
    if (role) return role;
  }
  return null;
}

/** 90 → '1 hour 30 minutes'; the two largest units. */
export function describeMinutes(minutes) {
  let left = Math.max(0, Math.round(Number(minutes) || 0));
  if (!left) return '';
  const parts = [];
  for (const [size, word] of [[1440, 'day'], [60, 'hour'], [1, 'minute']]) {
    const n = Math.floor(left / size);
    if (n) { parts.push(`${n} ${word}${n === 1 ? '' : 's'}`); left -= n * size; }
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

/** Fill {user} {server} {action} {reason} {duration} {moderator} {appeal_link} (any case). */
export function renderModerationTemplate(template, vars) {
  return String(template || '').replace(/\{(user|server|action|reason|duration|moderator|appeal_link)\}/gi,
    (_, key) => String(vars[key.toLowerCase()] ?? ''));
}

/**
 * The DM for one action: the server's own text when it wrote one (plain message), otherwise the standard
 * embed. ctx: { guildName, guildId, userName, reason, durationMinutes, permanent, expiresAtMs, moderatorName,
 * moderatorIsBot }.
 */
export function buildModerationDm(action, settings, ctx = {}) {
  const wording = MOD_DM_WORDING[action] || MOD_DM_WORDING.warn;
  const revealModerator = settings.showModerator || ctx.moderatorIsBot;
  const duration = ctx.durationMinutes ? describeMinutes(ctx.durationMinutes) : (ctx.permanent ? 'permanent' : '');
  const vars = {
    user: ctx.userName || 'there',
    server: ctx.guildName || 'the server',
    action: wording.past,
    reason: ctx.reason || 'No reason given',
    duration,
    moderator: revealModerator && ctx.moderatorName ? ctx.moderatorName : 'a moderator',
    appeal_link: settings.appealLink || '',
  };
  const template = settings.templates[action];
  if (template) {
    const content = renderModerationTemplate(template, vars).trim() || renderModerationTemplate(wording.title, vars);
    return { content: content.slice(0, 2000), allowedMentions: { parse: [] } };
  }
  const embed = new EmbedBuilder()
    .setColor(themeColor(ctx.guildId, wording.tone))
    .setTitle(renderModerationTemplate(wording.title, vars).slice(0, 256))
    .addFields({ name: 'Reason', value: vars.reason.slice(0, 1024) })
    .setTimestamp();
  if (ctx.expiresAtMs) {
    const at = Math.floor(ctx.expiresAtMs / 1000);
    embed.addFields({ name: action === 'ban' ? 'Expires' : 'Ends', value: `<t:${at}:f> (<t:${at}:R>)` });
  } else if (duration) {
    embed.addFields({ name: 'Duration', value: duration });
  }
  if (revealModerator && ctx.moderatorName) embed.addFields({ name: 'Moderator', value: String(ctx.moderatorName).slice(0, 1024) });
  if (settings.appealLink && ['warn', 'mute', 'kick', 'ban'].includes(action)) {
    embed.addFields({ name: 'Appeal', value: settings.appealLink.slice(0, 1024) });
  }
  return { embeds: [embed] };
}

/**
 * DM a member about a moderation action, if the server has that DM switched on. Call it BEFORE a kick
 * or ban (afterwards the bot usually shares no server with them and the DM fails). Never throws.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').User} user
 * @param {'warn'|'mute'|'unmute'|'kick'|'ban'|'unban'} action
 * @param {{ reason?: string, durationMinutes?: number, permanent?: boolean, expiresAtMs?: number,
 *           moderator?: import('discord.js').User|{ tag?: string, username?: string, bot?: boolean } }} [details]
 * @returns {Promise<{ sent: boolean, why?: string }>}
 */
export async function sendModerationDm(guild, user, action, details = {}) {
  try {
    if (!guild || !user || user.bot || !MOD_DM_ACTIONS.includes(action)) return { sent: false, why: 'not applicable' };
    const settings = await getModerationSettings(guild.id);
    if (!settings.dmOn[action]) return { sent: false, why: 'switched off' };
    const moderator = details.moderator || null;
    const payload = buildModerationDm(action, settings, {
      guildName: guild.name,
      guildId: guild.id,
      userName: user.globalName || user.username || user.tag,
      reason: details.reason,
      durationMinutes: details.durationMinutes,
      permanent: details.permanent,
      expiresAtMs: details.expiresAtMs,
      moderatorName: moderator ? (moderator.tag || moderator.username || null) : null,
      moderatorIsBot: !!moderator?.bot,
    });
    await user.send(payload);
    return { sent: true };
  } catch (error) {
    logger.warn(`[ModerationManager] Could not DM ${user?.tag || user?.id} about a ${action}: ${error.message}`, { guildId: guild?.id });
    return { sent: false, why: error.message };
  }
}

/**
 * Post the infraction to the guild's mod-log channel, if one is configured.
 * @returns {Promise<string|undefined>} the channel id it posted to, if it posted
 */
async function postModLog(interaction, user, type, reason, durationMinutes) {
  const guildId = interaction.guild?.id;
  try {
    // Get mod log channel
    const [rows] = await pool.execute(
      'SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?',
      [guildId]
    );

    const config = rows[0];
    if (!config || !config.mod_log_channel_id) {
      logger.debug('[ModerationManager] No mod log channel configured for guild', { guildId });
      return;
    }

    // Fetch the log channel
    const logChannel = await interaction.guild.channels.fetch(config.mod_log_channel_id).catch(() => null);
    if (!logChannel || !logChannel.isTextBased()) {
      logger.warn('[ModerationManager] Mod log channel not found or not text-based', {
        guildId,
        channelId: config.mod_log_channel_id
      });
      return;
    }

    // Color coding based on action type
    let color = '#E67E22'; // Default orange for warnings
    if (type === 'Mute') color = '#F1C40F'; // Yellow
    if (type === 'Kick') color = '#E74C3C'; // Red
    if (type === 'Ban') color = '#C0392B'; // Dark red
    if (type === 'Unmute' || type === 'Unban') color = '#2ECC71'; // Green for reversals
    if (type === 'ClearInfractions') color = '#95A5A6'; // Grey for neutral

    // Create log embed
    const logEmbed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: 'Moderation Log' })
      .setTitle(`${type.charAt(0).toUpperCase() + type.slice(1)} Issued`)
      .addFields(
        { name: 'User', value: `${user.tag} (${user.id})`, inline: false },
        { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
        { name: 'Reason', value: reason || 'No reason provided' }
      )
      .setTimestamp();

    if (durationMinutes) {
      logEmbed.addFields({ name: 'Duration', value: `${durationMinutes} minutes` });
    }

    // Send to log channel
    await logChannel.send({ embeds: [logEmbed] });
    return String(config.mod_log_channel_id);
  } catch (error) {
    logger.error('[ModerationManager] Infraction saved but the mod-log post failed', {
      guildId,
      userId: user?.id,
      type,
      error: error.message
    });
  }
}
