/*
 * Verification — the live side (the rules are in core/verification-logic.js).
 *
 * ONE verification system, stored in `verify_config` (migration 328 folded the old join_gate_config
 * verification columns, which nothing enforced, into it). A new member gets the Unverified role (if
 * the server uses one) and has to press the panel's button before the Verified role opens the server:
 *
 *   mode 'button'   the original "I agree" click (every server that had verification before keeps it).
 *   mode 'captcha'  the button shows a server-rendered picture of a fresh 6-digit code, answered on a
 *                   keypad of buttons (or typed into a box). A wrong answer brings a new code; after
 *                   `captcha_attempts` wrong answers, or when the completion window
 *                   (`captcha_window_minutes` from joining, 0 = none) runs out, `fail_action` applies:
 *                   none (log only) | timeout | kick | ban — always through protectionHold, so exempt
 *                   members and a paused server are left alone.
 *
 * Codes live in memory only (a restart just means pressing Verify again); the wrong-answer count and
 * the window deadline live in the deadline queue (temp_access_members kind 'verify') so a restart
 * never hands out fresh tries or forgets a deadline. The one reaper (jobs/temp-access-reaper.js)
 * calls resolveVerifyDeadline for due rows, and sweepUnverifiedDays daily for the older "still
 * Unverified after N days" rule.
 *
 * Every outcome is a join_gate_events row (verify_*), which is where the stats, the 30-day
 * verification rate and the recent-attempts list come from.
 *
 * The setup wizard (dashboard Verification page, `/systems verification setup`) creates the channel and
 * roles that are missing, can lock every public channel behind verification and records each
 * overwrite it changed in verify_config.wizard_snapshot, so undo puts back exactly the bit it changed.
 */
import {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder,
    PermissionFlagsBits, Routes, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import sharp from 'sharp';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { protectionHold } from './protection-exempt.js';
import { formatMinutes } from './auto-prune-logic.js';
import {
    upsertDeadline, getDeadline, addAttempt, closeDeadline, listDeadlines, countDeadlines, cancelDeadlines, hasDeadline,
} from './temp-access-manager.js';
import {
    normaliseConfig, windowApplies, generateCode, answerMatches, newChallenge, challengeExpired, pressKey,
    refreshChallenge, canRefresh, entryDisplay, judgeAttempt, windowDeadline, secondsUntil, buildCaptchaSvg,
    buildLockPlan, undoEdit, snapshotRecord, mergeSnapshot, summariseStats, normaliseWizardOptions,
    CODE_LENGTH, VERIFY_EVENT_LABEL,
} from './verification-logic.js';
import { whyCannot, whyFailed, reportManualAction } from './manual-action.js';
import { LOG_EVENT_FILTER } from './verification-log-logic.js';

/** A problem the person can fix; its message is shown to them as-is. */
export class VerificationError extends Error {}

const TTL = 30_000;
const configCache = new Map();          // guildId -> { at, cfg }
const sessions = new Map();             // "guildId:userId" -> challenge (+ attemptsUsed, maxAttempts, deadline)
const wizardJobs = new Map();           // guildId -> progress of the running / last wizard or undo
const EPHEMERAL = { flags: 64 };
const PANEL_BUTTON_IDS = ['verify_accept', 'verify_member'];
const NEW = { gate: 'new-channel', verified: 'new-verified-role', unverified: 'new-unverified-role' };
const skey = (guildId, userId) => `${guildId}:${userId}`;
const ts = (ms) => Math.floor(ms / 1000);
const isElevated = (member) => member.id === member.guild.ownerId
    || member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild);

// ── config ───────────────────────────────────────────────────────────────────

export async function getVerifyConfig(guildId) {
    const hit = configCache.get(guildId);
    if (hit && Date.now() - hit.at < TTL) return hit.cfg;
    let cfg = null;
    try {
        const [[row]] = await pool.execute('SELECT * FROM verify_config WHERE guild_id = ?', [guildId]);
        cfg = normaliseConfig(row || null);
    } catch (err) {
        logger.warn(`[Verification] config load failed for ${guildId}: ${err.message}`);
    }
    configCache.set(guildId, { at: Date.now(), cfg });
    return cfg;
}

export function invalidateVerifyConfig(guildId) { configCache.delete(guildId); }

const COLUMNS = ['enabled', 'verified_role_id', 'unverified_role_id', 'gate_channel_id', 'gate_message_id', 'mode',
    'captcha_attempts', 'captcha_window_minutes', 'fail_action', 'fail_timeout_minutes', 'fail_dm',
    'panel_title', 'panel_text', 'unverified_kick_days'];

/**
 * Write verify_config columns (validated already — see validateSettings). The first save needs a
 * verified role: it is the one column the table cannot do without.
 */
export async function saveVerifyConfig(guildId, patch) {
    const set = COLUMNS.filter(c => patch[c] !== undefined);
    if (!set.length) return getVerifyConfig(guildId);
    invalidateVerifyConfig(guildId);
    const before = await getVerifyConfig(guildId);
    if (!before && !patch.verified_role_id) throw new VerificationError('Pick the verified role first (or run the setup wizard).');
    // UPDATE when the row exists: in strict mode an INSERT ... ON DUPLICATE KEY without
    // verified_role_id (NOT NULL, no default) is refused even though it would only update.
    const [res] = await pool.execute(
        `UPDATE verify_config SET ${set.map(c => `${c} = ?`).join(', ')} WHERE guild_id = ?`,
        [...set.map(c => patch[c]), guildId]);
    if (!res.affectedRows && !before) {
        await pool.execute(
            `INSERT INTO verify_config (guild_id, ${set.join(', ')}) VALUES (?, ${set.map(() => '?').join(', ')})
             ON DUPLICATE KEY UPDATE ${set.map(c => `${c} = VALUES(${c})`).join(', ')}`,
            [guildId, ...set.map(c => patch[c])]);
    }
    invalidateVerifyConfig(guildId);
    const after = await getVerifyConfig(guildId);
    // A deadline only exists while a CAPTCHA time limit applies; switching it off clears the clock.
    if (windowApplies(before) && !windowApplies(after)) {
        await cancelDeadlines(guildId, 'verify', 'verification time limit switched off').catch(() => {});
    }
    return after;
}

async function saveSnapshot(guildId, record) {
    await pool.execute('UPDATE verify_config SET wizard_snapshot = ?, wizard_at = NOW() WHERE guild_id = ?',
        [JSON.stringify(record), guildId]);
    invalidateVerifyConfig(guildId);
}

// ── events (stats + recent attempts) ─────────────────────────────────────────

/** One join_gate_events row. Never throws. */
export async function recordEvent(guildId, user, action, detail = null, dmDelivered = false) {
    const ageHours = user?.createdTimestamp ? (Date.now() - user.createdTimestamp) / 3_600_000 : null;
    await pool.execute(
        `INSERT INTO join_gate_events (guild_id, user_id, username, action, account_age_hours, dm_delivered, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [guildId, String(user?.id ?? user), user?.username?.slice(0, 100) ?? null, action,
            Number.isFinite(ageHours) ? Math.round(ageHours) : null, dmDelivered ? 1 : 0, detail ? String(detail).slice(0, 255) : null],
    ).catch(err => logger.error(`[Verification] could not record ${action} for ${user?.id ?? user}: ${err.message}`));
}

/** Every verification / auto-prune / inactivity event: one definition, shared with the page's activity log. */
const EVENT_FILTER = LOG_EVENT_FILTER;

/** Counts for the last `days` days, the per-day series, the live queue sizes. */
export async function verificationStats(guildId, days = 30) {
    const d = Math.max(1, Math.min(365, Number(days) || 30));
    const [rows] = await pool.execute(
        `SELECT action, COUNT(*) AS n FROM join_gate_events
          WHERE guild_id = ? AND created_at > NOW() - INTERVAL ${d} DAY AND ${EVENT_FILTER} GROUP BY action`, [guildId]);
    const [daily] = await pool.execute(
        `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day,
                SUM(action = 'verify_passed') AS passed,
                SUM(action IN ('verify_failed','verify_expired')) AS failed,
                SUM(action = 'prune_kicked') AS pruned
           FROM join_gate_events
          WHERE guild_id = ? AND created_at > NOW() - INTERVAL ${d} DAY AND ${EVENT_FILTER}
          GROUP BY day ORDER BY day`, [guildId]);
    const stats = summariseStats(rows);
    stats.couldNotAct = rows.filter(r => r.action === 'failed').reduce((a, r) => a + Number(r.n), 0);
    return {
        ...stats,
        days: d,
        daily: daily.map(r => ({ day: r.day, passed: Number(r.passed) || 0, failed: Number(r.failed) || 0, pruned: Number(r.pruned) || 0 })),
        pendingVerify: await countDeadlines(guildId, 'verify').catch(() => 0),
        pendingPrune: await countDeadlines(guildId, 'prune').catch(() => 0),
    };
}

/** The latest verification and auto-prune outcomes, newest first. */
export async function recentAttempts(guildId, limit = 50) {
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    const [rows] = await pool.execute(
        `SELECT id, user_id, username, action, detail, dm_delivered, created_at FROM join_gate_events
          WHERE guild_id = ? AND ${EVENT_FILTER} ORDER BY id DESC LIMIT ${n}`, [guildId]);
    return rows.map(r => ({ ...r, label: VERIFY_EVENT_LABEL[r.action] || r.action }));
}

// ── joining ──────────────────────────────────────────────────────────────────

/**
 * A member joined: hand out the Unverified role and, when a CAPTCHA time limit applies, start their
 * clock. Never throws.
 */
export async function onMemberJoin(member) {
    try {
        if (member.user.bot) return;
        const cfg = await getVerifyConfig(member.guild.id);
        if (!cfg?.enabled) return;
        if (cfg.verifiedRoleId && member.roles.cache.has(cfg.verifiedRoleId)) return; // restored on rejoin
        if (cfg.unverifiedRoleId) {
            const role = member.guild.roles.cache.get(cfg.unverifiedRoleId);
            if (role) {
                await member.roles.add(role, 'Verification: new member awaiting verification').catch(e => {
                    logger.warn('[Verification] Could not add unverified role', { err: e.message, guildId: member.guild.id, userId: member.id });
                });
            }
        }
        if (windowApplies(cfg)) {
            const deadline = windowDeadline(member.joinedTimestamp ?? Date.now(), cfg.windowMinutes);
            await upsertDeadline(member.guild.id, member.id, 'verify', secondsUntil(deadline, Date.now()), 'joined');
        }
    } catch (err) {
        logger.error('[Verification] join handling failed', { error: err.message, guildId: member.guild?.id, userId: member.id });
    }
}

/** Staff (or another bot) gave someone the Verified role by hand: their clock stops. Never throws. */
export async function onMemberUpdate(oldMember, newMember) {
    try {
        if (!hasDeadline(newMember.guild.id, newMember.id, 'verify')) return;
        const cfg = await getVerifyConfig(newMember.guild.id);
        if (!cfg?.verifiedRoleId) return;
        if (newMember.roles.cache.has(cfg.verifiedRoleId) && !oldMember.roles.cache.has(cfg.verifiedRoleId)) {
            await closeDeadline(newMember.guild.id, newMember.id, 'verify', 'passed', 'given the verified role');
            sessions.delete(skey(newMember.guild.id, newMember.id));
        }
    } catch (err) {
        logger.warn(`[Verification] role-change handling failed: ${err.message}`);
    }
}

// ── the panel ────────────────────────────────────────────────────────────────

export function panelText(cfg) {
    if (cfg.panelText) return cfg.panelText;
    if (cfg.mode === 'captcha') {
        const limit = cfg.windowMinutes > 0 ? ` within **${formatMinutes(cfg.windowMinutes)}** of joining` : '';
        return 'Press **Verify me** and type the code from the picture on the keypad to unlock the server.'
            + `\nYou have **${cfg.attempts}** ${cfg.attempts === 1 ? 'try' : 'tries'}${limit}.`;
    }
    return 'Read the rules, then press **I agree** to unlock the rest of the server.';
}

export function buildPanel(cfg, guild) {
    const captcha = cfg.mode === 'captcha';
    const embed = new EmbedBuilder()
        .setColor(captcha ? 0x5865F2 : 0x2ECC71)
        .setTitle(cfg.panelTitle || `Welcome to ${guild.name}`)
        .setDescription(panelText(cfg))
        .setFooter({ text: 'This keeps raids and spam bots out of the community.' });
    const button = new ButtonBuilder()
        .setCustomId('verify_accept')
        .setStyle(ButtonStyle.Success)
        .setLabel(captcha ? 'Verify me' : 'I agree')
        .setEmoji(captcha ? '🔐' : '✅');
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}

/** Post (or re-post) the panel; the previous one is deleted only if this bot posted it. */
export async function postPanel(guild, { channelId = null } = {}) {
    const cfg = await getVerifyConfig(guild.id);
    if (!cfg) throw new VerificationError('Set verification up first.');
    const targetId = channelId || cfg.channelId;
    if (!targetId) throw new VerificationError('Pick the channel the panel goes in.');
    const channel = guild.channels.cache.get(targetId) || await guild.channels.fetch(targetId).catch(() => null);
    if (!channel?.isTextBased?.() || channel.isThread?.()) throw new VerificationError('That channel is gone or is not a text channel.');
    const me = guild.members.me || await guild.members.fetchMe();
    const perms = channel.permissionsFor(me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        throw new VerificationError(`I need View Channel, Send Messages and Embed Links in #${channel.name}.`);
    }
    if (cfg.messageId && cfg.channelId) {
        const oldChannel = guild.channels.cache.get(cfg.channelId);
        const old = oldChannel?.messages ? await oldChannel.messages.fetch(cfg.messageId).catch(() => null) : null;
        const ours = old && old.author?.id === me.id
            && old.components?.some(row => row.components?.some(c => PANEL_BUTTON_IDS.includes(c.customId)));
        if (ours) await old.delete().catch(() => {});
    }
    const message = await channel.send(buildPanel(cfg, guild));
    await saveVerifyConfig(guild.id, { gate_channel_id: channel.id, gate_message_id: message.id });
    return message;
}

// ── verifying ────────────────────────────────────────────────────────────────

/** Why the bot cannot hand out the Verified role right now, or null. */
export async function roleProblem(guild, cfg) {
    const role = cfg?.verifiedRoleId ? guild.roles.cache.get(cfg.verifiedRoleId) : null;
    if (!role) return 'The verified role no longer exists — ping a mod.';
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) || me.roles.highest.position <= role.position) {
        return 'Bot hierarchy is misconfigured — ping a mod.';
    }
    return null;
}

/** Give the Verified role, take the Unverified one, stop the clock, record it. */
export async function grantVerified(member, cfg, { method = 'button', wrong = 0 } = {}) {
    const guild = member.guild;
    const role = guild.roles.cache.get(cfg.verifiedRoleId);
    try {
        await member.roles.add(role, method === 'captcha' ? 'Verification: CAPTCHA passed' : 'Verification: user accepted the rules');
        if (cfg.unverifiedRoleId && member.roles.cache.has(cfg.unverifiedRoleId)) {
            await member.roles.remove(cfg.unverifiedRoleId, 'Verification: cleanup').catch(() => {});
        }
    } catch (err) {
        logger.error(`[Verification] role toggle failed for ${member.id} in ${guild.id}: ${err.message}`);
        return { ok: false, message: 'Could not grant Verified — the bot is missing Manage Roles, or its role sits below Verified. Ping a mod.' };
    }
    sessions.delete(skey(guild.id, member.id));
    await closeDeadline(guild.id, member.id, 'verify', 'passed', method).catch(() => {});
    await recordEvent(guild.id, member.user, 'verify_passed', method === 'captcha' ? `CAPTCHA${wrong ? `, after ${wrong} wrong` : ''}` : 'I agree button');
    void logFeatureEvent(() => (guild), 'join-gate.verified', () => ({
        title: '✅ Member Verified',
        fields: [
            ['Member', userLabel(member)],
            ['Role given', `<@&${role.id}>`],
            ['Method', method === 'captcha' ? `CAPTCHA${wrong ? ` (${wrong} wrong first)` : ''}` : 'I agree button'],
            ['Joined', member.joinedTimestamp ? `<t:${ts(member.joinedTimestamp)}:R>` : null],
        ],
    }));
    return { ok: true };
}

/** A picture of the code (PNG). The SVG never leaves this process. */
export async function renderCaptcha(code) {
    return sharp(Buffer.from(buildCaptchaSvg(code))).png({ compressionLevel: 9 }).toBuffer();
}

function keypad(guildId, ch) {
    const b = (key, label, style = ButtonStyle.Secondary, disabled = false) =>
        new ButtonBuilder().setCustomId(`vcap:${guildId}:${key}`).setLabel(label).setStyle(style).setDisabled(disabled);
    return [
        new ActionRowBuilder().addComponents(...['1', '2', '3', '4', '5'].map(d => b(d, d))),
        new ActionRowBuilder().addComponents(...['6', '7', '8', '9', '0'].map(d => b(d, d))),
        new ActionRowBuilder().addComponents(
            b('back', '⌫'),
            b('clear', 'Clear'),
            b('ok', 'Submit', ButtonStyle.Success, (ch.entered || '').length < CODE_LENGTH),
            b('type', 'Type it', ButtonStyle.Primary),
            b('new', 'New image', ButtonStyle.Secondary, !canRefresh(ch)),
        ),
    ];
}

function challengeContent(ch, notice = null) {
    const remaining = Math.max(0, ch.maxAttempts - ch.attemptsUsed);
    return [
        notice,
        `Enter the **${CODE_LENGTH}-digit code** from the picture on the keypad, then press **Submit**.`,
        `**Entered:** \`${entryDisplay(ch.entered)}\``,
        `Tries left: **${remaining}** · this code expires <t:${ts(ch.expiresAt)}:R>`
            + (ch.deadline ? ` · finish by <t:${ts(ch.deadline)}:t>` : ''),
    ].filter(Boolean).join('\n');
}

async function challengeMessage(guildId, ch, notice = null) {
    const png = await renderCaptcha(ch.code);
    return {
        content: challengeContent(ch, notice),
        embeds: [new EmbedBuilder().setColor(0x5865F2).setImage('attachment://captcha.png')],
        files: [new AttachmentBuilder(png, { name: 'captcha.png' })],
        attachments: [],
        components: keypad(guildId, ch),
    };
}

const closedMessage = (content) => ({ content, embeds: [], attachments: [], files: [], components: [] });

/**
 * `verify_accept` (and the old `/admin verification setup` panel's `verify_member`): verify on the
 * spot in button mode, start a CAPTCHA otherwise.
 */
export async function handleVerifyButton(interaction) {
    const guild = interaction.guild;
    if (!guild) return;
    try {
        const cfg = await getVerifyConfig(guild.id);
        if (!cfg?.enabled) return interaction.reply({ content: 'Verification is not configured for this server.', ...EPHEMERAL });
        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'Could not load your membership — try again in a moment.', ...EPHEMERAL });
        if (cfg.verifiedRoleId && member.roles.cache.has(cfg.verifiedRoleId)) {
            return interaction.reply({ content: '✅ You are already verified. Welcome!', ...EPHEMERAL });
        }
        const problem = await roleProblem(guild, cfg);
        if (problem) {
            logger.error(`[Verification] ${guild.id}: ${problem}`);
            return interaction.reply({ content: problem, ...EPHEMERAL });
        }

        if (cfg.mode !== 'captcha') {
            const out = await grantVerified(member, cfg, { method: 'button' });
            return interaction.reply({ content: out.ok ? '✅ Verified. Enjoy the server!' : out.message, ...EPHEMERAL });
        }

        await interaction.deferReply(EPHEMERAL);
        let row = await getDeadline(guild.id, member.id, 'verify');
        if (!row || row.status !== 'pending') {
            // Joined before the CAPTCHA (or its time limit) was switched on, or a fresh round after a
            // log-only failure: the clock starts now.
            const deadline = windowApplies(cfg) ? windowDeadline(Date.now(), cfg.windowMinutes) : null;
            await upsertDeadline(guild.id, member.id, 'verify', secondsUntil(deadline, Date.now()), 'pressed Verify');
            row = await getDeadline(guild.id, member.id, 'verify');
        } else if (row.expires_ms != null && Date.now() >= row.expires_ms) {
            return interaction.editReply({ content: 'Your time to verify has run out. Please contact a moderator.' });
        }
        const ch = {
            ...newChallenge({ code: generateCode(), now: Date.now(), deadline: row?.expires_ms ?? null }),
            attemptsUsed: row?.attempts ?? 0, maxAttempts: cfg.attempts, deadline: row?.expires_ms ?? null,
        };
        sessions.set(skey(guild.id, member.id), ch);
        pruneSessions();
        return interaction.editReply(await challengeMessage(guild.id, ch));
    } catch (err) {
        logger.error('[Verification] verify button failed', { error: err.message, stack: err.stack, guildId: guild.id });
        const msg = { content: 'Verification hit an error — ping a mod.', ...EPHEMERAL };
        if (interaction.deferred) return interaction.editReply(msg).catch(() => {});
        if (!interaction.replied) return interaction.reply(msg).catch(() => {});
    }
}

function pruneSessions() {
    if (sessions.size < 2000) return;
    const now = Date.now();
    for (const [k, ch] of sessions) if (challengeExpired(ch, now)) sessions.delete(k);
}

export function buildAnswerModal(guildId) {
    return new ModalBuilder()
        .setCustomId(`vcapm:${guildId}`)
        .setTitle('Enter the code')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('code').setLabel(`The ${CODE_LENGTH} digits from the picture`)
                .setStyle(TextInputStyle.Short).setMinLength(CODE_LENGTH).setMaxLength(CODE_LENGTH + 6).setRequired(true)));
}

/** `vcap:<guildId>:<key>` — the keypad. */
export async function handleKeypad(interaction) {
    const [, guildId, key] = interaction.customId.split(':');
    if (guildId !== interaction.guildId) return interaction.reply({ content: 'This keypad belongs to another server.', ...EPHEMERAL });
    const k = skey(guildId, interaction.user.id);
    const ch = sessions.get(k);
    if (challengeExpired(ch, Date.now())) {
        sessions.delete(k);
        return interaction.update(closedMessage('This code has expired. Press the **Verify** button again for a new one.'));
    }
    try {
        if (key === 'type') return interaction.showModal(buildAnswerModal(guildId));
        if (key === 'ok') return submitAnswer(interaction, ch.entered);
        if (key === 'new') {
            if (!canRefresh(ch)) return interaction.reply({ content: 'No more new pictures for this code — answer it, or let it expire and press Verify again.', ...EPHEMERAL });
            const next = { ...ch, ...refreshChallenge(ch, { code: generateCode(), now: Date.now(), deadline: ch.deadline }) };
            sessions.set(k, next);
            await interaction.deferUpdate();
            return interaction.editReply(await challengeMessage(guildId, next));
        }
        const next = pressKey(ch, key);
        sessions.set(k, next);
        return interaction.update({ content: challengeContent(next), components: keypad(guildId, next) });
    } catch (err) {
        logger.error(`[Verification] keypad failed in ${guildId}: ${err.message}`);
        if (!interaction.replied && !interaction.deferred) return interaction.reply({ content: 'Something went wrong — press Verify again.', ...EPHEMERAL }).catch(() => {});
    }
}

/** `vcapm:<guildId>` — the typed answer. */
export async function handleAnswerModal(interaction) {
    const [, guildId] = interaction.customId.split(':');
    const k = skey(guildId, interaction.user.id);
    const ch = sessions.get(k);
    if (guildId !== interaction.guildId || challengeExpired(ch, Date.now())) {
        sessions.delete(k);
        if (interaction.isFromMessage?.()) return interaction.update(closedMessage('This code has expired. Press the **Verify** button again for a new one.'));
        return interaction.reply({ content: 'This code has expired. Press the **Verify** button again for a new one.', ...EPHEMERAL });
    }
    return submitAnswer(interaction, interaction.fields.getTextInputValue('code'));
}

async function submitAnswer(interaction, input) {
    const guild = interaction.guild;
    const k = skey(guild.id, interaction.user.id);
    const ch = sessions.get(k);
    sessions.delete(k);                     // one answer per code, whatever happens next
    await interaction.deferUpdate();
    if (!ch) return interaction.editReply(closedMessage('This code was already answered — press the Verify button again.')).catch(() => {});
    try {
        const cfg = await getVerifyConfig(guild.id);
        if (!cfg?.enabled || cfg.mode !== 'captcha') return interaction.editReply(closedMessage('Verification has changed since you started — press the Verify button again.'));
        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) return interaction.editReply(closedMessage('Could not load your membership — try again.'));
        const row = await getDeadline(guild.id, member.id, 'verify');
        if (!row || row.status !== 'pending') {
            return interaction.editReply(closedMessage(row?.status === 'expired'
                ? 'Your time to verify ran out before you answered.'
                : 'This verification has ended — press the Verify button again.'));
        }

        if (judgeAttempt({ correct: answerMatches(ch.code, input), attemptsUsed: row.attempts, maxAttempts: cfg.attempts }).outcome === 'passed') {
            const problem = await roleProblem(guild, cfg);
            if (problem) return interaction.editReply(closedMessage(problem));
            const out = await grantVerified(member, cfg, { method: 'captcha', wrong: row.attempts });
            return interaction.editReply(closedMessage(out.ok ? '✅ Verified — welcome to the server!' : out.message));
        }

        const used = (await addAttempt(guild.id, member.id, 'verify')) ?? row.attempts + 1;
        const verdict = judgeAttempt({ correct: false, attemptsUsed: used - 1, maxAttempts: cfg.attempts });
        if (verdict.outcome === 'failed') {
            await closeDeadline(guild.id, member.id, 'verify', 'failed', `${used} wrong codes`);
            await recordEvent(guild.id, member.user, 'verify_failed', `${used} wrong codes`);
            await interaction.editReply(closedMessage(cfg.failAction === 'none'
                ? '❌ That was your last try. A moderator has been notified — you can press Verify again later.'
                : '❌ That was your last try.'));
            await punish(member, cfg, 'wrong');
            return;
        }
        await recordEvent(guild.id, member.user, 'verify_wrong', `try ${used} of ${cfg.attempts}`);
        const next = {
            ...refreshChallenge(ch, { code: generateCode(), now: Date.now(), deadline: row.expires_ms, countsAsRefresh: false }),
            attemptsUsed: used, maxAttempts: cfg.attempts, deadline: row.expires_ms,
        };
        sessions.set(k, next);
        return interaction.editReply(await challengeMessage(guild.id, next, `❌ Wrong code — here is a new one. ${verdict.remaining} ${verdict.remaining === 1 ? 'try' : 'tries'} left.`));
    } catch (err) {
        logger.error(`[Verification] answer failed in ${guild.id}: ${err.message}`, { stack: err.stack });
        return interaction.editReply(closedMessage('Verification hit an error — press Verify again or ping a mod.')).catch(() => {});
    }
}

// ── failing ──────────────────────────────────────────────────────────────────

const ACTION_EVENT = { kick: 'verify_kicked', ban: 'verify_banned', timeout: 'verify_timedout' };
const ACTION_PAST = { kick: 'kicked', ban: 'banned', timeout: 'timed out', none: 'logged only' };

/**
 * Apply the fail action after too many wrong codes ('wrong') or a missed window ('window').
 * @returns {Promise<'logged'|'held'|'failed'|'kick'|'ban'|'timeout'>}
 */
export async function punish(member, cfg, why) {
    const guild = member.guild;
    const action = cfg.failAction;
    const what = why === 'window'
        ? `did not verify within ${formatMinutes(cfg.windowMinutes)}`
        : `entered ${cfg.attempts} wrong CAPTCHA codes`;
    const log = (outcome, extra = null) => void logFeatureEvent(() => (guild), 'join-gate.verifyFailed', () => ({
        title: outcome === 'logged' ? '🔐 Verification Failed (log only)' : outcome === 'held' ? '🔐 Verification Failed — Held' : `🔐 Verification Failed — ${ACTION_PAST[outcome] || outcome}`,
        fields: [['Member', userLabel(member)], ['Why', what], ['Action', ACTION_PAST[action]], ['Note', extra]],
    }));
    if (action === 'none') { log('logged'); return 'logged'; }

    const held = await protectionHold(member, action, 'Verification');
    if (held) {
        await recordEvent(guild.id, member.user, 'verify_held', `${action} held (${held.why})`);
        log('held', held.text);
        return 'held';
    }
    const cannot = whyCannot(guild, action, { member });
    if (cannot) {
        await recordEvent(guild.id, member.user, 'failed', `Verification: could not ${action} (role hierarchy or missing permission)`);
        log('failed', cannot.text.replace(/\*\*/g, ''));
        await reportManualAction(guild, { action, member, source: 'Verification', problem: cannot });
        return 'failed';
    }
    const reason = `Verification failed: ${what}`.replace(/[^\x20-\x7E]/g, '');
    let dm = false;
    if (cfg.failDm) {
        const tail = action === 'kick' ? ' You are welcome to rejoin and try again.' : '';
        const text = action === 'timeout'
            ? `You were timed out in **${guild.name}** for ${cfg.timeoutMinutes} minutes because you ${what}.`
            : `You were ${ACTION_PAST[action]} from **${guild.name}** because you ${what}.${tail}`;
        dm = await member.send(text).then(() => true).catch(() => false);
    }
    try {
        if (action === 'kick') await member.kick(reason);
        else if (action === 'ban') await guild.members.ban(member.id, { reason, deleteMessageSeconds: 0 });
        else await member.timeout(cfg.timeoutMinutes * 60_000, reason);
    } catch (err) {
        await recordEvent(guild.id, member.user, 'failed', `Verification: ${action} failed: ${err.message}`, dm);
        log('failed', err.message);
        const cause = whyFailed(err, guild, action, { member });
        if (cause) await reportManualAction(guild, { action, member, source: 'Verification', problem: cause });
        return 'failed';
    }
    await recordEvent(guild.id, member.user, ACTION_EVENT[action], what, dm);
    log(action);
    return action;
}

/**
 * The reaper's handler for a due 'verify' row (the completion window ran out).
 * @returns {Promise<boolean>} true when the member was removed (counts towards the sweep's kick cap)
 */
export async function resolveVerifyDeadline(guild, row) {
    const cfg = await getVerifyConfig(guild.id);
    if (!windowApplies(cfg)) {
        await closeDeadline(guild.id, row.user_id, 'verify', 'cancelled', 'time limit no longer applies');
        return false;
    }
    const member = await guild.members.fetch(row.user_id).catch(() => null);
    if (!member) { await closeDeadline(guild.id, row.user_id, 'verify', 'left', 'not in the server at the deadline'); return false; }
    if (member.roles.cache.has(cfg.verifiedRoleId)) { await closeDeadline(guild.id, row.user_id, 'verify', 'passed', 'verified at the deadline'); return false; }
    if (member.user.bot || isElevated(member)) { await closeDeadline(guild.id, row.user_id, 'verify', 'exempt', 'staff or bot'); return false; }
    sessions.delete(skey(guild.id, member.id));
    await closeDeadline(guild.id, member.id, 'verify', 'expired', `no verification within ${formatMinutes(cfg.windowMinutes)}`);
    await recordEvent(guild.id, member.user, 'verify_expired', `${formatMinutes(cfg.windowMinutes)} limit`);
    const done = await punish(member, cfg, 'window');
    return done === 'kick' || done === 'ban';
}

/**
 * The older rule: remove members who still hold the Unverified role N days after joining
 * (verify_config.unverified_kick_days). Daily, from the reaper. Through protectionHold now.
 */
export async function sweepUnverifiedDays(resolveGuild) {
    const [rows] = await pool.execute(
        'SELECT guild_id FROM verify_config WHERE enabled = 1 AND unverified_kick_days > 0 AND unverified_role_id IS NOT NULL');
    for (const { guild_id: guildId } of rows) {
        const guild = resolveGuild(guildId);
        if (!guild) { logger.warn(`[UnverifiedReaper] ${guildId}: no client has this guild cached, skipping`); continue; }
        try {
            await reapUnverified(guild, await getVerifyConfig(guildId));
        } catch (err) {
            logger.error(`[UnverifiedReaper] guild ${guildId} failed: ${err.message}`, { stack: err.stack });
        }
    }
}

async function reapUnverified(guild, cfg) {
    if (!cfg?.unverifiedRoleId || !cfg.unverifiedKickDays) return;
    // The returned collection, not the cache: the member cache is capped (200 per server, core/bot-manager.js),
    // so after a full fetch the cache holds only a slice of a bigger server.
    const all = await guild.members.fetch();
    const cutoff = Date.now() - cfg.unverifiedKickDays * 86_400_000;
    const victims = all.filter(m => !m.user.bot && m.roles.cache.has(cfg.unverifiedRoleId)
        && m.joinedTimestamp && m.joinedTimestamp < cutoff);
    if (!victims.size) return;
    let kicked = 0, failed = 0, held = 0;
    for (const m of victims.values()) {
        if (await protectionHold(m, 'kick', 'Unverified cleanup')) { held++; continue; }
        const cannot = whyCannot(guild, 'kick', { member: m });
        if (cannot) {
            failed++;
            await reportManualAction(guild, { action: 'kick', member: m, source: 'Unverified cleanup', problem: cannot, count: victims.size });
            continue;
        }
        try {
            await m.send(`Hey! You joined **${guild.name}** but didn't verify within ${cfg.unverifiedKickDays} days, so you've been removed to keep the server tidy. `
                + 'You\'re welcome to rejoin any time and verify.').catch(() => {});
            await m.kick(`Unverified for ${cfg.unverifiedKickDays}+ days`);
            await recordEvent(guild.id, m.user, 'verify_kicked', `still unverified after ${cfg.unverifiedKickDays} days`);
            kicked++;
        } catch (err) {
            failed++;
            logger.warn(`[UnverifiedReaper] ${guild.id}: kick failed for ${m.user.tag}: ${err.message}`);
            const cause = whyFailed(err, guild, 'kick', { member: m });
            if (cause) await reportManualAction(guild, { action: 'kick', member: m, source: 'Unverified cleanup', problem: cause, count: victims.size });
        }
    }
    logger.info(`[UnverifiedReaper] ${guild.id}: kicked=${kicked}, held=${held}, failed=${failed}`);
    void logFeatureEvent(() => (guild), 'join-gate.unverifiedKicked', () => ({
        title: '🧹 Unverified Members Removed',
        description: `Members who still had the Unverified role ${cfg.unverifiedKickDays}+ days after joining.`,
        fields: [
            ['Removed', String(kicked)],
            ['Held (exempt or paused)', held ? String(held) : null],
            ['Could not remove', failed ? String(failed) : null],
            ['Unverified role', `<@&${cfg.unverifiedRoleId}>`],
            ['Limit', `${cfg.unverifiedKickDays} days`],
        ],
    }));
}

/** Pending CAPTCHA deadlines, for the dashboard. */
export async function verifyQueue(guildId) {
    return listDeadlines(guildId, 'verify', 200);
}

// ── setup wizard ─────────────────────────────────────────────────────────────

/** The guild as plain data for buildLockPlan. */
function snapshotGuild(guild, ids) {
    const me = guild.members.me;
    const channels = [...guild.channels.cache.values()]
        .filter(c => !c.isThread?.() && c.permissionOverwrites)
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
        .map(c => {
            const perms = me ? c.permissionsFor(me) : null;
            return {
                id: c.id, name: c.name, type: c.type, parentId: c.parentId,
                manageable: !!perms?.has(PermissionFlagsBits.ManageRoles) && !!perms?.has(PermissionFlagsBits.ViewChannel),
                overwrites: [...c.permissionOverwrites.cache.values()].map(o => ({
                    id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString(),
                })),
            };
        });
    return {
        everyoneId: guild.id,
        everyoneBaseView: guild.roles.everyone.permissions.has(PermissionFlagsBits.ViewChannel),
        rulesChannelId: guild.rulesChannelId,
        updatesChannelId: guild.publicUpdatesChannelId,
        channels,
        ...ids,
    };
}

/** Check the wizard's inputs against the live guild; throws VerificationError listing every problem. */
async function checkWizard(guild, input) {
    const { options, errors } = normaliseWizardOptions(input);
    const me = guild.members.me || await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) errors.push('I need the Manage Roles permission.');
    if (!options.channelId && !me.permissions.has(PermissionFlagsBits.ManageChannels)) errors.push('I need Manage Channels to create the verification channel.');
    if (options.channelId) {
        const ch = guild.channels.cache.get(options.channelId);
        if (!ch?.isTextBased?.() || ch.isThread?.()) errors.push('The verification channel must be a text channel in this server.');
    }
    for (const [idKey, label] of [['verifiedRoleId', 'verified'], ['unverifiedRoleId', 'unverified']]) {
        const id = options[idKey];
        if (!id) continue;
        const role = guild.roles.cache.get(id);
        if (!role) errors.push(`The ${label} role does not exist.`);
        else if (role.managed || role.id === guild.id) errors.push(`The ${label} role cannot be @everyone or a role another app manages.`);
        else if (me.roles.highest.position <= role.position) errors.push(`My highest role must be above the ${label} role (${role.name}).`);
    }
    if (errors.length) throw new VerificationError(errors.join(' '));
    return options;
}

const TARGET = (guild, id) => {
    if (id === guild.id) return '@everyone';
    if (id === NEW.verified) return '@Verified (new)';
    if (id === NEW.unverified) return '@Unverified (new)';
    const role = guild.roles.cache.get(id);
    return role ? `@${role.name}` : id;
};

/** What the wizard would do, without doing it. */
export async function wizardPreview(guild, input) {
    const opts = await checkWizard(guild, input);
    const cfg = await getVerifyConfig(guild.id);
    const ids = {
        gateChannelId: opts.channelId || NEW.gate,
        verifiedRoleId: opts.verifiedRoleId || NEW.verified,
        unverifiedRoleId: opts.unverifiedRoleId || (opts.createUnverified ? NEW.unverified : null),
    };
    const plan = buildLockPlan(snapshotGuild(guild, ids), { strategy: opts.strategy, hideGate: opts.hideGate });
    const warnings = [];
    let grantEstimate = 0;
    if (opts.strategy === 'verified') {
        const role = opts.verifiedRoleId ? guild.roles.cache.get(opts.verifiedRoleId) : null;
        grantEstimate = Math.max(0, (guild.memberCount || 0) - (role?.members.size || 0));
        if (!opts.grantExisting) warnings.push('Everyone already in the server without the Verified role (bots included) will lose access to the locked channels.');
        else warnings.push('Bots added later need the Verified role too, or they will not see the locked channels.');
    }
    if (opts.strategy === 'none') warnings.push('No channel is hidden: new members can still see every channel your own permissions show them.');
    if (opts.strategy === 'unverified') warnings.push('Members already here are not affected; new members carry the Unverified role until they verify.');
    if (cfg?.wizard && cfg.wizard.status !== 'undone' && opts.strategy !== 'none') {
        warnings.push('An earlier setup is still recorded; its changes stay part of the undo record.');
    }
    return {
        options: opts,
        creates: {
            channel: opts.channelId ? null : `#${opts.channelName}`,
            verifiedRole: opts.verifiedRoleId ? null : opts.verifiedRoleName,
            unverifiedRole: opts.createUnverified ? opts.unverifiedRoleName : null,
        },
        edits: plan.edits.map(e => ({
            channelId: e.channelId, name: e.name, type: e.type, target: TARGET(guild, e.targetId),
            change: (e.after.deny & 1024n) ? 'hide' : 'show', reason: e.reason,
        })),
        skipped: plan.skipped,
        privateCount: plan.privateCount,
        lockedCount: plan.lockedCount,
        grantEstimate,
        warnings,
    };
}

export function wizardProgress(guildId) {
    const job = wizardJobs.get(guildId);
    return job ? { ...job } : null;
}

/** Start the wizard in the background; poll wizardProgress. */
export async function wizardApply(guild, input, actor) {
    if (wizardJobs.get(guild.id)?.running) throw new VerificationError('A setup or undo is already running for this server.');
    const opts = await checkWizard(guild, input);
    const job = { kind: 'apply', running: true, phase: 'starting', done: 0, total: 0, startedAt: Date.now(), by: actor?.username || null, warnings: [], result: null, error: null };
    wizardJobs.set(guild.id, job);
    runWizard(guild, opts, actor, job).catch(err => {
        logger.error(`[Verification] wizard failed in ${guild.id}: ${err.message}`, { stack: err.stack });
        job.error = err instanceof VerificationError ? err.message : `Stopped: ${err.message}`;
    }).finally(() => { job.running = false; job.finishedAt = Date.now(); });
    return wizardProgress(guild.id);
}

async function runWizard(guild, opts, actor, job) {
    const me = guild.members.me || await guild.members.fetchMe();
    const reason = 'Verification setup wizard';
    const created = { roles: [], channelId: null };

    job.phase = 'roles';
    let verified = opts.verifiedRoleId ? guild.roles.cache.get(opts.verifiedRoleId) : null;
    if (!verified) {
        verified = await guild.roles.create({ name: opts.verifiedRoleName, permissions: [], reason });
        created.roles.push(verified.id);
    }
    let unverified = opts.unverifiedRoleId ? guild.roles.cache.get(opts.unverifiedRoleId) : null;
    if (!unverified && opts.createUnverified) {
        unverified = await guild.roles.create({ name: opts.unverifiedRoleName, permissions: [], reason });
        created.roles.push(unverified.id);
    }

    job.phase = 'channel';
    let channel = opts.channelId ? guild.channels.cache.get(opts.channelId) : null;
    if (!channel) {
        const P = PermissionFlagsBits;
        const overwrites = [
            { id: guild.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads] },
            { id: me.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory] },
        ];
        if (unverified) overwrites.push({ id: unverified.id, allow: [P.ViewChannel, P.ReadMessageHistory] });
        if (opts.hideGate && opts.strategy !== 'none') overwrites.push({ id: verified.id, deny: [P.ViewChannel] });
        channel = await guild.channels.create({ name: opts.channelName, type: ChannelType.GuildText, position: 0, permissionOverwrites: overwrites, reason });
        created.channelId = channel.id;
    }

    await saveVerifyConfig(guild.id, {
        enabled: 1, mode: opts.mode, verified_role_id: verified.id,
        unverified_role_id: unverified ? unverified.id : null, gate_channel_id: channel.id,
    });

    const plan = buildLockPlan(snapshotGuild(guild, {
        gateChannelId: channel.id, verifiedRoleId: verified.id, unverifiedRoleId: unverified?.id ?? null,
    }), { strategy: opts.strategy, hideGate: opts.hideGate });

    // The undo record is written BEFORE anything is changed, so a crash part-way can still be undone.
    const previous = (await getVerifyConfig(guild.id))?.wizard || null;
    const record = mergeSnapshot(previous, snapshotRecord({
        at: new Date().toISOString(), by: actor?.username || null, strategy: opts.strategy, hideGate: opts.hideGate,
        created, edits: plan.edits, status: 'applying',
    }));
    await saveSnapshot(guild.id, record);

    if (opts.strategy === 'verified' && opts.grantExisting) {
        job.phase = 'granting';
        await guild.members.fetch();
        // Bots too: once @everyone loses View, a bot (this one included) without the role or Administrator
        // would stop seeing the locked channels.
        const targets = [...guild.members.cache.values()].filter(m => !m.roles.cache.has(verified.id));
        job.done = 0; job.total = targets.length;
        let granted = 0;
        for (const m of targets) {
            await m.roles.add(verified, 'Verification setup: member already in the server').then(() => { granted++; }).catch(() => {});
            job.done++;
        }
        record.granted = { roleId: verified.id, count: granted, of: targets.length };
    }

    job.phase = 'locking';
    job.done = 0; job.total = plan.edits.length;
    for (const e of plan.edits) {
        try {
            await guild.client.rest.put(Routes.channelPermission(e.channelId, e.targetId), {
                body: { type: 0, allow: e.after.allow.toString(), deny: e.after.deny.toString() }, reason,
            });
        } catch (err) {
            record.failures.push({ channelId: e.channelId, name: e.name, error: String(err.message).slice(0, 200) });
        }
        job.done++;
    }

    if (opts.postPanel) {
        job.phase = 'panel';
        try { await postPanel(guild, { channelId: channel.id }); } catch (err) { job.warnings.push(`Panel not posted: ${err.message}`); }
    }

    record.status = 'applied';
    await saveSnapshot(guild.id, record);
    job.phase = 'done';
    job.result = {
        channelId: channel.id, verifiedRoleId: verified.id, unverifiedRoleId: unverified?.id ?? null,
        created, locked: plan.lockedCount, edits: plan.edits.length, failures: record.failures, granted: record.granted,
    };
    void logFeatureEvent(() => (guild), 'join-gate.verifySetup', () => ({
        title: '🔐 Verification Set Up',
        fields: [
            ['By', actor?.id ? userLabel(actor) : 'Dashboard'],
            ['Channel', `<#${channel.id}>`],
            ['Verified role', `<@&${verified.id}>`],
            ['Unverified role', unverified ? `<@&${unverified.id}>` : null],
            ['Mode', opts.mode === 'captcha' ? 'CAPTCHA' : 'I agree button'],
            ['Channels locked', String(plan.lockedCount)],
            ['Could not change', record.failures.length ? String(record.failures.length) : null],
        ],
    }));
}

/** Undo the recorded wizard changes in the background; poll wizardProgress. */
export async function wizardUndo(guild, { deleteCreated = false } = {}, actor) {
    if (wizardJobs.get(guild.id)?.running) throw new VerificationError('A setup or undo is already running for this server.');
    invalidateVerifyConfig(guild.id);
    const cfg = await getVerifyConfig(guild.id);
    const rec = cfg?.wizard;
    if (!rec || rec.status === 'undone' || !Array.isArray(rec.edits)) throw new VerificationError('There is no setup to undo.');
    const job = { kind: 'undo', running: true, phase: 'restoring', done: 0, total: rec.edits.length, startedAt: Date.now(), by: actor?.username || null, warnings: [], result: null, error: null };
    wizardJobs.set(guild.id, job);
    runUndo(guild, cfg, rec, !!deleteCreated, actor, job).catch(err => {
        logger.error(`[Verification] undo failed in ${guild.id}: ${err.message}`, { stack: err.stack });
        job.error = `Stopped: ${err.message}`;
    }).finally(() => { job.running = false; job.finishedAt = Date.now(); });
    return wizardProgress(guild.id);
}

async function runUndo(guild, cfg, rec, deleteCreated, actor, job) {
    const reason = 'Verification setup wizard: undo';
    let restored = 0;
    const failures = [];
    for (const e of [...rec.edits].reverse()) {
        const channel = guild.channels.cache.get(e.channelId);
        if (!channel?.permissionOverwrites) { job.done++; continue; }
        const ow = channel.permissionOverwrites.cache.get(e.targetId);
        const current = ow ? { allow: ow.allow.bitfield, deny: ow.deny.bitfield } : null;
        const op = undoEdit(e.before, current, BigInt(e.mask || 1024));
        try {
            if (op.op === 'put') {
                await guild.client.rest.put(Routes.channelPermission(e.channelId, e.targetId), {
                    body: { type: 0, allow: op.allow.toString(), deny: op.deny.toString() }, reason,
                });
                restored++;
            } else if (op.op === 'delete') {
                await guild.client.rest.delete(Routes.channelPermission(e.channelId, e.targetId), { reason });
                restored++;
            }
        } catch (err) {
            failures.push({ channelId: e.channelId, name: e.name, error: String(err.message).slice(0, 200) });
        }
        job.done++;
    }

    const removed = [];
    if (deleteCreated) {
        job.phase = 'deleting';
        const patch = {};
        if (rec.created?.channelId) {
            const ch = guild.channels.cache.get(rec.created.channelId);
            if (ch) await ch.delete(reason).then(() => removed.push(`#${ch.name}`)).catch(err => failures.push({ name: ch.name, error: err.message }));
            if (cfg.channelId === rec.created.channelId) { patch.gate_channel_id = null; patch.gate_message_id = null; }
        }
        for (const id of rec.created?.roles || []) {
            const role = guild.roles.cache.get(id);
            if (role) await role.delete(reason).then(() => removed.push(`@${role.name}`)).catch(err => failures.push({ name: role.name, error: err.message }));
            if (id === cfg.unverifiedRoleId) patch.unverified_role_id = null;
            if (id === cfg.verifiedRoleId) patch.enabled = 0;   // verified_role_id cannot be empty; switch off instead
        }
        if (Object.keys(patch).length) await saveVerifyConfig(guild.id, patch);
    }

    rec.status = 'undone';
    rec.undoneAt = new Date().toISOString();
    rec.undoneBy = actor?.username || null;
    rec.undoFailures = failures;
    await saveSnapshot(guild.id, rec);
    job.phase = 'done';
    job.result = { restored, failures, removed };
    void logFeatureEvent(() => (guild), 'join-gate.verifySetup', () => ({
        title: '↩️ Verification Setup Undone',
        fields: [
            ['By', actor?.id ? userLabel(actor) : 'Dashboard'],
            ['Permission changes reverted', String(restored)],
            ['Deleted', removed.length ? removed.join(', ') : null],
            ['Could not revert', failures.length ? String(failures.length) : null],
        ],
    }));
}

/** For the Protection Settings overview and `/systems verification status`. */
export function describeConfig(cfg) {
    if (!cfg?.enabled) return 'Off';
    if (cfg.mode !== 'captcha') return 'I agree button';
    const action = cfg.failAction === 'none' ? 'log only' : cfg.failAction;
    return `CAPTCHA · ${cfg.attempts} tries · ${cfg.windowMinutes ? formatMinutes(cfg.windowMinutes) : 'no time limit'} · fails: ${action}`;
}

export default {
    getVerifyConfig, invalidateVerifyConfig, saveVerifyConfig, recordEvent, verificationStats, recentAttempts,
    onMemberJoin, onMemberUpdate, buildPanel, postPanel, roleProblem, grantVerified, renderCaptcha,
    handleVerifyButton, handleKeypad, handleAnswerModal, punish, resolveVerifyDeadline, sweepUnverifiedDays,
    verifyQueue, wizardPreview, wizardApply, wizardUndo, wizardProgress, describeConfig, VerificationError,
};
