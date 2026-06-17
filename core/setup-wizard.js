/**
 * Guided /setup wizard — feature registry + step renderer.
 *
 * Each feature exposes: isEnabled(guildId) and enable(guildId, {channelId}). The wizard
 * walks them one at a time; the admin clicks Enable / picks a channel / Skip. Changes are
 * applied immediately (idempotent upserts), so the only "state" is the step index, which
 * lives in the component customIds — no server-side session, restart-safe.
 *
 * Enable SQL is built from the VERIFIED live schemas (see migrations / SHOW COLUMNS), incl.
 * the gotchas: logging logs ALL events when enabled_events is empty; anti_nuke uses
 * action_on_trigger; starboard/welcome/suggestion have no/implicit enabled columns.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType } from 'discord.js';
import pool from '../utils/db.js';

const ACCENT = 0x5865F2;

async function rowExists(sql, guildId) {
  const [r] = await pool.execute(sql, [guildId]);
  return r.length > 0;
}
async function flagOn(table, guildId, col = 'enabled') {
  const [r] = await pool.execute(`SELECT ${col} AS v FROM ${table} WHERE guild_id = ?`, [guildId]);
  return r.length > 0 && Number(r[0].v) === 1;
}

// input: 'channel' (channel required to enable), 'channel_optional' (channel optional),
//        or 'none' (plain on/off). category is for grouping/labels only.
export const FEATURES = [
  {
    key: 'greeting', emoji: '👋', label: 'Welcome & Goodbye', category: 'Engagement', input: 'channel',
    desc: 'Greet new members (and announce departures) in a channel you choose.',
    isEnabled: (g) => rowExists('SELECT 1 FROM welcome_settings WHERE guild_id=? AND channel_id IS NOT NULL', g),
    enable: (g, { channelId }) => pool.execute(
      'INSERT INTO welcome_settings (guild_id, channel_id, message) VALUES (?,?,?) ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id)',
      [g, channelId, 'Welcome {user}! 🎉 Glad to have you.']),
  },
  {
    key: 'leveling', emoji: '📈', label: 'Leveling & XP', category: 'Engagement', input: 'channel_optional',
    desc: 'Members earn XP for chatting and level up. Pick a level-up announcement channel, or leave blank to announce in-channel.',
    isEnabled: (g) => flagOn('level_config', g),
    enable: (g, { channelId }) => pool.execute(
      'INSERT INTO level_config (guild_id, enabled, level_up_channel_id) VALUES (?,1,?) ON DUPLICATE KEY UPDATE enabled=1, level_up_channel_id=COALESCE(VALUES(level_up_channel_id), level_up_channel_id)',
      [g, channelId || null]),
  },
  {
    key: 'logging', emoji: '📝', label: 'Server Logging', category: 'Moderation', input: 'channel',
    desc: 'Audit log of message edits/deletes, joins/leaves, role & channel changes. Logs all events by default.',
    isEnabled: (g) => flagOn('logging_config', g),
    enable: (g, { channelId }) => pool.execute(
      "INSERT INTO logging_config (guild_id, log_channel_id, enabled_events, enabled) VALUES (?,?,'[]',1) ON DUPLICATE KEY UPDATE log_channel_id=VALUES(log_channel_id), enabled=1",
      [g, channelId]),
  },
  {
    key: 'automod', emoji: '🛡️', label: 'AutoMod (spam filter)', category: 'Moderation', input: 'none',
    desc: 'Auto-delete spam. Adds a default spam rule you can fine-tune later on the dashboard.',
    isEnabled: (g) => rowExists('SELECT 1 FROM automod_rules WHERE guild_id=? AND is_enabled=1', g),
    enable: async (g) => {
      const [r] = await pool.execute("SELECT id FROM automod_rules WHERE guild_id=? AND filter_type='spam'", [g]);
      if (r.length) await pool.execute("UPDATE automod_rules SET is_enabled=1 WHERE guild_id=? AND filter_type='spam'", [g]);
      else await pool.execute(
        "INSERT INTO automod_rules (guild_id, filter_type, is_enabled, action, config, ignored_roles, ignored_channels) VALUES (?,'spam',1,'delete',?,'[]','[]')",
        [g, JSON.stringify({ delete_message: true, warn_user: false })]);
    },
  },
  {
    key: 'antinuke', emoji: '💥', label: 'Anti-Nuke', category: 'Security', input: 'none',
    desc: 'Stops a rogue admin or compromised bot from mass-deleting channels/roles or mass-banning members.',
    isEnabled: (g) => flagOn('anti_nuke_config', g),
    enable: (g) => pool.execute('INSERT INTO anti_nuke_config (guild_id, enabled) VALUES (?,1) ON DUPLICATE KEY UPDATE enabled=1', [g]),
  },
  {
    key: 'raid', emoji: '🚨', label: 'Raid Detection', category: 'Security', input: 'none',
    desc: 'Detects a flood of joins (a raid) and auto-acts on suspicious brand-new accounts.',
    isEnabled: (g) => flagOn('raid_detection_config', g),
    enable: (g) => pool.execute('INSERT INTO raid_detection_config (guild_id, enabled) VALUES (?,1) ON DUPLICATE KEY UPDATE enabled=1', [g]),
  },
  {
    key: 'starboard', emoji: '⭐', label: 'Starboard', category: 'Engagement', input: 'channel',
    desc: 'Popular messages (⭐ reactions ≥ 3) get reposted to a highlights channel.',
    isEnabled: (g) => rowExists('SELECT 1 FROM starboard_config WHERE guild_id=? AND channel_id IS NOT NULL', g),
    enable: (g, { channelId }) => pool.execute(
      'INSERT INTO starboard_config (guild_id, channel_id, star_threshold) VALUES (?,?,3) ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id)',
      [g, channelId]),
  },
  {
    key: 'suggestions', emoji: '💡', label: 'Suggestions', category: 'Engagement', input: 'channel',
    desc: 'A suggestions box where members post ideas and the community votes.',
    isEnabled: (g) => flagOn('suggestion_config', g),
    enable: (g, { channelId }) => pool.execute(
      'INSERT INTO suggestion_config (guild_id, suggestions_channel_id, enabled) VALUES (?,?,1) ON DUPLICATE KEY UPDATE suggestions_channel_id=VALUES(suggestions_channel_id), enabled=1',
      [g, channelId]),
  },
  {
    key: 'birthdays', emoji: '🎂', label: 'Birthdays', category: 'Engagement', input: 'channel',
    desc: 'Members set their birthday; the bot announces it in a channel each day.',
    isEnabled: (g) => flagOn('birthday_config', g),
    enable: (g, { channelId }) => pool.execute(
      'INSERT INTO birthday_config (guild_id, announcement_channel_id, enabled) VALUES (?,?,1) ON DUPLICATE KEY UPDATE announcement_channel_id=VALUES(announcement_channel_id), enabled=1',
      [g, channelId]),
  },
  {
    key: 'economy', emoji: '💰', label: 'Economy', category: 'Games', input: 'none',
    desc: 'Server currency: daily/work/crime, gambling and a shop. Turns on with sensible defaults.',
    isEnabled: (g) => flagOn('economy_config', g),
    enable: (g) => pool.execute('INSERT INTO economy_config (guild_id, enabled) VALUES (?,1) ON DUPLICATE KEY UPDATE enabled=1', [g]),
  },
  {
    key: 'selfpromo', emoji: '📣', label: 'Self-Promo / Streamer Auto-Track', category: 'Streaming', input: 'channel',
    desc: 'A channel where members drop their stream link and get auto-added to go-live announcements.',
    isEnabled: (g) => flagOn('self_promo_config', g),
    enable: (g, { channelId }) => pool.execute(
      'INSERT INTO self_promo_config (guild_id, enabled, channel_id, allowed_platforms) VALUES (?,1,?,?) ON DUPLICATE KEY UPDATE enabled=1, channel_id=VALUES(channel_id)',
      [g, channelId, JSON.stringify(['twitch', 'kick', 'youtube'])]),
  },
];

export const STEP_COUNT = FEATURES.length;

export async function applyEnable(guildId, index, opts = {}) {
  const f = FEATURES[index];
  if (!f) return;
  await f.enable(guildId, opts);
}

/**
 * Build the message payload (embeds + components) for a wizard step.
 * index >= STEP_COUNT renders the final summary.
 */
export async function renderStep(guildId, index) {
  if (index >= STEP_COUNT) return renderSummary(guildId);

  const f = FEATURES[index];
  const on = await f.isEnabled(guildId).catch(() => false);
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setAuthor({ name: `Setup • ${f.category}` })
    .setTitle(`${f.emoji} ${f.label}`)
    .setDescription(f.desc)
    .addFields({ name: 'Status', value: on ? '✅ Already enabled' : '⬜ Not enabled', inline: true })
    .setFooter({ text: `Step ${index + 1} of ${STEP_COUNT} — Skip anything you don't want.` });

  const rows = [];
  if (f.input === 'channel' || f.input === 'channel_optional') {
    rows.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`setup_chan_${index}`)
        .setPlaceholder(f.input === 'channel_optional' ? 'Pick a channel (optional) to enable…' : 'Pick a channel to enable…')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1).setMaxValues(1),
    ));
  }
  const btns = [];
  if (f.input === 'none' || f.input === 'channel_optional') {
    btns.push(new ButtonBuilder().setCustomId(`setup_enable_${index}`).setLabel(f.input === 'channel_optional' ? 'Enable (no channel)' : 'Enable').setStyle(ButtonStyle.Success).setEmoji('✅'));
  }
  btns.push(new ButtonBuilder().setCustomId(`setup_skip_${index}`).setLabel('Skip').setStyle(ButtonStyle.Secondary).setEmoji('⏭️'));
  if (index > 0) btns.push(new ButtonBuilder().setCustomId(`setup_back_${index}`).setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('◀️'));
  rows.push(new ActionRowBuilder().addComponents(btns));

  return { embeds: [embed], components: rows };
}

async function renderSummary(guildId) {
  const states = await Promise.all(FEATURES.map(f => f.isEnabled(guildId).catch(() => false)));
  const on = FEATURES.filter((_, i) => states[i]);
  const off = FEATURES.filter((_, i) => !states[i]);
  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🎉 Setup complete!')
    .setDescription('Here\'s where things stand. Re-run `/setup` anytime to change these, or fine-tune everything on the dashboard.')
    .addFields(
      { name: `✅ Enabled (${on.length})`, value: on.length ? on.map(f => `${f.emoji} ${f.label}`).join('\n') : '*none*', inline: true },
      { name: `⬜ Off (${off.length})`, value: off.length ? off.map(f => `${f.emoji} ${f.label}`).join('\n') : '*none*', inline: true },
      { name: 'More features', value: 'Tickets, Reaction Roles, QOTD, word games and the Stream Team are set up on the **dashboard** or via `/support` / `/systems`.', inline: false },
    );
  return { embeds: [embed], components: [] };
}
