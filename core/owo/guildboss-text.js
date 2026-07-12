/*
 * OwO guild boss — announcement rendering. CC-BY-NC-SA-4.0 derivative.
 *
 * Reproduces the message OwO actually posted (captured in Kabster's #owo-game): a title, a Top-10
 * damage board, an HP bar, and a rewards line carrying the runs-away timer plus fighter/defeated
 * counts. Three static buttons — inspect, leaderboard, fight — so they keep working on old messages
 * (state is resolved from the guild, never baked into the customId).
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { RANK_COLORS } from './catalog.js';
import { getLeaderboard, getBossStats } from './guildboss-service.js';

const BAR_SLOTS = 16;
const pad = (s, n) => String(s).padStart(n, ' ');

/** A text HP bar so the announcement reads at a glance without an image pipeline. */
function hpBar(hp, maxHp) {
  const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  const filled = Math.round(frac * BAR_SLOTS);
  return `\`${'█'.repeat(filled)}${'░'.repeat(BAR_SLOTS - filled)}\` ${hp.toLocaleString()}/${maxHp.toLocaleString()}`;
}

export function bossButtons({ disabled = false } = {}) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('guildboss_inspect').setLabel('Inspect').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('guildboss_leaderboard').setLabel('Leaderboard').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('guildboss_fight').setLabel('Fight!').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  )];
}

/**
 * Build the live boss announcement. Reads the board + stats itself, so a button handler can call
 * this and re-render the same message after every hit.
 * @param {'active'|'defeated'|'fled'} state
 */
export async function renderBoss(boss, state = 'active') {
  const board = await getLeaderboard(boss.guildId, 10);
  const stats = await getBossStats(boss.guildId);

  const title = state === 'defeated' ? `${boss.emoji} The Guild Boss was defeated!`
    : state === 'fled' ? `${boss.emoji} The Guild Boss ran away...`
      : `${boss.emoji} A Guild Boss Appeared!`;

  const lines = [`**Lv. ${boss.level} ${boss.emoji}**`, hpBar(state === 'defeated' ? 0 : boss.hp, boss.maxHp), ''];

  lines.push('**Top 10 Damage Dealt**');
  if (board.length) {
    lines.push('`Rank`  `  Damage`  `Fighter`');
    for (const e of board) {
      const mark = e.defeated ? ' 💀' : '';
      lines.push(`\`${pad(e.rank, 2)}  \` \`${pad(e.damage.toLocaleString(), 8)}\` <@${e.userId}>${mark}`);
    }
  } else {
    lines.push('*Nobody has landed a hit yet. Be the first!*');
  }

  const runsAt = Math.floor(new Date(boss.expiresAt).getTime() / 1000);
  const footer = state === 'active'
    ? `⏳ runs away <t:${runsAt}:R>  ·  ⚔️ ${stats.fighters} fighter${stats.fighters === 1 ? '' : 's'}  ·  💀 ${stats.defeated} defeated`
    : state === 'defeated'
      ? `💥 Beaten by ${stats.fighters} fighter${stats.fighters === 1 ? '' : 's'} — rewards paid out by damage dealt.`
      : `🏳️ It fled after ${stats.fighters} fighter${stats.fighters === 1 ? '' : 's'} · 💀 ${stats.defeated} defeated. Nobody finished it.`;
  lines.push('', `-# ${footer}`);

  const embed = new EmbedBuilder()
    .setColor(RANK_COLORS[boss.rank] ?? 0xF44336)
    .setTitle(title)
    .setDescription(lines.join('\n'));

  return { embeds: [embed], components: bossButtons({ disabled: state !== 'active' }) };
}
