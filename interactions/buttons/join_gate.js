/*
 * Join-gate application: the apply button, the form, and the staff decision.
 *
 * All three live together because they are one conversation, and two of the three happen in a DM
 * where there is no guild context at all — `interaction.guild` is null and `interaction.member`
 * does not exist. Everything the handler needs therefore rides in the customId, which also makes
 * these message-independent: a restart mid-application does not strand anybody.
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { logFeatureEvent, userLabel } from '../../core/feature-log.js';
import {
  getConfig, latestApplication, buildApplicationModal, reviewEmbed, reviewButtons, inviteTarget, overRejoinLimit,
} from '../../core/join-gate.js';

const EPHEMERAL = { flags: 64 };

/** `jgate_apply:<guildId>` — pressed in a DM, from the removal message. */
export async function handleJoinGateApply(interaction) {
  const guildId = interaction.customId.split(':')[1];
  const guild = interaction.client.guilds.cache.get(guildId);
  if (!guild) {
    return interaction.reply({ content: 'That server is no longer reachable from here.', ...EPHEMERAL });
  }

  const existing = await latestApplication(guildId, interaction.user.id);
  if (existing?.status === 'pending') {
    return interaction.reply({
      content: `Your application to **${guild.name}** is already in — a moderator has not decided yet. `
        + 'You will get a DM as soon as they do.', ...EPHEMERAL });
  }
  // An approval lets them in, but the rejoin limit counts again from it: someone who has since gone
  // over the limit is removed with this button, and needs a fresh application, not "already approved".
  if (existing?.status === 'approved' && !(await overRejoinLimit(guildId, interaction.user.id))) {
    return interaction.reply({
      content: `You have already been approved for **${guild.name}**. Rejoin and the gate will let you through.`,
      ...EPHEMERAL });
  }

  return interaction.showModal(buildApplicationModal(guildId, guild.name));
}

/** `jgate_form:<guildId>` — the submitted answers. */
export async function handleJoinGateSubmit(interaction) {
  const guildId = interaction.customId.split(':')[1];
  const guild = interaction.client.guilds.cache.get(guildId);
  if (!guild) return interaction.reply({ content: 'That server is no longer reachable from here.', ...EPHEMERAL });

  await interaction.deferReply(EPHEMERAL);

  const cfg = await getConfig(guildId);
  const who = interaction.fields.getTextInputValue('who');
  const how = interaction.fields.getTextInputValue('how');
  const why = interaction.fields.getTextInputValue('why');

  // Re-check rather than trust the button: the form can sit open indefinitely, and a moderator may
  // have decided in the meantime.
  const existing = await latestApplication(guildId, interaction.user.id);
  if (existing?.status === 'pending') {
    return interaction.editReply('You already have an application waiting — this one was not added.');
  }

  const [res] = await pool.execute(
    `INSERT INTO join_gate_applications
       (guild_id, user_id, username, account_created_at, status, who_they_are, how_found, why_join)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [guildId, interaction.user.id, interaction.user.username.slice(0, 100),
      new Date(interaction.user.createdTimestamp), who, how, why]);
  const appId = res.insertId;

  const [[app]] = await pool.execute('SELECT * FROM join_gate_applications WHERE id = ?', [appId]);

  // Getting it in front of staff is the whole point, so a missing review channel is loud.
  const channel = cfg?.review_channel_id
    ? await guild.channels.fetch(cfg.review_channel_id).catch(() => null)
    : null;
  if (!channel?.isTextBased?.()) {
    logger.error(`[JoinGate] application #${appId} for ${guildId} has NOWHERE to go — review channel `
      + `${cfg?.review_channel_id ?? 'unset'} is missing. Set one with /protection joingate.`);
    // With no review channel the server log is the only place staff can see it arrive.
    void logFeatureEvent(() => (guild), 'join-gate.applied', () => ({
      title: '📝 Application Submitted',
      fields: [
        ['Applicant', userLabel(interaction.user)],
        ['Application', `#${appId}`],
        ['Account created', `<t:${Math.floor(interaction.user.createdTimestamp / 1000)}:R>`],
        ['Review channel', 'Not set or unreachable — the application was saved but not posted for review', false],
      ],
    }));
    return interaction.editReply(
      'Your application was saved, but I could not reach the staff channel to post it. '
      + 'Please contact a moderator directly and mention application #' + appId + '.');
  }

  const posted = await channel.send({
    embeds: [reviewEmbed(app, interaction.user, guild)],
    components: [reviewButtons(appId)],
  }).catch(err => { logger.error(`[JoinGate] could not post application #${appId}: ${err.message}`); return null; });

  if (posted) {
    await pool.execute('UPDATE join_gate_applications SET review_message_id = ? WHERE id = ?', [posted.id, appId]);
  }

  // Pressed in a DM: `guild` comes from the customId. The review post is the staff copy, so the server
  // log skips the review channel when that post went through.
  void logFeatureEvent(() => (guild), 'join-gate.applied', () => ({
    title: '📝 Application Submitted',
    fields: [
      ['Applicant', userLabel(interaction.user)],
      ['Application', `#${appId}`],
      ['Account created', `<t:${Math.floor(interaction.user.createdTimestamp / 1000)}:R>`],
      ['Review channel', posted ? `<#${channel.id}>` : 'Could not post it there — check the bot can send in that channel'],
    ],
    url: posted?.url,
    avoidChannelIds: posted ? [channel.id] : [],
  }));

  logger.info(`[JoinGate] application #${appId} submitted for ${guildId} by ${interaction.user.tag}`);
  return interaction.editReply(
    `Sent. Your application to **${guild.name}** is with the moderators — you will get a DM either way, `
    + 'and an invite with it if you are approved.');
}

/** `jgate_ok:<id>` / `jgate_no:<id>` — pressed by staff in the review channel. */
export async function handleJoinGateDecision(interaction) {
  const [kind, rawId] = interaction.customId.split(':');
  const appId = Number(rawId);
  const approve = kind === 'jgate_ok';

  const [[app]] = await pool.execute('SELECT * FROM join_gate_applications WHERE id = ?', [appId]);
  if (!app) return interaction.reply({ content: `Application #${appId} no longer exists.`, ...EPHEMERAL });

  // The button lives in the guild it belongs to, so permissions are checked there.
  if (interaction.guildId !== app.guild_id) {
    return interaction.reply({ content: 'That application belongs to a different server.', ...EPHEMERAL });
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    return interaction.reply({ content: 'Only moderators can decide applications.', ...EPHEMERAL });
  }
  if (app.status !== 'pending') {
    return interaction.reply({
      content: `Application #${appId} was already **${app.status}**${app.decided_by ? ` by <@${app.decided_by}>` : ''}.`,
      ...EPHEMERAL });
  }

  await interaction.deferUpdate();

  const guild = interaction.guild;
  const cfg = await getConfig(app.guild_id);
  let inviteCode = null;
  let dmNote = 'their DMs are closed';

  // Mark the decision BEFORE the invite: the gate reads this row on rejoin, and an approved person
  // arriving before the write lands would be kicked by the very gate that just cleared them.
  await pool.execute(
    'UPDATE join_gate_applications SET status = ?, decided_by = ?, decided_at = NOW() WHERE id = ?',
    [approve ? 'approved' : 'denied', interaction.user.id, appId]);

  if (approve) {
    const target = await inviteTarget(guild, cfg);
    if (target) {
      const invite = await guild.invites.create(target.id, {
        maxUses: 1, maxAge: 86_400, unique: true,
        reason: `Join-gate application #${appId} approved by ${interaction.user.tag}`,
      }).catch(err => { logger.warn(`[JoinGate] invite creation failed for #${appId}: ${err.message}`); return null; });
      if (invite) {
        inviteCode = invite.code;
        await pool.execute('UPDATE join_gate_applications SET invite_code = ? WHERE id = ?', [invite.code, appId]);
      }
    }
  }

  const user = await interaction.client.users.fetch(app.user_id).catch(() => null);
  if (user) {
    const embed = approve
      ? new EmbedBuilder().setColor(0x2ECC71)
        .setTitle(`You're in — ${guild.name}`)
        .setDescription('Your application was approved.'
          + (inviteCode
            ? `\n\nHere is your invite: https://discord.gg/${inviteCode}\nIt works once and expires in 24 hours.`
            : '\n\nAsk the moderator who approved you for an invite — I could not create one automatically.')
          + '\n\nThe age check will not stop you again.')
      : new EmbedBuilder().setColor(0xC0392B)
        .setTitle(`Your application to ${guild.name} was declined`)
        .setDescription('A moderator read it and decided not to admit you at this time. '
          + 'This is not a ban — you are welcome to apply again, and once your account is past the '
          + 'age threshold the gate stops applying to you altogether.');
    const sent = await user.send({ embeds: [embed] }).then(() => true).catch(() => false);
    dmNote = sent ? 'they have been told' : '**their DMs are closed — tell them yourself**';
  }

  const decided = reviewEmbed({ ...app, status: approve ? 'approved' : 'denied' }, user, guild)
    .setColor(approve ? 0x2ECC71 : 0xC0392B)
    .setTitle(`${approve ? '✅ Approved' : '✖️ Declined'} — application #${appId}`)
    .setFooter({ text: `${approve ? 'Approved' : 'Declined'} by ${interaction.user.tag} · ${dmNote}`
      + (inviteCode ? ` · invite ${inviteCode}` : '') });

  await interaction.message.edit({ embeds: [decided], components: [reviewButtons(appId, true)] }).catch(() => {});

  // The review message just edited shows the decision, so the server log skips the review channel.
  void logFeatureEvent(() => (guild), () => (approve ? 'join-gate.approved' : 'join-gate.declined'), () => ({
    title: approve ? '✅ Application Approved' : '✖️ Application Declined',
    fields: [
      ['Applicant', userLabel(user ?? app.user_id)],
      ['Moderator', userLabel(interaction.user)],
      ['Application', `#${appId}`],
      ['Invite', approve ? (inviteCode ? 'Sent by DM — single use, expires in 24 hours' : 'Could not be created') : null],
      ['They were told', dmNote === 'they have been told' ? 'Yes — by DM' : 'No — they could not be sent a DM'],
    ],
    url: interaction.message.url,
    avoidChannelIds: [interaction.channelId, cfg?.review_channel_id],
  }));
  logger.info(`[JoinGate] application #${appId} ${approve ? 'approved' : 'denied'} by ${interaction.user.tag}`);
}

export default { handleJoinGateApply, handleJoinGateSubmit, handleJoinGateDecision };
