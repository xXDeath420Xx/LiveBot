// handlers/cinema/state.js
import pool from '../../utils/db.js';
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { getConfig as getFeatureConfig } from '../../core/feature-config.js';

/** Pure: may this member operate playback controls? */
export function canControl(member, state, config) {
  if (!member || !state) return false;
  if (member.id === state.started_by) return true;
  if (config?.control_role_id && member.roles.cache.has(config.control_role_id)) return true;
  return member.permissions?.has?.(PermissionFlagsBits.ManageGuild) === true;
}

// The Go Live stream (the CertiFried-Cinema selfbot) was retired on 2026-11-20: every server plays films with Watch
// Together (the Discord Activity), whatever an old row's watch_mode says.
export async function getConfig(guildId) {
  const [rows] = await pool.execute('SELECT * FROM cinema_config WHERE guild_id = ?', [guildId]);
  return rows[0] ? { ...rows[0], watch_mode: 'activity' } : null;
}

/**
 * Who may start a watch party, and in which voice channel (Watch party page: "Only this role can
 * start one" and "Default voice channel"; Cinema page: "Default voice channel").
 *
 * - host role: when set, only members with it (or Manage Server) can start playback.
 * - voice channel: the starter's own voice channel; when they are not in one, the Cinema page's
 *   default voice channel, else the Watch party page's. A default must still be a voice channel
 *   in this server.
 *
 * Pure apart from the two config reads; `configs` can be passed in (tests, or a caller that has them).
 * @returns {Promise<{ok:true, vc:import('discord.js').VoiceChannel, usedDefault:boolean} | {ok:false, error:string}>}
 */
export async function resolveWatchPartyStart(member, guild, configs = null) {
  const cinemaCfg = configs?.cinema !== undefined ? configs.cinema : await getConfig(guild.id);
  const partyCfg = configs?.jellyfin !== undefined ? configs.jellyfin : await getFeatureConfig('jellyfin', guild.id);

  const hostRoleId = partyCfg?.host_role_id ? String(partyCfg.host_role_id) : null;
  if (hostRoleId && guild.roles?.cache?.has?.(hostRoleId)) {
    const isHost = member?.roles?.cache?.has?.(hostRoleId);
    const isManager = member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) === true;
    if (!isHost && !isManager) {
      return { ok: false, error: `Only members with the <@&${hostRoleId}> role can start a watch party here.` };
    }
  }

  const own = member?.voice?.channel;
  if (own) {
    if (own.type !== ChannelType.GuildVoice) return { ok: false, error: 'Join a voice channel (not a stage) first.' };
    return { ok: true, vc: own, usedDefault: false };
  }
  for (const id of [cinemaCfg?.default_vc_id, partyCfg?.voice_channel_id]) {
    if (!id) continue;
    const ch = guild.channels?.cache?.get?.(String(id));
    if (ch && ch.type === ChannelType.GuildVoice) return { ok: true, vc: ch, usedDefault: true };
  }
  return { ok: false, error: 'Join a voice channel first.' };
}

export async function getActiveState() {
  const [rows] = await pool.execute('SELECT * FROM cinema_state WHERE id = 1');
  return rows[0] || null;
}

export async function setPanelMessageId(messageId) {
  await pool.execute('UPDATE cinema_state SET panel_message_id = ? WHERE id = 1', [messageId]);
}
