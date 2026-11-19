/*
 * /link-filter — default-deny link policy.
 *
 * Social platforms and chat plumbing (GIFs, Discord's own CDN, music) pass. Shorteners and
 * commission marketplaces are removed. Anything unrecognised goes to a queue for a decision, and
 * approving a domain there puts it on this server's allowlist permanently — that is how the
 * allowlist builds itself out of real traffic instead of being guessed up front.
 *
 * Discord invites are NOT handled here; events/inviteLinkFilter.js owns those.
 *
 * `/link-filter threats …` is the message-threat group (obfuscated-link scams, AutoMod escalation,
 * anti-everyone, QR codes, image-text rules, the ignore list): commands/tools/link-filter-threats-handler.js.
 */
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags, ChannelType } from 'discord.js';
import pool from '../../utils/db.js';
import { invalidate, getStats } from '../../core/link-filter.js';
import { SOCIAL_PLATFORMS, MEDIA_HOSTS, BLOCKED_HOSTS, MONETISATION_HOSTS, registrable } from '../../core/link-policy.js';
import { themeColor } from '../../core/guild-theme.js';
import { execute as handleThreats } from './link-filter-threats-handler.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

const data = new SlashCommandBuilder()
  .setName('link-filter')
  .setDescription('Block links that are not to allowed platforms')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(s => s.setName('enable').setDescription('Turn the link filter on')
    .addStringOption(o => o.setName('unknown').setDescription('What to do with an unrecognised domain (default: verify)')
      .addChoices({ name: 'verify — queue it, leave the message up', value: 'review' },
                  { name: 'block — remove it immediately', value: 'block' }))
    .addChannelOption(o => o.setName('review_channel').setDescription('Optional. Without one the queue lives in the dashboard').addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(s => s.setName('disable').setDescription('Turn the link filter off'))
  .addSubcommand(s => s.setName('status').setDescription('Current settings, counts and the domain lists'))
  .addSubcommand(s => s.setName('allow').setDescription('Always allow a domain here')
    .addStringOption(o => o.setName('domain').setDescription('e.g. example.com').setRequired(true)))
  .addSubcommand(s => s.setName('deny').setDescription('Always block a domain here')
    .addStringOption(o => o.setName('domain').setDescription('e.g. spam.example').setRequired(true)))
  .addSubcommand(s => s.setName('unrule').setDescription('Remove a domain from the allow/deny lists')
    .addStringOption(o => o.setName('domain').setDescription('The domain to forget').setRequired(true)))
  .addSubcommand(s => s.setName('queue').setDescription('Links waiting for a decision'))
  .addSubcommand(s => s.setName('rule').setDescription('Decide a queued or removed link')
    .addIntegerOption(o => o.setName('id').setDescription('The # from /link-filter queue').setRequired(true))
    .addStringOption(o => o.setName('decision').setDescription('Allow or block the domain').setRequired(true)
      .addChoices({ name: 'allow — approve, and restore the message if it was removed', value: 'allow' },
                  { name: 'block — deny the domain, remove the message', value: 'deny' })))
  .addSubcommand(s => s.setName('help').setDescription('What passes, what does not, and why'))
  // ── Message threats (core/message-threats.js; dashboard page Message Threats) ──
  .addSubcommandGroup(group => group.setName('threats')
    .setDescription('Obfuscated-link scams, AutoMod escalation, @everyone, QR codes, image-text rules')
    .addSubcommand(sub => sub.setName('status').setDescription('What is on, the circuit breaker and the queue'))
    .addSubcommand(sub => sub.setName('obfuscated').setDescription('The obfuscated-link "fake support" scam')
      .addBooleanOption(o => o.setName('enabled').setDescription('On or off'))
      .addStringOption(o => o.setName('action').setDescription('What to do on the confirmed pattern').addChoices(
        { name: 'ban, deleting their last hour (default)', value: 'ban' }, { name: 'timeout', value: 'timeout' },
        { name: 'delete the message', value: 'delete' }, { name: 'flag for a human (Ban / Dismiss card)', value: 'flag' },
        { name: 'log only', value: 'log' }))
      .addIntegerOption(o => o.setName('timeout-minutes').setDescription('Timeout length').setMinValue(1).setMaxValue(40320))
      .addBooleanOption(o => o.setName('review-alerts').setDescription('Also post a review card for weaker hits')))
    .addSubcommand(sub => sub.setName('escalation').setDescription('Act on Discord AutoMod hits of enforced rules')
      .addBooleanOption(o => o.setName('enabled').setDescription('On or off'))
      .addStringOption(o => o.setName('action').setDescription('What to do on the confirmed pattern').addChoices(
        { name: 'ban (default)', value: 'ban' }, { name: 'flag (Ban / Dismiss card)', value: 'flag' }))
      .addBooleanOption(o => o.setName('review-alerts').setDescription('Also post a review card for weaker hits')))
    .addSubcommand(sub => sub.setName('rules').setDescription('The AutoMod rules here and which are enforced'))
    .addSubcommand(sub => sub.setName('escalation-rule').setDescription('Enforce (or stop enforcing) one AutoMod rule')
      .addStringOption(o => o.setName('rule-id').setDescription('Rule ID from /link-filter threats rules').setRequired(true).setMaxLength(25))
      .addBooleanOption(o => o.setName('enforce').setDescription('Enforce it').setRequired(true)))
    .addSubcommand(sub => sub.setName('install-rule').setDescription('Create the Obfuscated URL AutoMod rule and enforce it'))
    .addSubcommand(sub => sub.setName('breaker-reset').setDescription('Turn automatic bans back on after the circuit breaker tripped'))
    .addSubcommand(sub => sub.setName('everyone').setDescription('Act on @everyone/@here pings from people who should not have it')
      .addBooleanOption(o => o.setName('enabled').setDescription('On or off'))
      .addIntegerOption(o => o.setName('timeout-minutes').setDescription('Timeout after deleting (0 = delete only)').setMinValue(0).setMaxValue(40320))
      .addBooleanOption(o => o.setName('strict').setDescription('Only admins, Manage Server and allowed roles may ping'))
      .addStringOption(o => o.setName('webhooks').setDescription('Webhooks that ping @everyone').addChoices(
        { name: 'log (default)', value: 'log' }, { name: 'delete', value: 'delete' }, { name: 'ignore', value: 'ignore' })))
    .addSubcommand(sub => sub.setName('everyone-allow').setDescription('A role that may always ping @everyone')
      .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true))
      .addBooleanOption(o => o.setName('remove').setDescription('Take it off instead')))
    .addSubcommand(sub => sub.setName('qr').setDescription('QR codes in images: check their links, or remove any')
      .addBooleanOption(o => o.setName('enabled').setDescription('On or off'))
      .addBooleanOption(o => o.setName('strict').setDescription('Remove every image with a QR code'))
      .addStringOption(o => o.setName('action').setDescription('What to do').addChoices(
        { name: 'delete (default)', value: 'delete' }, { name: 'timeout', value: 'timeout' }, { name: 'ban', value: 'ban' },
        { name: 'flag (Ban / Dismiss card)', value: 'flag' }, { name: 'log only', value: 'log' }))
      .addIntegerOption(o => o.setName('timeout-minutes').setDescription('Timeout length').setMinValue(1).setMaxValue(40320)))
    .addSubcommand(sub => sub.setName('nsfw-images').setDescription('NSFW images in chat: two local models, alert / delete / timeout')
      .addBooleanOption(o => o.setName('enabled').setDescription('On or off (age-restricted channels are always skipped)'))
      .addStringOption(o => o.setName('action').setDescription('When both models agree').addChoices(
        { name: 'Alert staff (default)', value: 'alert' }, { name: 'Delete', value: 'delete' }, { name: 'Delete + timeout', value: 'timeout' }))
      .addIntegerOption(o => o.setName('timeout-minutes').setDescription('Timeout length').setMinValue(1).setMaxValue(40320))
      .addNumberOption(o => o.setName('act-at').setDescription('Both models at or above (0.80-0.99, default 0.90)').setMinValue(0.8).setMaxValue(0.99))
      .addNumberOption(o => o.setName('review-at').setDescription('Queue for review at or above (0.30-0.99, default 0.60)').setMinValue(0.3).setMaxValue(0.99))
      .addBooleanOption(o => o.setName('review-alerts').setDescription('Also post a card for borderline images'))
      .addIntegerOption(o => o.setName('daily-cap').setDescription('Most image scans a day (10-50000, default 2000)').setMinValue(10).setMaxValue(50000)))
    .addSubcommand(sub => sub.setName('image-rules').setDescription('Your own rules for text inside images')
      .addBooleanOption(o => o.setName('enabled').setDescription('On or off'))
      .addIntegerOption(o => o.setName('timeout-minutes').setDescription('Timeout length for the timeout action').setMinValue(1).setMaxValue(40320)))
    .addSubcommand(sub => sub.setName('image-rule-add').setDescription('Add a rule for text inside images')
      .addStringOption(o => o.setName('type').setDescription('How to match').setRequired(true).addChoices(
        { name: 'contains text', value: 'contains' }, { name: 'regular expression', value: 'regex' },
        { name: 'exact text', value: 'exact' }, { name: 'mentions a domain', value: 'domain' }))
      .addStringOption(o => o.setName('pattern').setDescription('Text, regex or domain').setRequired(true).setMaxLength(300))
      .addStringOption(o => o.setName('action').setDescription('What to do (default: alert only)').addChoices(
        { name: 'alert only', value: 'log' }, { name: 'delete', value: 'delete' }, { name: 'timeout', value: 'timeout' }, { name: 'ban', value: 'ban' }))
      .addStringOption(o => o.setName('reason').setDescription('Shown in the log').setMaxLength(200)))
    .addSubcommand(sub => sub.setName('image-rule-remove').setDescription('Remove an image-text rule')
      .addIntegerOption(o => o.setName('id').setDescription('Rule # from image-rule-list').setRequired(true).setMinValue(1)))
    .addSubcommand(sub => sub.setName('image-rule-list').setDescription('The image-text rules here'))
    .addSubcommand(sub => sub.setName('ignore').setDescription('Ignore a channel or category (no channel: list)')
      .addChannelOption(o => o.setName('channel').setDescription('Channel or category').addChannelTypes(
        ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice, ChannelType.GuildCategory))
      .addBooleanOption(o => o.setName('remove').setDescription('Stop ignoring it')))
    .addSubcommand(sub => sub.setName('channel').setDescription('Where evidence and review cards go (empty: clear)')
      .addChannelOption(o => o.setName('channel').setDescription('Text channel').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(sub => sub.setName('flagged').setDescription('Members flagged and waiting for Ban / Dismiss')));

async function execute(interaction) {
  if (interaction.options.getSubcommandGroup(false) === 'threats') return handleThreats(interaction);
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (sub === 'enable') {
    const unknown = interaction.options.getString('unknown') || 'review';
    const ch = interaction.options.getChannel('review_channel');
    await pool.execute(
      `INSERT INTO link_policy_config (guild_id, enabled, unknown_action, review_channel_id)
       VALUES (?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE enabled = 1, unknown_action = VALUES(unknown_action),
         review_channel_id = COALESCE(VALUES(review_channel_id), review_channel_id)`,
      [guildId, unknown, ch?.id || null]);
    invalidate(guildId);
    return interaction.reply({
      content: `✅ Link filter **enabled**.\n`
        + `Social platforms, GIFs, Discord attachments and music pass. Shorteners and commission marketplaces are removed.\n`
        + `Unrecognised domains: **${unknown === 'block' ? 'removed immediately' : 'queued for a decision, message stays up'}**.\n`
        + (ch ? `Queue posts to ${ch}.` : 'No review channel set — the queue is on the dashboard, and nothing will be posted in Discord.'),
      ...EPHEMERAL });
  }

  if (sub === 'disable') {
    await pool.execute('UPDATE link_policy_config SET enabled = 0 WHERE guild_id = ?', [guildId]);
    invalidate(guildId);
    return interaction.reply({ content: '🛑 Link filter **disabled**.', ...EPHEMERAL });
  }

  if (sub === 'allow' || sub === 'deny') {
    const domain = registrable(interaction.options.getString('domain', true).trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]);
    await pool.execute(
      `INSERT INTO link_policy_domains (guild_id, domain, kind, note, created_by)
       VALUES (?, ?, ?, 'set by command', ?)
       ON DUPLICATE KEY UPDATE kind = VALUES(kind), created_by = VALUES(created_by)`,
      [guildId, domain, sub, interaction.user.id]);
    invalidate(guildId);
    return interaction.reply({ content: `${sub === 'allow' ? '✅' : '🚫'} \`${domain}\` is now **${sub === 'allow' ? 'always allowed' : 'always blocked'}** here.`, ...EPHEMERAL });
  }

  if (sub === 'unrule') {
    const domain = interaction.options.getString('domain', true).trim().toLowerCase();
    const [res] = await pool.execute('DELETE FROM link_policy_domains WHERE guild_id = ? AND domain = ?', [guildId, domain]);
    invalidate(guildId);
    return interaction.reply({
      content: res.affectedRows ? `✅ \`${domain}\` removed from the lists — it falls back to the defaults.`
                                : `❌ \`${domain}\` is not on either list.`, ...EPHEMERAL });
  }

  if (sub === 'queue') {
    const [rows] = await pool.execute(
      `SELECT id, user_id, channel_id, domain, category, verdict, deleted, decision, content
       FROM link_policy_decisions WHERE guild_id = ? AND decision IN ('pending','removed')
       ORDER BY id DESC LIMIT 10`, [guildId]);
    const embed = new EmbedBuilder()
      .setColor(themeColor(guildId, 'primary'))
      .setTitle('🔗 Links awaiting a decision')
      .setDescription(rows.length
        ? 'Decide with `/link-filter rule id:<#> decision:allow|block`. Allowing a domain is permanent.'
        : 'Nothing waiting.');
    for (const r of rows) {
      embed.addFields({
        name: `#${r.id} · ${r.domain} (${r.category})${r.deleted ? ' · removed' : ' · still up'}`,
        value: `<@${r.user_id}> in <#${r.channel_id}>\n> ${(r.content || '').slice(0, 140).replace(/\n/g, ' ') || '*(no text)*'}`,
        inline: false });
    }
    return interaction.reply({ embeds: [embed], ...EPHEMERAL });
  }

  if (sub === 'rule') {
    await interaction.deferReply(EPHEMERAL);
    const { applyLinkDecision } = await import('../../interactions/buttons/link_review.js');
    const text = await applyLinkDecision(interaction, interaction.options.getInteger('id', true),
      interaction.options.getString('decision', true));
    return interaction.editReply(text);
  }

  if (sub === 'help') {
    const embed = new EmbedBuilder()
      .setColor(themeColor(guildId, 'primary'))
      .setTitle('🔗 How the link filter decides')
      .setDescription('Default-deny: if it is not a platform we allow and you have not allowed it, it does not pass. Staff are always exempt.')
      .addFields(
        { name: '✅ Always allowed', value: `Social & streaming — ${SOCIAL_PLATFORMS.slice(0, 8).join(', ')}…\nChat plumbing — ${MEDIA_HOSTS.slice(0, 6).join(', ')}…` },
        { name: '🚫 Always removed', value: `Shorteners and commission marketplaces — ${BLOCKED_HOSTS.slice(0, 8).join(', ')}…` },
        { name: '🔎 Sent for a decision', value: `Anything unrecognised, plus monetisation links (${MONETISATION_HOSTS.slice(0, 4).join(', ')}…). Approving one allowlists the domain forever.` },
        { name: 'Not handled here', value: 'Discord invite links — those are the invite filter\'s job (`/invite-filter`).' },
      )
      .setFooter({ text: 'Obfuscation (example [dot] com, hxxps://) is resolved before matching.' });
    return interaction.reply({ embeds: [embed], ...EPHEMERAL });
  }

  // status
  const { cfg, domains } = await getStats(guildId);
  const allow = domains.filter(d => d.kind === 'allow');
  const deny = domains.filter(d => d.kind === 'deny');
  const embed = new EmbedBuilder()
    .setColor(cfg?.enabled ? 0x2ecc71 : 0x95a5a6)
    .setTitle('🔗 Link Filter')
    .addFields(
      { name: 'Status', value: cfg?.enabled ? 'Enabled' : 'Disabled', inline: true },
      { name: 'Unknown domains', value: cfg?.unknown_action === 'block' ? 'Removed' : 'Queued for review', inline: true },
      { name: 'Monetisation', value: cfg?.monetisation_action || 'review', inline: true },
      { name: 'Removed', value: String(cfg?.deleted_count ?? 0), inline: true },
      { name: 'Queued', value: String(cfg?.review_count ?? 0), inline: true },
      { name: 'Review channel', value: cfg?.review_channel_id ? `<#${cfg.review_channel_id}>` : 'Dashboard only', inline: true },
      { name: `Allowed here (${allow.length})`, value: allow.length ? allow.slice(0, 25).map(d => `\`${d.domain}\``).join(' ') : '—' },
      { name: `Blocked here (${deny.length})`, value: deny.length ? deny.slice(0, 25).map(d => `\`${d.domain}\``).join(' ') : '—' },
    )
    .setFooter({ text: 'Staff are always exempt. Discord invites are handled by /invite-filter.' });
  return interaction.reply({ embeds: [embed], ...EPHEMERAL });
}

export { data, execute };
export default { category: 'tools', data, execute };
