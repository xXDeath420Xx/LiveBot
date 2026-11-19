/*
 * Word Games page settings that act on finished games (feature key 'wordgames'):
 *
 *   announce_channel_id  "Announce results in": every finished game (a solved or failed Coordle,
 *                        a completed WordSeek grid, a Last Letter chain or One Word Story that is
 *                        ended, and any game stopped with /wordgame ... end or disable) is posted
 *                        there. Nothing is copied into the game's own channel, which already shows it.
 *   leaderboard_role_id  "Award role to the leader": held by whoever is first on each game's
 *                        /wordgame <game> leaderboard (same ordering as that command), so at most one
 *                        member per game. It moves when first place changes. Roles the bot cannot
 *                        manage (above its own highest role, or integration roles) are skipped and logged.
 *
 * The role is re-checked when a result is announced and, throttled, after stats change.
 */
import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getConfig } from './feature-config.js';
import { onStatsChanged } from './word-game-manager.js';

export const GAME_LABELS = {
  last_letter: 'Last Letter',
  one_word_story: 'One Word Story',
  coordle: 'Coordle',
  wordseek: 'WordSeek',
};

const SNOWFLAKE = /^\d{17,20}$/;
const ROLE_REFRESH_DELAY_MS = 60_000;
const MEMBER_FETCH_EVERY_MS = 10 * 60_000;

const pendingRefresh = new Map();   // guildId -> timeout
const lastMemberFetch = new Map();  // guildId -> ms

function clientFor(guildId, client) {
  const c = client?.guilds?.cache?.has(guildId) ? client : global.botManager?.getClientForGuild?.(guildId);
  return c?.guilds?.cache?.has(guildId) ? c : null;
}

/** "<@a> (5), <@b> (3)" for the biggest counts in { userId: count }. */
export function topList(counts, n = 3) {
  return Object.entries(counts || {})
    .filter(([id, c]) => SNOWFLAKE.test(id) && c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, c]) => `<@${id}> (${c})`)
    .join(', ');
}

/** Contributions per member for a One Word Story state (entries carry authorId). */
export function storyCounts(state) {
  const counts = {};
  for (const e of state?.entries || []) if (e.authorId) counts[e.authorId] = (counts[e.authorId] || 0) + 1;
  return counts;
}

/**
 * The result post for a finished game. `outcome`: 'won' | 'lost' | 'complete' | 'ended'.
 * `story` is the rendered text for One Word Story; `solverId` the member who solved a Coordle.
 */
export function resultEmbed(gameType, state, { outcome = 'ended', solverId = null, story = null, channelId = null } = {}) {
  const label = GAME_LABELS[gameType] || gameType;
  const embed = new EmbedBuilder().setColor(outcome === 'lost' ? 0xED4245 : 0x57F287).setTimestamp();
  const where = channelId ? ` in <#${channelId}>` : '';
  let text = '';
  if (gameType === 'last_letter') {
    embed.setTitle(`${label} — chain finished`);
    text = `The chain${where} reached **${state?.count || 0}** word${state?.count === 1 ? '' : 's'}.`;
    const top = topList(state?.byUser);
    if (top) text += `\nMost words: ${top}`;
  } else if (gameType === 'one_word_story') {
    const words = state?.words?.length || 0;
    embed.setTitle(`${label} — finished`);
    text = `${(story || '*(no words were added)*').slice(0, 3500)}\n\n**${words}** word${words === 1 ? '' : 's'}${where}.`;
    const top = topList(storyCounts(state));
    if (top) text += `\nMost words: ${top}`;
  } else if (gameType === 'coordle') {
    const answer = String(state?.answer || '').toUpperCase();
    const used = state?.guesses?.length || 0;
    if (outcome === 'won') {
      embed.setTitle(`${label} — solved`);
      text = `Solved${where} in **${used}/${state?.maxGuesses || 6}** — the word was **${answer}**.${solverId ? ` Final guess by <@${solverId}>.` : ''}`;
    } else if (outcome === 'lost') {
      embed.setTitle(`${label} — out of guesses`);
      text = `Nobody got it${where} — the word was **${answer}**.`;
    } else {
      embed.setTitle(`${label} — ended`);
      text = `Ended${where} after ${used} guess${used === 1 ? '' : 'es'} — the word was **${answer}**.`;
    }
    const players = state?.participants?.length || 0;
    if (players) text += `\n${players} player${players === 1 ? '' : 's'} took part.`;
  } else if (gameType === 'wordseek') {
    const words = state?.words || [];
    const found = state?.found || [];
    if (outcome === 'complete') {
      embed.setTitle(`${label} — all words found`);
      text = `All ${words.length} words found${where}: ${words.map(w => w.toUpperCase()).join(', ')}.`;
    } else {
      embed.setTitle(`${label} — ended`);
      text = `Ended${where} with ${found.length} of ${words.length} words found. The words were: ${words.map(w => w.toUpperCase()).join(', ')}.`;
    }
    const top = topList(state?.byUser);
    if (top) text += `\nMost finds: ${top}`;
  } else {
    embed.setTitle(`${label} — finished`);
  }
  if (text) embed.setDescription(text.slice(0, 4096));
  return embed;
}

/**
 * Post a finished game's result in the "Announce results in" channel, then re-check the leader role.
 * Never throws: a result post is a side effect of the game.
 */
export async function announceResult({ client, guildId, sourceChannelId, embed }) {
  let posted = false;
  try {
    const c = clientFor(guildId, client);
    const cfg = await getConfig('wordgames', guildId);
    const id = SNOWFLAKE.test(String(cfg.announce_channel_id || '')) ? String(cfg.announce_channel_id) : null;
    if (c && id && id !== sourceChannelId) {
      const channel = c.channels.cache.get(id) || await c.channels.fetch(id).catch(() => null);
      if (channel?.isTextBased?.() && channel.guildId === guildId) {
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        posted = true;
      }
    }
  } catch (err) {
    logger.warn('[WordGames] Could not announce a result', { guildId, error: err.message });
  }
  await refreshLeaderRole(guildId, client).catch(err => logger.warn('[WordGames] Leader role refresh failed', { guildId, error: err.message }));
  return posted;
}

/** First place on each game's leaderboard (same ORDER BY as getLeaderboard). */
export async function currentLeaders(guildId) {
  const [rows] = await pool.execute(
    `SELECT s.game_type, s.user_id FROM word_game_stats s
      WHERE s.guild_id = ?
        AND s.user_id = (SELECT t.user_id FROM word_game_stats t
                          WHERE t.guild_id = s.guild_id AND t.game_type = s.game_type
                            AND (t.best_score > 0 OR t.words_contributed > 0 OR t.wins > 0)
                          ORDER BY t.best_score DESC, t.words_contributed DESC LIMIT 1)`,
    [guildId]
  );
  const leaders = new Map();
  for (const r of rows) leaders.set(r.game_type, r.user_id);
  return leaders;
}

/**
 * Give the leader role to every game's current leader and take it from anyone else.
 * Returns a short status string (used by tests and logs).
 */
export async function refreshLeaderRole(guildId, client = null) {
  const cfg = await getConfig('wordgames', guildId);
  const roleId = SNOWFLAKE.test(String(cfg.leaderboard_role_id || '')) ? String(cfg.leaderboard_role_id) : null;
  if (!roleId) return 'off';
  const c = clientFor(guildId, client);
  const guild = c?.guilds?.cache?.get(guildId);
  if (!guild) return 'no-guild';
  const role = guild.roles.cache.get(roleId);
  if (!role) return 'no-role';
  if (role.managed || !role.editable) {
    logger.warn(`[WordGames] Leader role ${roleId} in ${guildId} is above the bot's highest role or not assignable; skipping`);
    return 'not-editable';
  }

  const leaders = new Set((await currentLeaders(guildId)).values());

  // role.members only covers cached members; refresh the cache now and then so a previous holder
  // who is not cached still loses the role.
  const last = lastMemberFetch.get(guildId) || 0;
  if (Date.now() - last > MEMBER_FETCH_EVERY_MS) {
    lastMemberFetch.set(guildId, Date.now());
    await guild.members.fetch().catch(() => null);
  }

  let added = 0, removed = 0;
  for (const [id, member] of role.members) {
    if (!leaders.has(id)) {
      await member.roles.remove(role, 'Word Games: no longer first on a leaderboard').then(() => removed++)
        .catch(err => logger.warn('[WordGames] Could not remove leader role', { guildId, userId: id, error: err.message }));
    }
  }
  for (const id of leaders) {
    const member = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
    if (!member || member.roles.cache.has(role.id)) continue;
    await member.roles.add(role, 'Word Games: first on a leaderboard').then(() => added++)
      .catch(err => logger.warn('[WordGames] Could not add leader role', { guildId, userId: id, error: err.message }));
  }
  return `ok +${added} -${removed}`;
}

/** Stats change on every move; the role is re-checked at most once a minute per server. */
function scheduleRefresh(guildId) {
  if (pendingRefresh.has(guildId)) return;
  const t = setTimeout(() => {
    pendingRefresh.delete(guildId);
    refreshLeaderRole(guildId).catch(err => logger.warn('[WordGames] Leader role refresh failed', { guildId, error: err.message }));
  }, ROLE_REFRESH_DELAY_MS);
  t.unref?.();
  pendingRefresh.set(guildId, t);
}

onStatsChanged(scheduleRefresh);

export default { announceResult, refreshLeaderRole, resultEmbed, currentLeaders, GAME_LABELS };
