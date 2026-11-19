/*
 * Account-age join gate — see migrations/213_join_gate.js for why this removes members rather than
 * quarantining them with a role.
 *
 * Three outcomes at join, decided purely on how old the Discord account is:
 *
 *   < kick_under_hours   removed, DM explains when to come back
 *   < apply_under_days   removed, DM carries an Apply button; staff decide; approval pre-clears them
 *   otherwise            untouched — the gate does nothing and costs one cheap config read
 *
 * An approved application outranks age entirely. Staff saying "this person is fine" has to mean
 * they get in, even at three hours old, or approval is a lie.
 *
 * ORDER MATTERS: the DM is sent BEFORE the kick. Discord only reliably delivers a DM while a mutual
 * guild exists, so kicking first produces a silent removal — exactly the "the bot ate my join with
 * no explanation" experience this feature is supposed to prevent.
 */
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  PermissionFlagsBits, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { tierFor, humanAge, HOUR } from '../utils/join-gate-age.js';
import { overLimit, normaliseAction, ordinal } from '../utils/join-history-logic.js';
import { countJoins } from './join-history.js';
import { checkSpammerJoin } from './spammer-guard.js';
import { checkNamesOnJoin } from './name-filters.js';
import { checkAvatarOnJoin } from './avatar-protection.js';
import { checkNetworkOnJoin } from './network-gate.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { protectionHold } from './protection-exempt.js';
import { whyCannot, whyFailed, reportManualAction } from './manual-action.js';

export { tierFor, humanAge };

const cache = new Map();
const TTL = 60_000;

export async function getConfig(guildId) {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < TTL) return hit.cfg;
  let cfg = null;
  try {
    const [[row]] = await pool.execute('SELECT * FROM join_gate_config WHERE guild_id = ?', [guildId]);
    cfg = row || null;
  } catch { cfg = null; }          // table absent → feature simply off
  cache.set(guildId, { cfg, at: Date.now() });
  return cfg;
}

export function invalidate(guildId) { cache.delete(guildId); }

export async function setConfig(guildId, patch) {
  // `is_enabled` / `verification_*` deliberately absent: they were a second verification config that
  // nothing enforced, folded into verify_config by migrations/328_verify_prune.js (core/verification.js).
  const cols = ['age_gate_enabled', 'kick_under_hours', 'apply_under_days',
    'review_channel_id', 'invite_channel_id', 'log_channel_id',
    'action', 'block_default_avatar',
    'rejoin_limit_enabled', 'rejoin_max_joins', 'rejoin_window_days', 'rejoin_action',
    'spammer_enabled', 'spammer_action', 'spammer_role_id', 'spammer_silent',
    // Name filters (core/name-filters.js, migrations/324_name_filters.js).
    'name_filters_enabled', 'name_fuzzy', 'name_collapse', 'name_flag_role_id', 'name_timeout_minutes', 'name_dm',
    'name_generated_enabled', 'name_generated_action', 'name_autopilot_enabled', 'name_autopilot_action',
    'name_autopilot_managers', 'name_autopilot_roles', 'name_templates',
    // Avatar protection (core/avatar-protection.js, migrations/326_avatar_protection.js).
    'avatar_enabled', 'avatar_auto_threshold', 'avatar_review_threshold', 'avatar_action', 'avatar_flag_role_id',
    'avatar_timeout_minutes', 'avatar_dm', 'avatar_scam_enabled', 'avatar_scam_action', 'avatar_autopilot',
    // NSFW avatars (core/nsfw-protection.js, migrations/330_nsfw_cleanup.js).
    'nsfw_avatar_enabled', 'nsfw_avatar_action', 'nsfw_avatar_act_threshold', 'nsfw_avatar_review_threshold',
    'nsfw_avatar_daily_cap', 'nsfw_avatar_dm',
    // Auto-prune (core/auto-prune.js, migrations/328_verify_prune.js).
    'prune_enabled', 'prune_minutes', 'prune_action', 'prune_dm', 'prune_bypass_roles', 'prune_enabled_at',
    // Inactivity prune (core/inactivity-prune.js, migrations/332_prune_activity.js). The last-sweep columns are
    // written by the sweep itself.
    'inactive_never_enabled', 'inactive_never_days', 'inactive_never_action', 'inactive_quiet_enabled', 'inactive_quiet_days',
    'inactive_quiet_action', 'inactive_exempt_roles', 'inactive_exempt_boosters', 'inactive_exempt_staff',
    'inactive_min_member_days', 'inactive_warn_days', 'inactive_max_per_sweep', 'inactive_daily_cap',
    // Network Intel (core/network-gate.js, migrations/365_network_intel.js).
    'network_intel_enabled', 'network_blacklist_action', 'network_report_threshold', 'network_report_window_hours',
    'network_lurker_enabled', 'network_lurker_min_guilds', 'network_lurker_max_active_pct',
    'network_lurker_min_account_days', 'network_lurker_action',
    'dm_report_enabled', 'dm_report_channel_id'];
  const set = cols.filter(c => patch[c] !== undefined);
  if (!set.length) return getConfig(guildId);
  await pool.execute(
    `INSERT INTO join_gate_config (guild_id, ${set.join(', ')}) VALUES (?, ${set.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${set.map(c => `${c} = VALUES(${c})`).join(', ')}`,
    [guildId, ...set.map(c => patch[c])]);

  // `min_account_age_days` is the same setting this feature calls `kick_under_hours`, in a coarser
  // unit, and it predates it. Keeping the two in step means the security page and this gate can
  // never quote different numbers at the same operator — the alternative is two fields that look
  // authoritative and disagree.
  if (patch.kick_under_hours !== undefined) {
    await pool.execute('UPDATE join_gate_config SET min_account_age_days = ? WHERE guild_id = ?',
      [Math.max(0, Math.ceil(Number(patch.kick_under_hours) / 24)), guildId]).catch(() => {});
  }
  invalidate(guildId);
  return getConfig(guildId);
}

/** The most recent application, whatever its state. */
export async function latestApplication(guildId, userId) {
  const [[row]] = await pool.execute(
    'SELECT * FROM join_gate_applications WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1',
    [guildId, userId]);
  return row || null;
}

async function record(guildId, user, action, ageHours, dmDelivered, detail = null) {
  await pool.execute(
    `INSERT INTO join_gate_events (guild_id, user_id, username, action, account_age_hours, dm_delivered, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [guildId, user.id, user.username?.slice(0, 100) ?? null, action,
      Number.isFinite(ageHours) ? Math.round(ageHours) : null, dmDelivered ? 1 : 0, detail?.slice(0, 255) ?? null],
  ).catch(err => logger.error(`[JoinGate] could not record ${action} for ${user.id}: ${err.message}`));
}

/**
 * The gate. Returns what it did, for the caller's logs. Anything it removed is 'kicked_new',
 * 'kicked_apply', 'rejoin_removed', 'spammer_removed', 'name_removed' or 'avatar_removed' (see isRemoval).
 * @returns {Promise<'off'|'too_old_to_care'|'exempt'|'allowed'|'kicked_new'|'kicked_apply'|'rejoin_removed'|'spammer_removed'|'name_removed'|'avatar_removed'|'failed'>}
 */
export async function checkJoin(member) {
  const cfg = await getConfig(member.guild.id);
  if (!cfg) return 'off';
  if (member.user.bot) return 'exempt';

  // Discord's own spammer flag first (core/spammer-guard.js): it needs no history and no age, and
  // someone it removes needs no further checks. null carries on to the rules below.
  if (cfg.spammer_enabled) {
    const verdict = await checkSpammerJoin(member, cfg);
    if (verdict) return verdict;
  }

  // CertiFried Network Intel (core/network-gate.js): shared blacklist from DM-spam reports crossing
  // threshold across the network, plus the "joined-many-posted-none" lurker signal. Runs after the
  // Discord-flag check (external truth first) but before name/avatar heuristics — a confirmed
  // network bad-actor should not need to also match a username rule.
  if (cfg.network_intel_enabled || cfg.network_lurker_enabled) {
    const verdict = await checkNetworkOnJoin(member, cfg);
    if (verdict) return verdict;
  }

  // Name filters and the generated-username check (core/name-filters.js): the member's names
  // against the server's filters. 'name_removed' when it kicked or banned them; a flag, timeout or
  // log-only match carries on to the rules below.
  if (cfg.name_filters_enabled || cfg.name_generated_enabled) {
    const verdict = await checkNamesOnJoin(member, cfg);
    if (verdict) return verdict;
  }

  // Avatar protection (core/avatar-protection.js): the member's avatars against the server's protected
  // images and the exact scam-avatar list. 'avatar_removed' when it kicked or banned them; anything else
  // (flag, timeout, review queue, log only) carries on to the rules below. The NSFW avatar check
  // (core/nsfw-protection.js) is started from there too and finishes in the background.
  if (cfg.avatar_enabled || cfg.nsfw_avatar_enabled) {
    const verdict = await checkAvatarOnJoin(member, cfg);
    if (verdict) return verdict;
  }

  // Rejoin limit first: it applies whatever the account's age, and someone it removes needs no
  // further checks. It returns null to let the age gate below have its say.
  if (cfg.rejoin_limit_enabled) {
    const verdict = await checkRejoin(member, cfg);
    if (verdict) return verdict;
  }
  if (!cfg.age_gate_enabled) return 'off';

  const ageMs = Date.now() - member.user.createdTimestamp;
  const ageHours = ageMs / HOUR;
  const tier = tierFor(ageMs, cfg);

  // Old enough that none of this applies. The overwhelming majority of joins land here, so it is
  // the first thing checked after the config read.
  if (tier === 'pass') return 'too_old_to_care';

  // Staff decision beats the clock.
  const app = await latestApplication(member.guild.id, member.id);
  if (app?.status === 'approved') {
    await record(member.guild.id, member.user, 'allowed_approved', ageHours, 0, `application #${app.id}`);
    logger.info(`[JoinGate] ${member.user.tag} allowed into ${member.guild.id} — approved application #${app.id}`);
    void logFeatureEvent(() => (member.guild), 'join-gate.passedApproved', () => ({
      title: '✅ Passed — Approved Application',
      fields: [
        ['Member', userLabel(member)],
        ['Account age', humanAge(ageMs)],
        ['Application', `#${app.id}`],
      ],
    }));
    return 'allowed';
  }

  // `action` predates this feature and had nothing behind it. It does now:
  //   none  observe and log, remove nobody — how you trial the gate before arming it
  //   ban   remove permanently
  //   kick  (anything else, including the legacy default) the normal behaviour
  const action = String(cfg.action || 'kick').toLowerCase();
  if (action === 'none') {
    await record(member.guild.id, member.user, 'allowed_pending', ageHours, 0, 'action=none — observed only');
    logger.info(`[JoinGate] ${member.user.tag} would have been removed from ${member.guild.id} `
      + `(account ${humanAge(ageMs)}) — action is 'none', so nothing was done`);
    void logFeatureEvent(() => (member.guild), 'join-gate.observed', () => ({
      title: '👀 Join Gate (Observe Only)',
      description: 'This member would have been removed, but the gate is set to observe only, so nothing was done.',
      fields: [
        ['Member', userLabel(member)],
        ['Account age', humanAge(ageMs)],
        ['Would have been', tier === 'apply' ? 'Removed — application required' : 'Removed — account too new'],
      ],
    }));
    return 'allowed';
  }

  // Unified allowlist / global pause (core/protection-exempt.js logs the skip).
  const held = await protectionHold(member, action === 'ban' ? 'ban' : 'kick', 'Join gate (account age)');
  if (held) return held.why === 'exempt' ? 'exempt' : 'allowed';

  // Someone the bot cannot remove is someone the gate cannot govern; say so rather than pretend.
  const verb = action === 'ban' ? 'ban' : 'kick';
  const cannot = whyCannot(member.guild, verb, { member });
  if (cannot) {
    await record(member.guild.id, member.user, 'failed', ageHours, 0, cannot.text.replace(/\*\*/g, ''));
    await reportManualAction(member.guild, { action: verb, member, source: 'Join gate (account age)', problem: cannot });
    return 'failed';
  }

  // `block_default_avatar`, also previously inert. Scoped tightly on purpose: it only decides
  // whether an account ALREADY inside the gate's age window gets the application route, so it can
  // never touch an established member who simply never set a picture.
  const noAvatar = !member.user.avatar;
  const blockedForAvatar = tier === 'apply' && cfg.block_default_avatar && noAvatar;
  const applyTier = tier === 'apply' && !blockedForAvatar;
  const dm = applyTier
    ? applicationDM(member.guild, cfg, ageMs, app)
    : tooNewDM(member.guild, cfg, ageMs);

  let delivered = true;
  try { await member.send(dm); } catch { delivered = false; }

  const reason = applyTier
    ? `Join gate: account ${humanAge(ageMs)} old — application required`
    : blockedForAvatar
      ? `Join gate: account ${humanAge(ageMs)} old with no profile picture`
      : `Join gate: account ${humanAge(ageMs)} old — under the ${cfg.kick_under_hours}h minimum`;
  try {
    if (action === 'ban') await member.ban({ reason, deleteMessageSeconds: 0 });
    else await member.kick(reason);
  } catch (err) {
    await record(member.guild.id, member.user, 'failed', ageHours, delivered, err.message);
    logger.error(`[JoinGate] kick failed for ${member.user.tag} in ${member.guild.id}: ${err.message}`);
    const cause = whyFailed(err, member.guild, action === 'ban' ? 'ban' : 'kick', { member });
    if (cause) await reportManualAction(member.guild, { action: action === 'ban' ? 'ban' : 'kick', member, source: 'Join gate (account age)', problem: cause });
    else void logFeatureEvent(() => (member.guild), 'join-gate.failed', () => ({
      title: '⚠️ Join Gate Could Not Act',
      fields: [
        ['Member', userLabel(member)],
        ['Account age', humanAge(ageMs)],
        ['Tried to', action === 'ban' ? 'Ban' : 'Kick'],
        ['They were told', delivered ? 'Yes — by DM' : 'No — their DMs are closed'],
        ['Problem', err.message, false],
      ],
    }));
    return 'failed';
  }

  const outcome = applyTier ? 'kicked_apply' : 'kicked_new';
  await record(member.guild.id, member.user, outcome, ageHours, delivered,
    blockedForAvatar ? 'no profile picture' : null);
  logger.info(`[JoinGate] ${outcome} (${action}) ${member.user.tag} from ${member.guild.id} — `
    + `account ${humanAge(ageMs)} old, DM ${delivered ? 'sent' : 'BLOCKED'}`);

  // `outcome` says kicked_* for bans too; `action` says what really happened. announce() below posts
  // to the gate's own log/review channel, so the server log skips that channel.
  void logFeatureEvent(() => (member.guild),
    () => (action === 'ban' ? 'join-gate.banned' : applyTier ? 'join-gate.removedApply' : 'join-gate.removedNew'), () => ({
      title: action === 'ban' ? '🔨 Banned by Join Gate'
        : applyTier ? '📝 Removed — Application Required' : '🕒 Removed — Account Too New',
      fields: [
        ['Member', userLabel(member)],
        ['Account age', humanAge(ageMs)],
        ['Created', `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`],
        ['They were told', delivered ? 'Yes — by DM' : 'No — their DMs are closed'],
        ['No profile picture', blockedForAvatar ? 'Yes — so no application was offered' : null],
        ['Reason', reason, false],
      ],
      avoidChannelIds: [cfg.log_channel_id || cfg.review_channel_id],
    }));

  await announce(member.guild, cfg, member.user, outcome, ageMs, delivered);
  return outcome;
}

/** Did checkJoin take the member out of the server? The join pipeline stops when it did. */
export function isRemoval(verdict) {
  return verdict === 'kicked_new' || verdict === 'kicked_apply' || verdict === 'rejoin_removed'
    || verdict === 'spammer_removed' || verdict === 'name_removed' || verdict === 'avatar_removed'
    || verdict === 'network_removed';
}

/**
 * Is this member over the rejoin limit right now (counting from their latest approval)? The Apply
 * button needs this: an approval from long ago must not stop someone the limit removed since from
 * applying again.
 */
export async function overRejoinLimit(guildId, userId) {
  const cfg = await getConfig(guildId);
  if (!cfg?.rejoin_limit_enabled) return false;
  return (await rejoinStatus(guildId, userId, cfg)).over;
}

/**
 * Where a member stands against the rejoin limit, counted exactly as checkRejoin counts it (latest
 * reset, latest approved application, window). `over` uses the server's limit whether or not the rule
 * is switched on, so the dashboard can show who it would catch.
 */
export async function rejoinStatus(guildId, userId, cfg = null) {
  const config = cfg || await getConfig(guildId);
  const app = await latestApplication(guildId, userId);
  const approvedAt = app?.status === 'approved' ? app.decided_at : null;
  const { count, since, reset } = await countJoins(guildId, userId, {
    windowDays: config?.rejoin_window_days || 0, approvedAt });
  const max = Number(config?.rejoin_max_joins ?? 3);
  return { count, since, reset, approvedAt, max, over: overLimit(count, max) };
}

/**
 * The rejoin limit: someone who keeps leaving and coming back is removed once they pass the
 * server's number of joins. Counts every join on record (core/join-history.js) since the latest of a
 * staff reset, an unban, an approved application and the counting window.
 *
 * Returns 'rejoin_removed' when it removed them, or null to carry on: under the limit, observing
 * only, or unable to act. Unable to act fails open, as the rest of the gate does, and says so.
 */
async function checkRejoin(member, cfg) {
  const guild = member.guild;
  const app = await latestApplication(guild.id, member.id);
  const approvedAt = app?.status === 'approved' ? app.decided_at : null;
  const { count, since } = await countJoins(guild.id, member.id, { windowDays: cfg.rejoin_window_days, approvedAt });
  const max = Number(cfg.rejoin_max_joins);
  if (!overLimit(count, max)) return null;

  const action = normaliseAction(cfg.rejoin_action);
  const counted = since ? `since <t:${Math.floor(since.getTime() / 1000)}:D>` : 'ever';
  const baseFields = [
    ['Member', userLabel(member)],
    ['Joins', `${count} ${counted}, the limit is ${max}`],
  ];
  const doing = { ban: 'Ban', kick: 'Kick', apply: 'Remove with an application' }[action];

  if (action === 'none') {
    await record(guild.id, member.user, 'rejoin_observed', null, 0, `join ${count}, limit ${max}`);
    logger.info(`[JoinGate] ${member.user.tag} is over the rejoin limit in ${guild.id} (${count}/${max}) — observe only`);
    void logFeatureEvent(() => (guild), 'join-gate.rejoinLimit', () => ({
      title: '👀 Rejoin Limit (Observe Only)',
      description: 'This member is over the rejoin limit, but the rule is set to observe only, so nothing was done.',
      fields: baseFields,
    }));
    return null;
  }

  if (await protectionHold(member, action === 'ban' ? 'ban' : 'kick', 'Join gate (rejoin limit)')) return null;

  const cannot = whyCannot(guild, action === 'ban' ? 'ban' : 'kick', { member });
  if (cannot) {
    await record(guild.id, member.user, 'failed', null, 0, `rejoin limit: ${cannot.text.replace(/\*\*/g, '')}`);
    await reportManualAction(guild, { action: action === 'ban' ? 'ban' : 'kick', member, source: 'Join gate (rejoin limit)', problem: cannot });
    return null;
  }

  // DM first: Discord only reliably delivers while a mutual server exists.
  let delivered = true;
  try { await member.send(rejoinDM(guild, action, count, max, since)); } catch { delivered = false; }

  const reason = `Join gate: ${ordinal(count)} join${since ? ' in the counting period' : ''}, over the rejoin limit of ${max}`;
  try {
    if (action === 'ban') await member.ban({ reason, deleteMessageSeconds: 0 });
    else await member.kick(reason);
  } catch (err) {
    await record(guild.id, member.user, 'failed', null, delivered, `rejoin limit: ${err.message}`);
    logger.error(`[JoinGate] rejoin limit ${action} failed for ${member.user.tag} in ${guild.id}: ${err.message}`);
    const cause = whyFailed(err, guild, action === 'ban' ? 'ban' : 'kick', { member });
    if (cause) await reportManualAction(guild, { action: action === 'ban' ? 'ban' : 'kick', member, source: 'Join gate (rejoin limit)', problem: cause });
    else void logFeatureEvent(() => (guild), 'join-gate.failed', () => ({
      title: '⚠️ Rejoin Limit Could Not Act',
      fields: [...baseFields, ['Tried to', doing],
        ['They were told', delivered ? 'Yes — by DM' : 'No — their DMs are closed'], ['Problem', err.message, false]],
    }));
    return null;
  }

  const outcome = { ban: 'rejoin_banned', kick: 'rejoin_kicked', apply: 'rejoin_apply' }[action];
  await record(guild.id, member.user, outcome, null, delivered, `join ${count}, limit ${max}`);
  logger.info(`[JoinGate] ${outcome} ${member.user.tag} from ${guild.id} — join ${count}, limit ${max}, `
    + `DM ${delivered ? 'sent' : 'BLOCKED'}`);
  void logFeatureEvent(() => (guild), 'join-gate.rejoinLimit', () => ({
    title: { ban: '🔨 Banned — Rejoin Limit', kick: '🚪 Removed — Rejoin Limit', apply: '📝 Removed — Rejoin Limit, May Apply' }[action],
    fields: [...baseFields,
      ['They were told', delivered ? 'Yes — by DM' : 'No — their DMs are closed'],
      ['Let them back', action === 'ban' ? 'Unban them; that also resets their count'
        : action === 'apply' ? 'Approve their application' : '`/protection joingate reset`', false],
      ['Reason', reason, false]],
    avoidChannelIds: [cfg.log_channel_id || cfg.review_channel_id],
  }));
  await announceRejoin(guild, cfg, member.user, action, count, max, delivered);
  return 'rejoin_removed';
}

function rejoinDM(guild, action, count, max, since) {
  const counted = since ? ' in the period this server counts' : '';
  const why = `**Why:** you have joined **${guild.name}** ${count} times${counted}, and it allows ${max}. `
    + 'Repeatedly leaving and rejoining is how ban evasion, role farming and raids work, so the server limits it.';
  const embed = new EmbedBuilder().setColor(action === 'ban' ? 0xC0392B : 0xE67E22)
    .setTitle(action === 'ban' ? `You were banned from ${guild.name}` : `You were removed from ${guild.name}`);
  if (action === 'apply') {
    return {
      embeds: [embed.setDescription('This is automatic.\n\n' + why + '\n\n**How to come back:** press the button '
        + 'below and answer three questions. A moderator reads it, and if you are approved the bot DMs you an invite.')],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`jgate_apply:${guild.id}`).setLabel('Apply to rejoin')
          .setEmoji('📝').setStyle(ButtonStyle.Primary))],
    };
  }
  return {
    embeds: [embed.setDescription('This is automatic.\n\n' + why + '\n\n' + (action === 'ban'
      ? "**Coming back:** only the server's staff can lift this. If you think it is a mistake, contact them."
      : "**Coming back:** joining again will remove you again. If you think this is a mistake, contact the server's staff."))],
  };
}

/** The gate's own log/review channel, as announce() below does for the age rule. */
async function announceRejoin(guild, cfg, user, action, count, max, delivered) {
  const channelId = cfg.log_channel_id || cfg.review_channel_id;
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(delivered ? 0xE67E22 : 0xC0392B)
      .setTitle(action === 'ban' ? '🔨 Banned — rejoin limit' : action === 'apply' ? '📝 Removed — rejoin limit, may apply' : '🚪 Removed — rejoin limit')
      .setDescription(`**${user.tag ?? user.username}** (${user.id})`)
      .addFields(
        { name: 'Joins', value: `${count} (limit ${max})`, inline: true },
        { name: 'History', value: `\`/protection joingate history user:${user.id}\``, inline: true },
        { name: 'They were told', value: delivered ? 'Yes — by DM'
          : '**No — their DMs are closed.** They have no idea why this happened.', inline: false },
      )
      .setTimestamp()],
  }).catch(() => {});
}

/** Tell staff, so a removal is never invisible — especially one whose DM bounced. */
async function announce(guild, cfg, user, action, ageMs, delivered) {
  const channelId = cfg.log_channel_id || cfg.review_channel_id;
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(delivered ? 0xE67E22 : 0xC0392B)
      .setTitle(action === 'kicked_apply' ? '🕒 Removed — application required' : '🕒 Removed — account too new')
      .setDescription(`**${user.tag ?? user.username}** (${user.id})`)
      .addFields(
        { name: 'Account age', value: humanAge(ageMs), inline: true },
        { name: 'Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'They were told', value: delivered
          ? (action === 'kicked_apply' ? 'Yes — DM includes the application' : 'Yes — DM explains when to return')
          : '**No — their DMs are closed.** They have no idea why this happened.', inline: false },
      )
      .setTimestamp()],
  }).catch(() => {});
}

function tooNewDM(guild, cfg, ageMs) {
  const hours = cfg.kick_under_hours ?? 24;
  const days = cfg.apply_under_days ?? 7;
  return {
    embeds: [new EmbedBuilder()
      .setColor(0xE67E22)
      .setTitle(`You were removed from ${guild.name}`)
      .setDescription(
        'This is automatic and it is not personal — nothing you did caused it.\n\n'
        + `**Why:** your Discord account is ${humanAge(ageMs)} old, and this server does not admit `
        + `accounts under **${hours} hours**. Brand new accounts are what raids, scams and ban `
        + 'evasion are made of, and there is no history on a fresh account for us to judge.\n\n'
        + `**Coming back:** wait until your account is ${hours} hours old and rejoin. If it is still `
        + `under **${days} days** old at that point you will be asked to fill in a short application `
        + '— three questions, and a human reads it.')
      .setFooter({ text: 'You can reply to a moderator if you think this is a mistake.' })],
  };
}

function applicationDM(guild, cfg, ageMs, existing) {
  const days = cfg.apply_under_days ?? 7;

  if (existing?.status === 'pending') {
    return {
      embeds: [new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle(`Your application to ${guild.name} is still being read`)
        .setDescription(
          'You were removed again because the application you already sent has not been decided yet '
          + '— not because it was rejected.\n\nSit tight. You will get a DM either way, and an '
          + 'invite with it if you are approved.')],
    };
  }

  const denied = existing?.status === 'denied';
  return {
    embeds: [new EmbedBuilder()
      .setColor(denied ? 0xC0392B : 0x3498DB)
      .setTitle(`You were removed from ${guild.name}`)
      .setDescription(
        (denied
          ? 'A previous application of yours was declined, so joining again removed you.\n\n'
          : 'This is automatic and it is not personal — nothing you did caused it.\n\n')
        + `**Why:** your account is ${humanAge(ageMs)} old, and accounts under **${days} days** are `
        + 'admitted by application rather than automatically. New accounts are what raids and scam '
        + 'waves are made of, so we ask new ones to introduce themselves first.\n\n'
        + '**How to get in:** press the button below and answer three questions — who you are, how '
        + 'you found us, and why you want to join. A human reads every one. If you are approved the '
        + 'bot will DM you an invite straight back.')
      .setFooter({ text: denied ? 'You may apply again; be aware a moderator has declined once already.' : 'Once your account passes the age threshold, none of this applies any more.' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`jgate_apply:${guild.id}`)
        .setLabel(denied ? 'Apply again' : 'Apply to join')
        .setEmoji('📝')
        .setStyle(ButtonStyle.Primary))],
  };
}

/** The DM button → the form. */
export function buildApplicationModal(guildId, guildName) {
  return new ModalBuilder()
    .setCustomId(`jgate_form:${guildId}`)
    .setTitle(`Apply to ${String(guildName ?? 'the server').slice(0, 33)}`)
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('who').setLabel('Who are you?').setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Tell us a bit about yourself.').setRequired(true).setMaxLength(700)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('how').setLabel('How did you find us?').setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('A friend, a stream, a listing, a search…').setRequired(true).setMaxLength(500)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('why').setLabel('Why do you want to join?').setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('What are you hoping to get out of the server?').setRequired(true).setMaxLength(700)),
    );
}

export function reviewEmbed(app, user, guild) {
  return new EmbedBuilder()
    .setColor(0x3498DB)
    .setTitle(`📝 Membership application #${app.id}`)
    .setThumbnail(user?.displayAvatarURL?.() ?? null)
    .setDescription(`**${user?.tag ?? app.username ?? app.user_id}** (${app.user_id})`)
    .addFields(
      { name: 'Account created', value: app.account_created_at
        ? `<t:${Math.floor(new Date(app.account_created_at).getTime() / 1000)}:R>` : 'unknown', inline: true },
      { name: 'Server', value: guild?.name ?? app.guild_id, inline: true },
      { name: 'Who they are', value: (app.who_they_are || '—').slice(0, 1024) },
      { name: 'How they found us', value: (app.how_found || '—').slice(0, 1024) },
      { name: 'Why they want to join', value: (app.why_join || '—').slice(0, 1024) },
    )
    .setFooter({ text: 'Approving DMs them a single-use invite and lets the gate pass them through.' })
    .setTimestamp();
}

export function reviewButtons(appId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`jgate_ok:${appId}`).setLabel('Approve').setEmoji('✅')
      .setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`jgate_no:${appId}`).setLabel('Decline').setEmoji('✖️')
      .setStyle(ButtonStyle.Danger).setDisabled(disabled));
}

/**
 * Where an approval invite should point.
 *
 * Preference order: the configured channel, then the guild's own rules/system channel, then any
 * text channel the bot can actually make an invite in. An invite to a channel the newcomer cannot
 * see still works — Discord lands them in the server either way.
 */
export async function inviteTarget(guild, cfg) {
  const tryFetch = async (id) => (id ? guild.channels.fetch(id).catch(() => null) : null);
  const configured = await tryFetch(cfg?.invite_channel_id);
  if (configured?.isTextBased?.()) return configured;
  if (guild.rulesChannel) return guild.rulesChannel;
  if (guild.systemChannel) return guild.systemChannel;
  return guild.channels.cache.find(c =>
    c.isTextBased?.() && c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite)) ?? null;
}

export default {
  getConfig, setConfig, invalidate, checkJoin, isRemoval, overRejoinLimit, rejoinStatus, tierFor, latestApplication,
  buildApplicationModal, reviewEmbed, reviewButtons, inviteTarget, humanAge,
};
