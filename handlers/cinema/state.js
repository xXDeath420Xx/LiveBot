// handlers/cinema/state.js
import pool from '../../utils/db.js';
import { PermissionFlagsBits } from 'discord.js';

/** Pure: may this member operate playback controls? */
export function canControl(member, state, config) {
  if (!member || !state) return false;
  if (member.id === state.started_by) return true;
  if (config?.control_role_id && member.roles.cache.has(config.control_role_id)) return true;
  return member.permissions?.has?.(PermissionFlagsBits.ManageGuild) === true;
}

export async function getConfig(guildId) {
  const [rows] = await pool.execute('SELECT * FROM cinema_config WHERE guild_id = ?', [guildId]);
  return rows[0] || null;
}

export async function getActiveState() {
  const [rows] = await pool.execute('SELECT * FROM cinema_state WHERE id = 1');
  return rows[0] || null;
}

export async function setPanelMessageId(messageId) {
  await pool.execute('UPDATE cinema_state SET panel_message_id = ? WHERE id = 1', [messageId]);
}
