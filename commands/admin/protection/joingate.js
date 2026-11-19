/*
 * `/protection joingate` — the account-age admission rule.
 *
 * Two thresholds and three destinations, all per guild. Kept in the protection command rather than
 * /admin because that is where every other join-time defence already lives, and /admin has no room.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { getConfig, setConfig, humanAge, latestApplication } from '../../../core/join-gate.js';
import { addReset, backfillGuild, countJoins, joinHistory } from '../../../core/join-history.js';
import { normaliseAction } from '../../../utils/join-history-logic.js';
import { normaliseSpammerAction } from '../../../core/spammer-flag.js';
import {
  scanGuild, rememberScan, allowlist, addAllow, removeAllow, FLAG_ROLE_NAME,
} from '../../../core/spammer-guard.js';

const EPHEMERAL = { flags: 64 };
const ts = (d) => Math.floor(new Date(d).getTime() / 1000);

/** One sentence: what the rejoin limit does in this server right now. */
function describeRejoin(cfg) {
  if (!cfg?.rejoin_limit_enabled) return 'The rejoin limit is **off**.';
  const action = ({
    ban: 'banned', kick: 'removed, every time they come back', apply: 'removed with an application', none: 'logged only (observe mode)',
  })[normaliseAction(cfg.rejoin_action)];
  const window = Number(cfg.rejoin_window_days) > 0 ? `in the last ${cfg.rejoin_window_days} days` : 'ever';
  return `The rejoin limit is **on**: anyone who joins more than **${cfg.rejoin_max_joins}** times ${window} is ${action}.`;
}

function describeBackfill(r) {
  if (r.alreadyRunning) return 'Past joins are already being counted. Check `/protection joingate status` in a minute.';
  const back = r.oldest ? ` going back to <t:${ts(r.oldest)}:D>` : '';
  return `Counted past joins: **${r.added}** added for ${r.members} members, from Discord's own join messages `
    + `(${r.systemJoins} in ${r.scanned} system-channel messages${back}) and the bot's logs.`
    + (r.problem ? `\n⚠️ ${r.problem}` : '');
}

/** One sentence: what the spammer check does in this server right now. */
function describeSpammer(cfg) {
  if (!cfg?.spammer_enabled) return 'The spammer check is **off**.';
  const action = normaliseSpammerAction(cfg.spammer_action);
  const what = {
    kick: 'removed', ban: 'banned', none: 'logged only (observe mode)',
    flag: `given ${cfg.spammer_role_id ? `<@&${cfg.spammer_role_id}>` : `a "${FLAG_ROLE_NAME}" role`}`,
  }[action];
  return `The spammer check is **on**: accounts Discord has flagged as spammers are ${what} when they join`
    + (cfg.spammer_silent ? ', without a log post.' : '.');
}

const SCAN_LABEL = { kick: 'Kick', ban: 'Ban', flag: 'Flag' };

const SOURCE_LABEL = { system_message: "Discord's join message", audit_log: 'bot log', invite_log: 'invite log' };

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (sub === 'enable' || sub === 'disable') {
    const on = sub === 'enable';
    const cfg = await setConfig(guildId, { age_gate_enabled: on ? 1 : 0 });
    if (on && !cfg?.review_channel_id) {
      return interaction.reply({
        content: '⚠️ Gate enabled, but there is **no review channel** — applications will be saved with '
          + 'nowhere to appear. Set one with `/protection joingate config review-channel:#channel`.',
        ...EPHEMERAL });
    }
    return interaction.reply({ content: `Join gate ${on ? 'enabled' : 'disabled'}.`, ...EPHEMERAL });
  }

  if (sub === 'config') {
    const patch = {};
    const hours = interaction.options.getInteger('kick-under-hours');
    const days = interaction.options.getInteger('apply-under-days');
    const review = interaction.options.getChannel('review-channel');
    const invite = interaction.options.getChannel('invite-channel');
    const log = interaction.options.getChannel('log-channel');
    if (hours !== null) patch.kick_under_hours = hours;
    if (days !== null) patch.apply_under_days = days;
    if (review) patch.review_channel_id = review.id;
    if (invite) patch.invite_channel_id = invite.id;
    if (log) patch.log_channel_id = log.id;
    const action = interaction.options.getString('action');
    const avatar = interaction.options.getBoolean('block-default-avatar');
    if (action) patch.action = action;
    if (avatar !== null) patch.block_default_avatar = avatar ? 1 : 0;
    if (!Object.keys(patch).length) {
      return interaction.reply({ content: 'Nothing to change — give me at least one option.', ...EPHEMERAL });
    }
    // An application window that ends before the kick window begins has no members in it, which
    // silently turns the whole application tier off.
    const cfg = await setConfig(guildId, patch);
    const note = (cfg.apply_under_days * 24) <= cfg.kick_under_hours
      ? '\n\n⚠️ The application window is **not open**: nobody is old enough to apply but too young to '
        + 'join, so every new account is simply kicked. Raise `apply-under-days`.'
      : '';
    return interaction.reply({ content: `Saved.${note}`, ...EPHEMERAL });
  }

  if (sub === 'status') {
    const cfg = await getConfig(guildId);
    if (!cfg?.kick_under_hours) return interaction.reply({ content: 'The account-age gate has never been set up here.', ...EPHEMERAL });

    const [[counts]] = await pool.execute(
      `SELECT
         SUM(status = 'pending')  AS pending,
         SUM(status = 'approved') AS approved,
         SUM(status = 'denied')   AS denied
       FROM join_gate_applications WHERE guild_id = ?`, [guildId]);
    const [[recent]] = await pool.execute(
      `SELECT
         SUM(action = 'kicked_new')   AS too_new,
         SUM(action = 'kicked_apply') AS to_apply,
         SUM(dm_delivered = 0 AND action LIKE 'kicked%') AS silent,
         SUM(action IN ('rejoin_banned', 'rejoin_kicked', 'rejoin_apply')) AS rejoin
       FROM join_gate_events WHERE guild_id = ? AND created_at > NOW() - INTERVAL 30 DAY`, [guildId]);

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(cfg.age_gate_enabled ? 0x2ECC71 : 0x95A5A6)
        .setTitle(`Account-age gate — ${cfg.age_gate_enabled ? 'on' : 'off'}`)
        .setDescription(`Accounts under **${cfg.kick_under_hours}h** are removed on sight. `
          + `Under **${cfg.apply_under_days} days** they are removed with an application.`)
        .addFields(
          { name: 'Applications', value:
            `${Number(counts?.pending) || 0} pending · ${Number(counts?.approved) || 0} approved · `
            + `${Number(counts?.denied) || 0} declined`, inline: false },
          { name: 'Last 30 days', value:
            `${Number(recent?.too_new) || 0} removed as too new · ${Number(recent?.to_apply) || 0} sent to apply`
            + (Number(recent?.silent) ? `\n⚠️ ${recent.silent} could not be DMed — they were removed with no explanation` : ''),
            inline: false },
          { name: 'On a blocked join', value: ({
            none: '**nothing — log only**', ban: 'ban', kick: 'kick',
          })[String(cfg.action || 'kick').toLowerCase()] ?? 'kick'
            + (cfg.block_default_avatar ? '\nNo-picture accounts cannot apply' : ''), inline: true },
          { name: 'Review channel', value: cfg.review_channel_id ? `<#${cfg.review_channel_id}>` : '**not set — applications have nowhere to go**', inline: true },
          { name: 'Invite points at', value: cfg.invite_channel_id ? `<#${cfg.invite_channel_id}>` : 'the rules/system channel', inline: true },
          { name: 'Removals logged to', value: cfg.log_channel_id ? `<#${cfg.log_channel_id}>` : (cfg.review_channel_id ? `<#${cfg.review_channel_id}>` : 'nowhere'), inline: true },
          { name: 'Discord-flagged spammers', value: describeSpammer(cfg), inline: false },
          { name: 'Rejoin limit', value: describeRejoin(cfg)
            + (cfg.rejoin_limit_enabled ? `\n${Number(recent?.rejoin) || 0} removed for it in the last 30 days` : ''), inline: false },
        )],
      ...EPHEMERAL });
  }

  if (sub === 'applications') {
    const status = interaction.options.getString('status') || 'pending';
    const [rows] = await pool.execute(
      `SELECT id, user_id, username, account_created_at, submitted_at, decided_by
         FROM join_gate_applications WHERE guild_id = ? AND status = ?
        ORDER BY id DESC LIMIT 15`, [guildId, status]);
    if (!rows.length) return interaction.reply({ content: `No ${status} applications.`, ...EPHEMERAL });

    const lines = rows.map(r => {
      const age = r.account_created_at ? humanAge(Date.now() - new Date(r.account_created_at).getTime()) : 'unknown';
      return `**#${r.id}** <@${r.user_id}> — account ${age} old, applied <t:${Math.floor(new Date(r.submitted_at).getTime() / 1000)}:R>`
        + (r.decided_by ? ` · by <@${r.decided_by}>` : '');
    });
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x3498DB)
        .setTitle(`${status[0].toUpperCase()}${status.slice(1)} applications`)
        .setDescription(lines.join('\n').slice(0, 4000))
        .setFooter({ text: status === 'pending' ? 'Decide them on the buttons in the review channel.' : ' ' })],
      ...EPHEMERAL });
  }

  if (sub === 'rejoin') {
    const patch = {};
    const on = interaction.options.getBoolean('enabled');
    const max = interaction.options.getInteger('max-joins');
    const days = interaction.options.getInteger('window-days');
    const action = interaction.options.getString('action');
    if (on !== null) patch.rejoin_limit_enabled = on ? 1 : 0;
    if (max !== null) patch.rejoin_max_joins = max;
    if (days !== null) patch.rejoin_window_days = days;
    if (action) patch.rejoin_action = normaliseAction(action);
    if (!Object.keys(patch).length) {
      return interaction.reply({ content: describeRejoin(await getConfig(guildId)), ...EPHEMERAL });
    }
    const cfg = await setConfig(guildId, patch);
    const summary = describeRejoin(cfg);
    // The first time it is switched on, count the joins from before the bot kept this history, so a
    // repeat joiner is not treated as new.
    if (cfg.rejoin_limit_enabled && !cfg.rejoin_backfilled_at) {
      await interaction.deferReply(EPHEMERAL);
      try {
        const result = await backfillGuild(interaction.guild);
        return interaction.editReply(`Saved. ${summary}\n\n${describeBackfill(result)}`);
      } catch (err) {
        logger.error(`[JoinGate] rejoin backfill failed for ${guildId}: ${err.message}`);
        return interaction.editReply(`Saved. ${summary}\n\n⚠️ Counting past joins failed (${err.message}). `
          + 'Joins from now on are counted; turning the limit off and on again retries.');
      }
    }
    return interaction.reply({ content: `Saved. ${summary}`, ...EPHEMERAL });
  }

  if (sub === 'history') {
    const user = interaction.options.getUser('user');
    const cfg = await getConfig(guildId);
    const { joins, total } = await joinHistory(guildId, user.id, 25);
    if (!total) {
      return interaction.reply({
        content: `No joins on record for ${user} in this server.`
          + (cfg?.rejoin_backfilled_at ? '' : ' Joins from before the bot kept this history are added when the rejoin limit is first switched on.'),
        allowedMentions: { parse: [] }, ...EPHEMERAL });
    }
    const app = await latestApplication(guildId, user.id);
    const approvedAt = app?.status === 'approved' ? app.decided_at : null;
    const { count, since, reset } = await countJoins(guildId, user.id, { windowDays: cfg?.rejoin_window_days || 0, approvedAt });
    const lines = joins.map((j, i) => `**${total - i}.** <t:${ts(j.joined_at)}:f> · <t:${ts(j.joined_at)}:R>`
      + (SOURCE_LABEL[j.source] ? ` · from ${SOURCE_LABEL[j.source]}` : ''));
    const fields = [
      { name: 'Joins on record', value: String(total), inline: true },
      { name: 'Counted toward the limit', value: `${count}${since ? ` (since <t:${ts(since)}:D>)` : ''}`, inline: true },
      { name: 'Limit', value: cfg?.rejoin_limit_enabled ? `${cfg.rejoin_max_joins} · ${normaliseAction(cfg.rejoin_action)}` : 'off', inline: true },
    ];
    if (reset) {
      fields.push({ name: 'Count last reset', value: `<t:${ts(reset.reset_at)}:f> — ${reset.reason === 'unban' ? 'unbanned' : `by <@${reset.reset_by}>`}`, inline: false });
    }
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x3498DB)
        .setTitle(`Join history — ${user.tag ?? user.username}`)
        .setDescription(lines.join('\n').slice(0, 4000) + (total > joins.length ? `\n…and ${total - joins.length} earlier` : ''))
        .addFields(fields)
        .setFooter({ text: cfg?.rejoin_backfilled_at
          ? 'Includes joins from before the bot was tracking, from Discord\'s own join messages.'
          : 'Joins before the bot started tracking are added when the rejoin limit is first switched on.' })],
      ...EPHEMERAL });
  }

  if (sub === 'reset') {
    const user = interaction.options.getUser('user');
    await addReset(guildId, user.id, 'staff', interaction.user.id);
    return interaction.reply({
      content: `${user}'s rejoin count starts from zero again. Their join history is kept: \`/protection joingate history\` still shows it.`,
      allowedMentions: { parse: [] }, ...EPHEMERAL });
  }

  if (sub === 'spammer') {
    const patch = {};
    const on = interaction.options.getBoolean('enabled');
    const action = interaction.options.getString('action');
    const role = interaction.options.getRole('flag-role');
    const silent = interaction.options.getBoolean('silent');
    if (on !== null) patch.spammer_enabled = on ? 1 : 0;
    if (action) patch.spammer_action = normaliseSpammerAction(action);
    if (role) {
      if (role.managed || role.id === guildId) {
        return interaction.reply({ content: 'That role cannot be handed out — pick an ordinary role.', ...EPHEMERAL });
      }
      patch.spammer_role_id = role.id;
    }
    if (silent !== null) patch.spammer_silent = silent ? 1 : 0;
    if (!Object.keys(patch).length) {
      return interaction.reply({ content: describeSpammer(await getConfig(guildId)), ...EPHEMERAL });
    }
    const cfg = await setConfig(guildId, patch);
    const need = {
      kick: [PermissionFlagsBits.KickMembers, 'Kick Members'], ban: [PermissionFlagsBits.BanMembers, 'Ban Members'],
      flag: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
    }[normaliseSpammerAction(cfg.spammer_action)];
    const warn = cfg.spammer_enabled && need && !interaction.guild.members.me?.permissions?.has(need[0])
      ? `\n\n⚠️ The bot does not have **${need[1]}** here, so it cannot act yet.` : '';
    return interaction.reply({
      content: `Saved. ${describeSpammer(cfg)}${warn}\nUse \`/protection joingate spammer-scan\` for members already inside.`,
      ...EPHEMERAL });
  }

  if (sub === 'spammer-scan') {
    await interaction.deferReply(EPHEMERAL);
    const cfg = await getConfig(guildId);
    const result = await scanGuild(interaction.guild, cfg);
    const skippedLine = [
      result.skipped.allowlisted.length && `${result.skipped.allowlisted.length} allowlisted`,
      result.skipped.staff.length && `${result.skipped.staff.length} staff`,
      result.skipped.unremovable.length && `${result.skipped.unremovable.length} above the bot`,
      result.skipped.already.length && `${result.skipped.already.length} already flagged`,
    ].filter(Boolean).join(' · ');
    const list = result.targets.slice(0, 15)
      .map(m => `<@${m.id}> · \`${m.id}\` · joined <t:${Math.floor((m.joinedTimestamp ?? Date.now()) / 1000)}:R>`)
      .join('\n');
    const embed = new EmbedBuilder()
      .setColor(result.targets.length ? 0xC0392B : 0x2ECC71)
      .setTitle(result.targets.length
        ? `${result.targets.length} member${result.targets.length === 1 ? '' : 's'} flagged by Discord as spammers`
        : 'No flagged spammers to act on')
      .setDescription((list || 'Every member checked is clear.')
        + (result.targets.length > 15 ? `\n…and ${result.targets.length - 15} more` : ''))
      .addFields(
        { name: 'Checked', value: `${result.total} members${result.complete ? '' : ' (Discord did not return the full list — run it again later)'}`, inline: false },
        ...(skippedLine ? [{ name: 'Left alone', value: skippedLine, inline: false }] : []),
        ...(result.unknown ? [{ name: 'Could not check', value: `${result.unknown} (their flags were not available)`, inline: false }] : []),
      );
    if (!result.targets.length) return interaction.editReply({ embeds: [embed] });
    if (result.action === 'none') {
      embed.setFooter({ text: 'The spammer action is set to "nothing", so there is nothing to confirm. Change it with /protection joingate spammer.' });
      return interaction.editReply({ embeds: [embed] });
    }
    const token = rememberScan(guildId, interaction.user.id, result.targets.map(m => m.id));
    embed.setFooter({ text: 'Each member is re-checked before anything happens. This expires in 15 minutes.' });
    return interaction.editReply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`spamscan_ok:${token}`)
          .setLabel(`${SCAN_LABEL[result.action]} all ${result.targets.length}`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`spamscan_no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))],
    });
  }

  if (sub === 'spammer-allow') {
    const user = interaction.options.getUser('user');
    if (!user) {
      const rows = await allowlist(guildId);
      return interaction.reply({
        content: rows.length
          ? `**On the server's protection allowlist** (${rows.length}), also shown by \`/protection allowlist list\`:\n`
            + rows.slice(0, 40).map(r => `<@${r.user_id}> · added by ${r.added_by ? `<@${r.added_by}>` : 'staff'} <t:${ts(r.added_at)}:R>`).join('\n')
          : 'Nobody is allowlisted. `/protection joingate spammer-allow user:` adds someone.',
        allowedMentions: { parse: [] }, ...EPHEMERAL });
    }
    if (interaction.options.getBoolean('remove')) {
      let removed;
      try { removed = await removeAllow(interaction.guild, user.id, interaction.user.id); } catch (err) {
        return interaction.reply({ content: err.message, allowedMentions: { parse: [] }, ...EPHEMERAL });
      }
      return interaction.reply({
        content: removed ? `${user} is off the allowlist; the spammer check applies to them again.` : `${user} was not on the allowlist.`,
        allowedMentions: { parse: [] }, ...EPHEMERAL });
    }
    await addAllow(interaction.guild, user.id, interaction.user.id);
    return interaction.reply({
      content: `${user} is on the server's protection allowlist: the spammer check, spammer scans and every other automatic protection leave them alone.`,
      allowedMentions: { parse: [] }, ...EPHEMERAL });
  }

  return interaction.reply({ content: 'Unknown subcommand.', ...EPHEMERAL });
}

export default { execute };
