/*
 * /commission-filter — manage the paid-commission advertising filter.
 *
 * Deletes non-staff messages advertising paid commissions ("commissions open", VTuber/GFX/art comms,
 * etc.). Admins and moderators are exempt. Admin-only to configure.
 */
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags, ChannelType } from 'discord.js';
import pool from '../../utils/db.js';
import { invalidate, DEFAULT_PHRASES, PHRASE_GROUPS, getStats, groupsFor } from '../../core/commission-spam-filter.js';
import { themeColor } from '../../core/guild-theme.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

const data = new SlashCommandBuilder()
  .setName('commission-filter')
  .setDescription('Auto-delete non-staff messages advertising paid commissions')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(s => s.setName('enable').setDescription('Turn the commission filter on')
    .addChannelOption(o => o.setName('log_channel').setDescription('Where to log removals (optional)').addChannelTypes(ChannelType.GuildText))
    .addBooleanOption(o => o.setName('dm_user').setDescription('DM the poster when their message is removed (default: yes)')))
  .addSubcommand(s => s.setName('disable').setDescription('Turn the commission filter off'))
  .addSubcommand(s => s.setName('soft-sell').setDescription('Catch portfolio-style ads that never actually ask (no "commissions open")')
    .addBooleanOption(o => o.setName('enabled').setDescription('Turn the soft-sell tier on or off').setRequired(true))
    .addChannelOption(o => o.setName('review_channel').setDescription('Where borderline posts go for a decision (defaults to the log channel)').addChannelTypes(ChannelType.GuildText))
    .addStringOption(o => o.setName('sensitivity').setDescription('How readily it acts (default: balanced)')
      .addChoices(
        { name: 'cautious — only very obvious ads, more goes to review', value: 'cautious' },
        { name: 'balanced — recommended', value: 'balanced' },
        { name: 'strict — acts on thinner evidence', value: 'strict' },
      )))
  .addSubcommand(s => s.setName('status').setDescription('Show current settings and how many it has removed'))
  .addSubcommand(s => s.setName('add-phrase').setDescription('Add a phrase to catch')
    .addStringOption(o => o.setName('phrase').setDescription('e.g. "commissions open"').setRequired(true)))
  .addSubcommand(s => s.setName('remove-phrase').setDescription('Remove a custom phrase')
    .addStringOption(o => o.setName('phrase').setDescription('The phrase to remove').setRequired(true)))
  .addSubcommand(s => s.setName('phrases').setDescription('List the phrases currently being matched'))
  .addSubcommand(s => s.setName('exemptions').setDescription('Show what moderators have told the filter to stop catching'))
  .addSubcommand(s => s.setName('unexempt').setDescription('Remove an exemption so the filter can catch it again')
    .addStringOption(o => o.setName('value').setDescription('The exemption key shown by /commission-filter exemptions').setRequired(true)))
  .addSubcommand(s => s.setName('removals').setDescription('Recent removals, with what triggered each one'))
  .addSubcommand(s => s.setName('undo').setDescription('Reverse a removal the filter got wrong')
    .addIntegerOption(o => o.setName('removal_id').setDescription('The #id from /commission-filter removals').setRequired(true))
    .addStringOption(o => o.setName('mode').setDescription('What to undo (default: restore this message)')
      .addChoices(
        { name: 'restore — put the message back and never remove it again', value: 'restore' },
        { name: 'stop-matching — switch off whatever triggered it, server-wide', value: 'disable-trigger' },
      )))
  .addSubcommand(s => s.setName('help').setDescription('What this filter catches and what happens when it does'));

async function currentPhrases(guildId) {
  const [[row]] = await pool.execute('SELECT phrases FROM commission_spam_config WHERE guild_id = ?', [guildId]);
  if (row?.phrases) { try { const a = JSON.parse(row.phrases); if (Array.isArray(a) && a.length) return { list: a, custom: true }; } catch { /* ignore */ } }
  return { list: DEFAULT_PHRASES, custom: false };
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (sub === 'enable') {
    const logCh = interaction.options.getChannel('log_channel');
    const dm = interaction.options.getBoolean('dm_user');
    await pool.execute(
      `INSERT INTO commission_spam_config (guild_id, enabled, log_channel_id, dm_user) VALUES (?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE enabled = 1, log_channel_id = VALUES(log_channel_id), dm_user = VALUES(dm_user)`,
      [guildId, logCh?.id || null, dm === null ? 1 : (dm ? 1 : 0)]);
    invalidate(guildId);
    return interaction.reply({
      content: `✅ Commission filter **enabled** in every channel. Non-staff messages advertising paid commissions will be removed.\n`
        + `${logCh ? `Removals logged to ${logCh}. ` : ''}Admins and moderators are exempt. Tune the wordlist with \`/moderation commission-filter add-phrase\`.`,
      ...EPHEMERAL });
  }

  if (sub === 'disable') {
    await pool.execute('UPDATE commission_spam_config SET enabled = 0 WHERE guild_id = ?', [guildId]);
    invalidate(guildId);
    return interaction.reply({ content: '🛑 Commission filter **disabled**.', ...EPHEMERAL });
  }

  if (sub === 'soft-sell') {
    const on = interaction.options.getBoolean('enabled');
    const reviewCh = interaction.options.getChannel('review_channel');
    // Two thresholds, so sensitivity moves the delete bar and the review bar together. The gap
    // between them is what a moderator gets asked about rather than the filter guessing.
    const LEVELS = { cautious: [7, 5], balanced: [6, 4], strict: [5, 3] };
    const level = interaction.options.getString('sensitivity') || 'balanced';
    const [deleteAt, reviewAt] = LEVELS[level] || LEVELS.balanced;

    await pool.execute(
      `INSERT INTO commission_spam_config (guild_id, enabled, soft_sell_enabled, soft_sell_delete_at, soft_sell_review_at, review_channel_id)
       VALUES (?, 1, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE soft_sell_enabled = VALUES(soft_sell_enabled),
         soft_sell_delete_at = VALUES(soft_sell_delete_at), soft_sell_review_at = VALUES(soft_sell_review_at),
         review_channel_id = COALESCE(VALUES(review_channel_id), review_channel_id)`,
      [guildId, on ? 1 : 0, deleteAt, reviewAt, reviewCh?.id || null]);
    invalidate(guildId);

    if (!on) return interaction.reply({ content: '🛑 Soft-sell detection **off**. Only explicit solicitations are filtered now.', ...EPHEMERAL });

    const [[cfg]] = await pool.execute('SELECT review_channel_id, log_channel_id FROM commission_spam_config WHERE guild_id = ?', [guildId]);
    const dest = cfg?.review_channel_id || cfg?.log_channel_id;
    return interaction.reply({
      content: `✅ Soft-sell detection **on** (${level}).\n`
        + 'Catches portfolio-style ads that never ask outright — "finished this branding package for a client", '
        + 'shop links, booking language — by requiring several independent signals to agree.\n'
        + (dest ? `Borderline posts go to <#${dest}> with **Delete it** / **Allow it** buttons instead of being removed automatically.`
                : '⚠️ No review or log channel set, so borderline posts will only be logged to the console. '
                  + 'Set one with `/moderation commission-filter soft-sell enabled:true review_channel:#channel`.'),
      ...EPHEMERAL });
  }

  if (sub === 'add-phrase' || sub === 'remove-phrase') {
    const phrase = interaction.options.getString('phrase', true).trim().toLowerCase();
    const { list, custom } = await currentPhrases(guildId);
    // Start a custom list from the defaults the first time it's edited, so nothing silently vanishes.
    let next = custom ? [...list] : [...DEFAULT_PHRASES];
    if (sub === 'add-phrase') {
      if (next.includes(phrase)) return interaction.reply({ content: `\`${phrase}\` is already in the list.`, ...EPHEMERAL });
      next.push(phrase);
    } else {
      if (!next.includes(phrase)) return interaction.reply({ content: `\`${phrase}\` isn't in the list.`, ...EPHEMERAL });
      next = next.filter(p => p !== phrase);
    }
    await pool.execute(
      `INSERT INTO commission_spam_config (guild_id, enabled, phrases) VALUES (?, 1, ?)
       ON DUPLICATE KEY UPDATE phrases = VALUES(phrases)`,
      [guildId, JSON.stringify(next)]);
    invalidate(guildId);
    return interaction.reply({ content: `${sub === 'add-phrase' ? 'Added' : 'Removed'} \`${phrase}\`. Now matching **${next.length}** phrases.`, ...EPHEMERAL });
  }

  if (sub === 'phrases') {
    const { list, custom } = await currentPhrases(guildId);
    return interaction.reply({
      content: `**${list.length}** phrases${custom ? ' (custom list)' : ' (built-in defaults)'}:\n`
        + list.map(p => `\`${p}\``).join(', ').slice(0, 1900),
      ...EPHEMERAL });
  }

  if (sub === 'help') {
    const cfg = await getStats(guildId);
    const groups = groupsFor(cfg);
    const total = groups.reduce((n, g) => n + g.phrases.length, 0);
    const embed = new EmbedBuilder()
      .setColor(themeColor(interaction.guildId, 'warning'))
      .setTitle('🧹 Commission & Sales Filter')
      .setDescription(
        'Automatically removes messages from **non-staff** members that advertise paid commissions, '
        + 'solicit sales, or push follower/boosting spam.\n\n'
        + '**When a match is posted:** the message is deleted, the poster is DM\'d, and (if set) the '
        + 'removal is logged.\n'
        + '**Exempt:** admins, moderators, Manage Server, and the owner are never touched.\n'
        + `**In ${interaction.guild.name}:** ${cfg?.enabled ? '🟢 active' : '⚪ off'} · `
        + `**${cfg?.deleted_count ?? 0}** removed · ${total} phrases watched.`);
    for (const g of groups) {
      // Field values cap at 1024 chars; trim the chip list if a custom group is huge.
      let v = g.phrases.map(p => `\`${p}\``).join('  ');
      if (v.length > 1024) v = v.slice(0, 1000).replace(/`[^`]*$/, '') + '…';
      embed.addFields({ name: `${g.icon} ${g.title} (${g.phrases.length})`, value: v });
    }
    embed.setFooter({ text: 'Matching ignores case, punctuation, emoji and leetspeak. Tune with /moderation commission-filter add-phrase.' });
    return interaction.reply({ embeds: [embed], ...EPHEMERAL });
  }

  if (sub === 'exemptions') {
    const [rows] = await pool.execute(
      'SELECT kind, value, note, created_by, created_at FROM commission_spam_exemptions WHERE guild_id = ? ORDER BY created_at DESC LIMIT 40',
      [guildId]);
    const embed = new EmbedBuilder()
      .setColor(themeColor(guildId, 'primary'))
      .setTitle('🚫 Filter exemptions')
      .setDescription(rows.length
        ? 'Things a moderator has told the filter to leave alone. Remove one with `/moderation commission-filter unexempt`.'
        : 'Nothing exempted yet. Use the **False positive** button on a removal log entry to add one.');
    const label = { content: 'This exact message', trigger: 'This trigger', user: 'This member' };
    for (const r of rows.slice(0, 20)) {
      embed.addFields({
        name: `${label[r.kind] || r.kind} — \`${r.value}\``,
        value: `${r.note || '—'}${r.created_by ? ` · by <@${r.created_by}>` : ''}`,
        inline: false });
    }
    if (rows.length > 20) embed.setFooter({ text: `…and ${rows.length - 20} more` });
    return interaction.reply({ embeds: [embed], ...EPHEMERAL });
  }

  if (sub === 'unexempt') {
    const value = interaction.options.getString('value');
    const [res] = await pool.execute(
      'DELETE FROM commission_spam_exemptions WHERE guild_id = ? AND value = ?', [guildId, value]);
    invalidate(guildId);
    return interaction.reply({
      content: res.affectedRows
        ? `✅ Exemption \`${value}\` removed — the filter can catch it again.`
        : `❌ No exemption matching \`${value}\`. Check \`/moderation commission-filter exemptions\`.`,
      ...EPHEMERAL });
  }

  if (sub === 'undo') {
    const id = interaction.options.getInteger('removal_id');
    const mode = interaction.options.getString('mode') || 'restore';
    await interaction.deferReply(EPHEMERAL);
    const { applyFalsePositive } = await import('../../interactions/buttons/commission_false_positive.js');
    const text = await applyFalsePositive(interaction, id, mode);
    return interaction.editReply(text);
  }

  if (sub === 'removals') {
    const [rows] = await pool.execute(
      `SELECT id, user_id, channel_id, via, rule, matched, score, signals, verdict, content, created_at
       FROM commission_spam_decisions
       WHERE guild_id = ? AND deleted = 1 ORDER BY id DESC LIMIT 10`, [guildId]);
    const embed = new EmbedBuilder()
      .setColor(themeColor(guildId, 'primary'))
      .setTitle('🧹 Recent removals')
      .setDescription(rows.length
        ? 'Newest first. Every removal is kept with its full text so it can be checked or undone.\nGot one wrong? `/moderation commission-filter undo removal_id:<#>`'
        : 'Nothing removed yet.');
    for (const r of rows) {
      const trigger = r.via === 'soft-sell' ? `score ${r.score} — ${r.signals}` : `\`${r.matched}\``;
      embed.addFields({
        name: `#${r.id} · ${r.via}${r.verdict === 'false_positive' ? ' · ↩️ restored' : ''}`,
        value: `<@${r.user_id}> in <#${r.channel_id}> — ${trigger}\n> ${(r.content || '').slice(0, 160).replace(/\n/g, ' ') || '*(no text)*'}`,
        inline: false });
    }
    return interaction.reply({ embeds: [embed], ...EPHEMERAL });
  }

  // status
  const [[cfg]] = await pool.execute('SELECT * FROM commission_spam_config WHERE guild_id = ?', [guildId]);
  const { list, custom } = await currentPhrases(guildId);
  const embed = new EmbedBuilder()
    .setColor(cfg?.enabled ? 0x2ecc71 : 0x95a5a6)
    .setTitle('🧹 Commission Filter')
    .addFields(
      { name: 'Status', value: cfg?.enabled ? 'Enabled' : 'Disabled', inline: true },
      { name: 'Phrases', value: `${list.length} ${custom ? '(custom)' : '(default)'}`, inline: true },
      { name: 'Removed', value: String(cfg?.deleted_count ?? 0), inline: true },
      { name: 'DM on removal', value: cfg?.dm_user ? 'Yes' : 'No', inline: true },
      { name: 'Log channel', value: cfg?.log_channel_id ? `<#${cfg.log_channel_id}>` : 'None', inline: true },
      { name: 'Soft-sell tier',
        value: cfg?.soft_sell_enabled
          ? `On — deletes at ${cfg.soft_sell_delete_at}, reviews at ${cfg.soft_sell_review_at}`
          : 'Off (only explicit solicitations)',
        inline: true },
      { name: 'Soft-sell caught', value: `${cfg?.soft_sell_deleted_count ?? 0} removed · ${cfg?.soft_sell_review_count ?? 0} sent for review`, inline: true },
      { name: 'Review channel',
        value: cfg?.review_channel_id ? `<#${cfg.review_channel_id}>` : (cfg?.log_channel_id ? `<#${cfg.log_channel_id}> (log channel)` : 'None'),
        inline: true },
    )
    .setFooter({ text: 'Admins and moderators are always exempt.' });
  return interaction.reply({ embeds: [embed], ...EPHEMERAL });
}

export { data, execute };
export default { category: 'tools', data, execute };
