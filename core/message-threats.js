/*
 * Message threats — the live side (rules in core/message-threat-logic.js, the obfuscated-link detector in
 * core/obfuscated-url.js). Hashbot-parity stages added to the EXISTING message-protection pipeline rather
 * than a parallel one:
 *
 *   obfuscated URL   a stage of PhishingDetectionManager.checkMessage (core/phishing-detection-manager.js):
 *                    the "fake support" copypasta (obfuscated Discord invite + lure words) → the server's
 *                    action (ban by default, deleting the last hour; or timeout / delete / flag / log).
 *                    Weaker hits can raise review alerts. Hidden hosts also go through the phishing list.
 *   QR codes         same pipeline: images are read ONCE (core/scam-image-ocr.js scanImages) for OCR and QR;
 *                    decoded links go through the phishing list and the obfuscation check; strict mode
 *                    removes any image with a QR code.
 *   image-text rules same pipeline: per-server keyword / regex rules (automod_patterns, target 'image_text')
 *                    on the OCR text, each with its action (log / delete / timeout / ban).
 *   anti-everyone    events/messageCreate.js: the message's mention_everyone FLAG from a member who only has
 *                    the permission through the @everyone role (a misconfiguration) → delete + timeout.
 *                    Webhooks (compromised webhook URLs) are logged or deleted; app-owned webhooks and
 *                    crossposts are left alone.
 *   AutoMod          events/autoModerationActionExecution.js: hits of the rules a server enforces are scored
 *                    (obfuscation, invite, account age, join recency, lure words, emoji); the confirmed pattern
 *                    is banned or flagged, weaker ones can raise review alerts. installAutomodRule() creates
 *                    the "Obfuscated URL" AutoMod rule from the dashboard in one click.
 *
 * Every action goes through protectionHold (allowlist, managers, pause); staff are only ever logged. Bans
 * pass the circuit breaker: more than 25 automatic bans in 10 minutes pauses the bans for the server (they
 * become flags) and tells the owner, until someone resets it. When the bot cannot act it says exactly why
 * ("Manual action needed": the missing permission or the role-hierarchy problem). Each detection is a
 * phishing_detections row with its evidence; flagged members wait in name_filter_reviews (kind 'message')
 * for Ban / Dismiss, from the card's buttons or the dashboard's Message Threats page. Channels and
 * categories on the ignore list (core/protection-exempt.js) are skipped.
 *
 * The NSFW chat-image stage (core/nsfw-protection.js imageStage) carries out its alert / delete / timeout
 * through enforce() too (source 'nsfw_image'), with its own review queue instead of the 'message' one
 * (queue: false) and no sweep of the member's other messages.
 *
 * Settings: the phishing_config row (migration 327), all off until a server switches a stage on.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import configCache from '../utils/configCache.js';
import { foldConfusables } from '../utils/text-fold.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { protectionHold, isExempt, isIgnoredChannel, getState as protectionState } from './protection-exempt.js';
import { themeColor } from './guild-theme.js';
import { botPermsIn, whyCannot, reportManualAction } from './manual-action.js';
import aiJudge from './ai-judge.js';
import { isSafeDomain, normalizeHost, safeSource } from './safe-domains.js';
import { classifyHost } from './link-policy.js';
import { analyzeMessage, mightContainLink, techniqueLabel } from './obfuscated-url.js';
import {
    settingsFrom, scoreEscalation, breakerCheck, breakerRecord, underBreaker, qrUrls, qrDecision, explainUrl,
    validateOcrRule, matchOcrRules, threatReason, automodRuleSpec, everyoneAuthorised, cleanSettingsPatch,
    OCR_ACTIONS, DELETE_SECONDS, MAX_OCR_RULES, AUTOMOD_RULE_NAME,
    BREAKER_LIMIT, BREAKER_WINDOW_MS,
} from './message-threat-logic.js';

const TTL = 60_000;
const settingsCache = new Map();   // guildId -> { at, row, settings }
const rulesCache = new Map();      // guildId -> { at, rules }
const banTimes = new Map();        // guildId -> [ms] automatic bans inside the breaker window (all bots share the process)
const seenAutomod = new Map();     // dedupe: one AutoMod hit fires one event per rule action
const SOURCE_LABEL = {
    obfuscated_url: 'Obfuscated URL scam',
    automod_escalation: 'AutoMod escalation',
    anti_everyone: 'Anti-everyone',
    qr: 'QR code',
    image_rule: 'Image-text rule',
    nsfw_image: 'NSFW image',
    scam_text: 'Scam text (AI second opinion)',
    word_filter: 'Filtered word',
    ai_moderation: 'AI moderation',
};
// name_filter_reviews.field is VARCHAR(12).
const SOURCE_FIELD = { obfuscated_url: 'obfuscated', automod_escalation: 'automod', anti_everyone: 'everyone', qr: 'qr', image_rule: 'image_rule', nsfw_image: 'nsfw', scam_text: 'scam_text', ai_moderation: 'ai_mod' };
const STAFF_PERMS = [
    PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.KickMembers, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages,
];

// ── settings ─────────────────────────────────────────────────────────────────

/** The phishing_config row (whether or not phishing itself is on) and the parsed settings, cached. */
export async function getSettings(guildId) {
    const hit = settingsCache.get(guildId);
    if (hit && Date.now() - hit.at < TTL) return hit;
    let row = null;
    try {
        const [[r]] = await pool.execute('SELECT * FROM phishing_config WHERE guild_id = ?', [guildId]);
        row = r || null;
    } catch (err) {
        logger.warn(`[MessageThreats] could not load settings for ${guildId}: ${err.message}`);
        return { at: Date.now(), row: null, settings: settingsFrom(null) };
    }
    const entry = { at: Date.now(), row, settings: settingsFrom(row) };
    settingsCache.set(guildId, entry);
    return entry;
}

export function invalidate(guildId) {
    settingsCache.delete(guildId);
    rulesCache.delete(guildId);
    try { configCache.invalidate('phishing_config', guildId); } catch { /* cache not loaded */ }
}

/** Save settings. A row created here starts with phishing detection OFF (the column defaults to on). */
export async function saveSettings(guild, patch, by = null) {
    const check = cleanSettingsPatch(patch);
    if (!check.ok) return check;
    const cols = Object.keys(check.values);
    if (!cols.length) return { ok: true, changed: [] };
    await pool.execute(
        `INSERT INTO phishing_config (guild_id, enabled, ${cols.join(', ')}) VALUES (?, 0, ${cols.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${cols.map(c => `${c} = VALUES(${c})`).join(', ')}`,
        [guild.id, ...cols.map(c => check.values[c])]);
    invalidate(guild.id);
    logger.info(`[MessageThreats] settings changed in ${guild.id} by ${by}: ${cols.join(', ')}`);
    void logFeatureEvent(() => (guild), 'automod.threatSettings', () => ({
        title: '⚙️ Message Threat Settings Changed',
        fields: [['Changed', cols.map(c => c.replace(/_/g, ' ')).join(', '), false], ['By', userLabel(by)]],
    }));
    return { ok: true, changed: cols };
}

// ── image-text rules ─────────────────────────────────────────────────────────

export async function loadOcrRules(guildId) {
    const hit = rulesCache.get(guildId);
    if (hit && Date.now() - hit.at < TTL) return hit.rules;
    let rules = [];
    try {
        const [rows] = await pool.execute(
            "SELECT id, pattern_type, pattern, action, reason FROM automod_patterns WHERE guild_id = ? AND target = 'image_text' AND enabled = 1 ORDER BY id",
            [guildId]);
        rules = rows;
    } catch { rules = []; }   // migration not run: no rules
    rulesCache.set(guildId, { at: Date.now(), rules });
    return rules;
}

export async function listOcrRules(guildId) {
    const [rows] = await pool.execute(
        `SELECT p.id, p.pattern_type, p.pattern, p.action, p.reason, p.enabled, p.created_by, p.created_at,
                COALESCE(s.true_positives, 0) AS hits, s.last_hit_at
           FROM automod_patterns p
           LEFT JOIN spam_patterns_stats s ON s.pattern_id = p.id AND s.guild_id = p.guild_id
          WHERE p.guild_id = ? AND p.target = 'image_text' ORDER BY p.id`, [guildId]).catch(async () => {
        const [plain] = await pool.execute(
            "SELECT id, pattern_type, pattern, action, reason, enabled, created_by, created_at FROM automod_patterns WHERE guild_id = ? AND target = 'image_text' ORDER BY id",
            [guildId]);
        return [plain];
    });
    return rows;
}

export async function addOcrRule(guild, { type, pattern, action = 'log', reason = null }, by = null) {
    const check = validateOcrRule({ type, pattern, action });
    if (!check.ok) return check;
    const [[{ n }]] = await pool.execute("SELECT COUNT(*) AS n FROM automod_patterns WHERE guild_id = ? AND target = 'image_text'", [guild.id]);
    if (Number(n) >= MAX_OCR_RULES) return { ok: false, error: `A server can have at most ${MAX_OCR_RULES} image-text rules.` };
    const [dupes] = await pool.execute(
        "SELECT id FROM automod_patterns WHERE guild_id = ? AND target = 'image_text' AND pattern_type = ? AND pattern = ? LIMIT 1",
        [guild.id, type, check.value]);
    if (dupes.length) return { ok: false, error: `That rule already exists as #${dupes[0].id}.` };
    const [res] = await pool.execute(
        "INSERT INTO automod_patterns (guild_id, pattern_type, pattern, action, reason, enabled, created_by, target, origin) VALUES (?, ?, ?, ?, ?, 1, ?, 'image_text', 'manual')",
        [guild.id, type, check.value, action, reason ? String(reason).slice(0, 200) : null, by]);
    rulesCache.delete(guild.id);
    void logFeatureEvent(() => (guild), 'automod.threatSettings', () => ({
        title: '🖼️ Image-Text Rule Added',
        fields: [['Rule', `#${res.insertId} ${type}: \`${check.value.slice(0, 200)}\``, false], ['Action', action], ['By', userLabel(by)]],
    }));
    return { ok: true, id: res.insertId, value: check.value };
}

export async function updateOcrRule(guild, id, { enabled, action } = {}, by = null) {
    const sets = [];
    const args = [];
    if (enabled !== undefined) { sets.push('enabled = ?'); args.push(enabled ? 1 : 0); }
    if (action !== undefined) {
        if (!OCR_ACTIONS.includes(action)) return { ok: false, error: 'Unknown action.' };
        sets.push('action = ?'); args.push(action);
    }
    if (!sets.length) return { ok: true };
    const [r] = await pool.execute(
        `UPDATE automod_patterns SET ${sets.join(', ')} WHERE id = ? AND guild_id = ? AND target = 'image_text'`, [...args, id, guild.id]);
    rulesCache.delete(guild.id);
    if (!r.affectedRows) return { ok: false, error: 'No such rule.' };
    logger.info(`[MessageThreats] image-text rule #${id} changed in ${guild.id} by ${by}`);
    return { ok: true };
}

export async function removeOcrRule(guild, id, by = null) {
    const [r] = await pool.execute("DELETE FROM automod_patterns WHERE id = ? AND guild_id = ? AND target = 'image_text'", [id, guild.id]);
    rulesCache.delete(guild.id);
    if (r.affectedRows) {
        void logFeatureEvent(() => (guild), 'automod.threatSettings', () => ({
            title: '🖼️ Image-Text Rule Removed', fields: [['Rule', `#${id}`], ['By', userLabel(by)]],
        }));
    }
    return r.affectedRows > 0;
}

async function recordRuleHit(guildId, ruleId) {
    await pool.execute(
        `INSERT INTO spam_patterns_stats (guild_id, pattern_id, true_positives, last_hit_at, effectiveness_score)
         VALUES (?, ?, 1, NOW(), 50)
         ON DUPLICATE KEY UPDATE true_positives = true_positives + 1, last_hit_at = NOW(),
            effectiveness_score = (true_positives / (true_positives + false_positives + 1)) * 100`,
        [guildId, ruleId]).catch(() => {});
}

// ── shared helpers ───────────────────────────────────────────────────────────

export function isStaffMember(member) {
    return !!member && (member.guild.ownerId === member.id || STAFF_PERMS.some(p => member.permissions?.has(p)));
}

/** Why the bot cannot do this to this member, or null (core/manual-action.js, shared by every protection). */
export function diagnose(guild, { action, member, channel }) {
    return whyCannot(guild, action, { member, channel })?.text ?? null;
}

function cardChannel(guild, settings) {
    for (const id of [settings.threatChannelId, settings.alertChannelId]) {
        const ch = id ? guild.channels.cache.get(id) : null;
        if (ch?.isTextBased?.()) return ch;
    }
    return null;
}

/**
 * "Manual action needed": the bot could not act, and says exactly why. Posted to the server log and where the
 * evidence cards go, through core/manual-action.js (one alert per server per cause per 10 minutes).
 */
export async function manualActionNeeded(guild, settings, { action, member = null, userId = null, channel = null, why, source, messageUrl = null }) {
    const problem = whyCannot(guild, action, { member, channel }) || why;
    await reportManualAction(guild, {
        action, member, userId, channel, messageUrl, problem, source: SOURCE_LABEL[source] || source, alsoChannel: cardChannel(guild, settings),
    });
}

async function sweepRecent(channel, userId, seconds = DELETE_SECONDS) {
    try {
        if (!channel?.messages?.fetch) return 0;
        const recent = await channel.messages.fetch({ limit: 50 });
        const cutoff = Date.now() - seconds * 1000;
        const mine = recent.filter(m => m.author?.id === userId && m.createdTimestamp > cutoff);
        if (!mine.size) return 0;
        const gone = await channel.bulkDelete(mine, true).catch(() => null);
        return gone?.size ?? 0;
    } catch { return 0; }
}

// ── circuit breaker ──────────────────────────────────────────────────────────

async function breakerTripped(guildId) {
    const { settings } = await getSettings(guildId);
    return !!settings.breaker.trippedAt;
}

/**
 * Before a ban: is the breaker open, or would this ban open it? Trips it (DB + owner + log) when the limit
 * is reached. @returns {Promise<boolean>} true = do not ban (flag instead)
 */
async function breakerBlocks(guild) {
    if (await breakerTripped(guild.id)) return true;
    const check = breakerCheck(banTimes.get(guild.id), Date.now());
    banTimes.set(guild.id, check.times);
    if (!check.trip) return false;
    await pool.execute('UPDATE phishing_config SET breaker_tripped_at = ? WHERE guild_id = ?', [new Date(), guild.id]).catch(() => {});
    invalidate(guild.id);
    logger.warn(`[MessageThreats] circuit breaker tripped in ${guild.id}: ${check.count} automatic bans in ${BREAKER_WINDOW_MS / 60000} minutes`);
    const text = `More than ${BREAKER_LIMIT} automatic bans in ${BREAKER_WINDOW_MS / 60000} minutes, so automatic bans from message threats are paused. `
        + 'New hits are flagged for a human instead. Check the recent bans, then reset the breaker on the dashboard (Message Threats) '
        + 'or with `/link-filter threats breaker-reset`.';
    void logFeatureEvent(() => (guild), 'automod.circuitBreaker', () => ({
        title: '🚨 Circuit Breaker Tripped', description: text, fields: [['Bans in window', String(check.count)]],
    }));
    const { settings } = await getSettings(guild.id);
    const ch = cardChannel(guild, settings);
    if (ch) await ch.send({ content: `🚨 **Circuit breaker tripped.** ${text}`, allowedMentions: { parse: [] } }).catch(() => {});
    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) await owner.send(`🚨 **${guild.name}**: ${text}`).catch(() => {});
    return true;
}

export async function resetBreaker(guild, by = null) {
    await pool.execute('UPDATE phishing_config SET breaker_tripped_at = NULL WHERE guild_id = ?', [guild.id]);
    banTimes.delete(guild.id);
    invalidate(guild.id);
    logger.info(`[MessageThreats] circuit breaker reset in ${guild.id} by ${by}`);
    void logFeatureEvent(() => (guild), 'automod.circuitBreaker', () => ({
        title: '✅ Circuit Breaker Reset', description: 'Automatic bans from message threats are back on.', fields: [['By', userLabel(by)]],
    }));
    return { ok: true };
}

export function breakerState(guildId, settings) {
    const now = Date.now();
    const recent = (banTimes.get(guildId) || []).filter(t => now - t < BREAKER_WINDOW_MS);
    return { trippedAt: settings.breaker.trippedAt, recentBans: recent.length, limit: BREAKER_LIMIT, windowMinutes: BREAKER_WINDOW_MS / 60000 };
}

// ── recording + cards ────────────────────────────────────────────────────────

async function recordDetection({ guild, userId, channelId, source, label, links, outcome, messageId, content, evidence, score }) {
    try {
        const [res] = await pool.execute(
            `INSERT INTO phishing_detections (guild_id, user_id, channel_id, matched_domain, matched_url, source, action_taken, message_id, content, evidence, score)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [guild.id, userId, channelId || '0', String(label || source).slice(0, 255), links ? String(links).slice(0, 4000) : null, source,
                outcome, messageId || null, content ? String(content).slice(0, 4000) : null, evidence ? JSON.stringify(evidence).slice(0, 60000) : null,
                Number.isFinite(score) ? Math.max(-32000, Math.min(32000, Math.round(score))) : null]);
        return res.insertId;
    } catch (err) {
        logger.error(`[MessageThreats] detection NOT recorded in ${guild.id}: ${err.message}`);
        return null;
    }
}

async function queueReview(guild, { user, member, source, detectionId, detail }) {
    await pool.execute(
        `INSERT INTO name_filter_reviews (guild_id, user_id, kind, username, display_name, nickname, filter_id, filter_label, field, status, detail, found_at, decided_by, decided_at)
         VALUES (?, ?, 'message', ?, ?, ?, ?, ?, ?, 'pending', ?, NOW(), NULL, NULL)
         ON DUPLICATE KEY UPDATE username = VALUES(username), display_name = VALUES(display_name), nickname = VALUES(nickname),
           filter_id = VALUES(filter_id), filter_label = VALUES(filter_label), field = VALUES(field), status = 'pending',
           detail = VALUES(detail), found_at = NOW(), decided_by = NULL, decided_at = NULL`,
        [guild.id, user.id, String(user.username ?? '').slice(0, 100), user.globalName ? String(user.globalName).slice(0, 100) : null,
            member?.nickname ? String(member.nickname).slice(0, 100) : null, detectionId, SOURCE_LABEL[source] || source, (SOURCE_FIELD[source] || source).slice(0, 12),
            String(detail || '').slice(0, 255)]).catch(err => logger.warn(`[MessageThreats] review not queued: ${err.message}`));
}

const OUTCOME_TEXT = {
    banned: 'Banned (last hour of messages deleted)', timeout: 'Timed out', deleted: 'Message deleted', flagged: 'Flagged for review',
    review: 'Review alert (message left up)', logged: 'Logged only', held: 'Held (exempt or paused)', staff: 'Logged only (staff)',
    failed: 'Could not act', webhook_deleted: 'Webhook message deleted', webhook_logged: 'Webhook message logged',
};

async function postCard(guild, settings, { source, outcome, user, member, channel, content, reasons, signals, score, links, detectionId, buttons, messageUrl, attachments }) {
    const ch = cardChannel(guild, settings);
    if (!ch) return false;
    const danger = ['banned', 'timeout', 'deleted', 'webhook_deleted'].includes(outcome);
    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, danger ? 'danger' : 'warning'))
        .setTitle(`${danger ? '🛡️' : '🚩'} ${SOURCE_LABEL[source] || source}: ${OUTCOME_TEXT[outcome] || outcome}`)
        .setTimestamp();
    const clean = String(content || '').replace(/```/g, "'''").slice(0, 900);
    if (clean) embed.setDescription('```\n' + clean + '\n```');
    if (user) {
        const created = user.createdTimestamp ? `<t:${Math.floor(user.createdTimestamp / 1000)}:R>` : 'unknown';
        const joined = member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'unknown';
        embed.addFields(
            { name: 'Member', value: `<@${user.id}> (${user.tag ?? user.username ?? user.id})`, inline: true },
            { name: 'Account created', value: created, inline: true },
            { name: 'Joined', value: joined, inline: true },
        );
    }
    if (channel) embed.addFields({ name: 'Channel', value: `${channel}`, inline: true });
    if (Number.isFinite(score)) embed.addFields({ name: 'Score', value: String(score), inline: true });
    if (reasons?.length) embed.addFields({ name: 'Why', value: reasons.map(r => `• ${r}`).join('\n').slice(0, 1024), inline: false });
    if (signals?.length) embed.addFields({ name: 'Signals', value: signals.map(s => `+${s.points} ${s.text}`).join('\n').slice(0, 1024), inline: false });
    if (links?.length) embed.addFields({ name: 'Links found', value: links.map(l => `\`${String(l).slice(0, 120)}\``).join('\n').slice(0, 1024), inline: false });
    if (attachments?.length) embed.addFields({ name: 'Attachments', value: attachments.slice(0, 4).map((a, i) => `[${a.name || `image ${i + 1}`}](${a.url})`).join('\n').slice(0, 1024), inline: false });
    if (messageUrl) embed.addFields({ name: 'Message', value: messageUrl, inline: false });
    if (detectionId) embed.setFooter({ text: `Detection #${detectionId}${user ? ` | User ID: ${user.id}` : ''}` });

    const components = [];
    if (buttons && user) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`mthreat_ban:${user.id}`).setLabel('Ban').setEmoji('🔨').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`mthreat_ok:${user.id}`).setLabel('Dismiss').setEmoji('✅').setStyle(ButtonStyle.Secondary),
        ));
    }
    const sent = await ch.send({ embeds: [embed], components, allowedMentions: { parse: [] } }).catch(() => null);
    return !!sent;
}

/**
 * Carry out one detection: hold check, staff check, breaker, the action, the record, the card, the log.
 *
 * @param {object} d
 * @param {import('discord.js').Guild} d.guild
 * @param {import('discord.js').GuildMember|null} d.member
 * @param {import('discord.js').User} d.user
 * @param {import('discord.js').Message|null} d.message    deleted for delete / timeout / flag / ban
 * @param {object|null} d.channel
 * @param {string} d.source          obfuscated_url | automod_escalation | anti_everyone | qr | image_rule | nsfw_image
 * @param {string} d.action          ban | timeout | delete | flag | review | log
 * @param {number} [d.timeoutMinutes]
 * @param {string} d.reasonKind      threatReason key
 * @param {string} [d.reasonExtra]
 * @param {boolean} [d.queue]        false: no 'message' review row and no Ban / Dismiss buttons (the caller queues)
 * @param {boolean} [d.sweep]        false: a timeout does not also delete the member's other recent messages
 * @param {boolean} [d.quiet]        true: no evidence card (the detection is still recorded and logged)
 * @returns {Promise<{ outcome:string, removed:boolean, detectionId:number|null }>}
 */
export async function enforce(d) {
    const { guild, member, user, message, channel, source } = d;
    const { settings } = await getSettings(guild.id);
    let action = d.action;
    let outcome = 'logged';
    let removed = false;
    let failure = null;

    // A review alert is only a question for staff: none for staff themselves or exempt members.
    if (action === 'review' && member && (isStaffMember(member) || (await isExempt(member)).exempt)) {
        return { outcome: 'skipped', removed: false, detectionId: null };
    }
    if (['ban', 'timeout', 'delete', 'flag'].includes(action) && member && isStaffMember(member)) { action = 'log'; outcome = 'staff'; }

    const holdAction = { ban: 'ban', timeout: 'timeout', delete: 'delete', flag: 'delete' }[action];
    const held = holdAction && member ? await protectionHold(member, holdAction, SOURCE_LABEL[source] || 'Message threats') : null;
    if (held) { action = 'log'; outcome = 'held'; }

    if (action === 'ban' && await breakerBlocks(guild)) action = underBreaker('ban', true);

    const tryDelete = async () => {
        if (!message) return false;
        const ok = await message.delete().then(() => true).catch(() => false);
        if (!ok) failure = failure || { action: 'delete', why: diagnose(guild, { action: 'delete', member, channel }) || 'Discord refused to delete the message.' };
        return ok;
    };

    try {
        if (action === 'ban') {
            const why = member ? diagnose(guild, { action: 'ban', member, channel }) : (botPermsIn(guild, channel).ban ? null : 'I am missing the **Ban Members** permission.');
            if (why) { failure = { action: 'ban', why }; removed = await tryDelete(); outcome = 'failed'; }
            else {
                await guild.members.ban(user.id, { deleteMessageSeconds: DELETE_SECONDS, reason: threatReason(d.reasonKind, d.reasonExtra) });
                banTimes.set(guild.id, breakerRecord(banTimes.get(guild.id), Date.now()));
                outcome = 'banned';
                removed = true;
            }
        } else if (action === 'timeout') {
            removed = await tryDelete();
            const minutes = Math.max(1, Number(d.timeoutMinutes) || 60);
            const why = diagnose(guild, { action: 'timeout', member, channel });
            if (why) { failure = { action: 'timeout', why }; outcome = removed ? 'deleted' : 'failed'; }
            else {
                await member.timeout(minutes * 60_000, threatReason(d.reasonKind, d.reasonExtra));
                if (d.sweep !== false) await sweepRecent(channel, user.id);
                outcome = 'timeout';
            }
        } else if (action === 'delete') {
            removed = await tryDelete();
            outcome = removed ? 'deleted' : 'failed';
        } else if (action === 'flag') {
            removed = await tryDelete();
            outcome = 'flagged';
        } else if (action === 'review') {
            outcome = 'review';
        }
    } catch (err) {
        failure = { action, why: (member && diagnose(guild, { action, member, channel })) || `Discord refused: ${err.message}` };
        outcome = removed ? 'deleted' : 'failed';
    }

    // AI second opinion (core/ai-judge.js), when the stage asked for one: on the card, the record and the queue row.
    const aiVerdict = d.ai?.verdict ?? null;
    const reasons = aiVerdict ? [...(d.reasons || []), `AI second opinion: ${aiJudge.verdictLine('text', aiVerdict)}${d.ai.decision === 'act' ? ' (confirmed: acted)' : ''}`] : d.reasons;
    const aiEvidence = aiVerdict ? { ai: { verdict: aiJudge.verdictWord('text', aiVerdict), confidence: aiVerdict.confidence, reason: aiVerdict.reason, decision: d.ai.decision } } : {};
    const detectionId = await recordDetection({
        guild, userId: user.id, channelId: channel?.id, source, label: d.label, links: (d.links || []).join(' '), outcome,
        messageId: message?.id ?? d.messageId ?? null, content: d.content, evidence: { ...d.evidence, ...aiEvidence, outcome, held: held?.why ?? null }, score: d.score,
    });
    const wantsReview = d.queue !== false && (outcome === 'flagged' || outcome === 'review' || (outcome === 'failed' && action === 'ban'));
    if (wantsReview) {
        await queueReview(guild, { user, member, source, detectionId, detail: (reasons || []).join('; ') || d.label });
        if (aiVerdict) await aiJudge.saveReviewVerdict(guild.id, user.id, 'message', 'text', aiVerdict);
    }
    if (aiVerdict) aiJudge.logVerdict(guild, 'text', { userId: user.id, verdict: aiVerdict, outcome: d.ai.decision === 'act' ? 'act' : 'advise', detail: d.label });

    if (!d.quiet) await postCard(guild, settings, {
        source, outcome, user, member, channel, content: d.content, reasons, signals: d.signals, score: d.score,
        links: d.links, detectionId, buttons: wantsReview, messageUrl: !removed && message ? message.url : null,
        attachments: d.attachments,
    });
    if (failure?.why) await manualActionNeeded(guild, settings, { action: failure.action, member, userId: user.id, channel, why: failure.why, source, messageUrl: !removed && message ? message.url : null });

    void logFeatureEvent(() => (guild), () => (outcome === 'banned' ? 'automod.threatBanned'
        : (outcome === 'timeout' || outcome === 'deleted') ? 'automod.threatRemoved'
            : (outcome === 'flagged' || outcome === 'review') ? 'automod.threatFlagged' : 'automod.threatLogged'), () => ({
        title: `${SOURCE_LABEL[source] || source}: ${OUTCOME_TEXT[outcome] || outcome}`,
        description: (reasons || []).join('\n') || null,
        fields: [['Member', userLabel(user)], ['Channel', channel ? `${channel}` : null], ['Detection', detectionId ? `#${detectionId}` : null]],
        avoidChannelIds: [settings.threatChannelId, settings.alertChannelId],
    }));
    logger.warn(`[MessageThreats] ${source} → ${outcome} for ${user.id} in ${guild.id}${held ? ` (${held.why})` : ''}`);
    return { outcome, removed, detectionId };
}

// ── stages of the phishing pipeline ──────────────────────────────────────────

/**
 * A borderline (review-tier) hit and the AI second opinion: act mode + the AI agreeing → the stage's own
 * action; review alerts on, or the AI calling it a scam → a review alert carrying the verdict; otherwise
 * nothing (as with AI off and review alerts off). No verdict never changes what would have happened.
 * @returns {Promise<{ action:string|null, ai:object|null }>}
 */
async function borderline(message, { reviewAlerts, stageAction, detector, signals = [], text = null }) {
    const ai = await aiJudge.textOpinion(message, { text, detector, signals });
    if (ai.decision === 'act' && stageAction && !['review', 'log'].includes(stageAction)) return { action: stageAction, ai };
    if (reviewAlerts) return { action: 'review', ai: ai.verdict ? ai : null };
    if (ai.verdict?.positive && (ai.decision === 'advise' || ai.decision === 'act')) return { action: 'review', ai };
    return { action: null, ai: null };
}

/**
 * Text read from an image, one signal group short of the scam bar (core/phishing-detection-manager.js),
 * when the AI calls it a scam in advise mode (or below the act confidence): a review alert with the verdict.
 * The act case is the phishing pipeline's own action and does not come here.
 */
export async function aiScamTextReview(message, { ocrText, groups = [], ai }) {
    return enforce({
        guild: message.guild, member: message.member, user: message.author, message, channel: message.channel,
        source: 'scam_text', action: 'review', reasonKind: 'ocr', label: 'Scam text in an image (AI second opinion)',
        content: [message.content, ocrText ? `[text in the image] ${ocrText}` : ''].filter(Boolean).join('\n').slice(0, 1500),
        reasons: [`Image text matched ${groups.length} scam signal group${groups.length === 1 ? '' : 's'} (${groups.join(', ')}), one short of the bar.`],
        evidence: { groups }, ai,
    });
}

/**
 * Obfuscated-URL stage. @returns {Promise<{ acted:boolean, analysis:object|null }>} analysis is returned so
 * the phishing stage can look up the hosts the obfuscation was hiding.
 */
export async function obfuscationStage(message, settings) {
    const content = message.content || '';
    if (!mightContainLink(content)) return { acted: false, analysis: null };
    const analysis = analyzeMessage(content);
    if (!settings.obf.enabled || analysis.verdict === 'none') return { acted: false, analysis };
    const scored = scoreEscalation({
        content, analysis,
        accountAgeMs: message.author?.createdTimestamp ? Date.now() - message.author.createdTimestamp : null,
        joinedAgoMs: message.member?.joinedTimestamp ? Date.now() - message.member.joinedTimestamp : null,
    });
    let action;
    let ai = null;
    if (analysis.verdict === 'confirmed') action = settings.obf.action;
    else if (scored.tier !== 'none') {
        const b = await borderline(message, {
            reviewAlerts: settings.obf.reviewAlerts, stageAction: settings.obf.action, detector: 'Obfuscated-link support-scam check (review tier)',
            signals: [...analysis.reasons, ...scored.signals.map(x => x.text)],
        });
        if (!b.action) return { acted: false, analysis };
        action = b.action;
        ai = b.ai;
    } else return { acted: false, analysis };

    const out = await enforce({
        guild: message.guild, member: message.member, user: message.author, message, channel: message.channel,
        source: 'obfuscated_url', action, timeoutMinutes: settings.obf.timeoutMinutes, reasonKind: 'obfuscated',
        reasonExtra: analysis.techniques.join(','), label: analysis.hiddenInvites[0] || analysis.hiddenHosts[0] || 'obfuscated link',
        links: [...analysis.hiddenInvites, ...analysis.hiddenHosts], content, reasons: analysis.reasons, signals: scored.signals,
        score: scored.score, evidence: { techniques: analysis.techniques, lure: analysis.lure.groups, invites: analysis.invites, hosts: analysis.hosts }, ai,
    });
    return { acted: out.removed, analysis };
}

/**
 * QR stage. `lookup(host)` → the matching phishing-list domain or null.
 * @returns {Promise<boolean>} true when the message was removed
 */
export async function qrStage(message, settings, qrScan, lookup) {
    if (!settings.qr.enabled || !qrScan?.codes) return false;
    const found = qrUrls(qrScan.payloads);
    const phishingHosts = [];
    for (const h of found.hosts) {
        if (isSafeDomain(h)) continue;
        const hit = lookup ? lookup(h) : null;
        if (hit) phishingHosts.push(hit);
    }
    const analysis = analyzeMessage(qrScan.payloads.join('\n'));
    const decision = qrDecision(settings.qr, { codes: qrScan.codes, phishingHosts, verdict: analysis.verdict });
    const links = [...found.urls, ...found.invites].slice(0, 10);
    if (!decision.act) {
        logger.debug('[MessageThreats] QR code(s) decoded, nothing to act on', { guildId: message.guild.id, codes: qrScan.codes, links: links.length });
        return false;
    }
    const out = await enforce({
        guild: message.guild, member: message.member, user: message.author, message, channel: message.channel,
        source: 'qr', action: decision.action, timeoutMinutes: settings.qr.timeoutMinutes,
        reasonKind: phishingHosts.length ? 'qr_phish' : 'qr', label: phishingHosts[0] || links[0] || 'QR code', links,
        content: message.content || '', reasons: [decision.why, ...analysis.reasons], score: null,
        evidence: { qr: qrScan.payloads.map(p => String(p).slice(0, 500)), phishingHosts, strict: settings.qr.strict },
        attachments: [...message.attachments.values()].map(a => ({ name: a.name, url: a.url })),
    });
    return out.removed;
}

/** Image-text rules stage. @returns {Promise<boolean>} true when the message was removed */
export async function imageRulesStage(message, settings, ocrText) {
    if (!settings.ocrRules.enabled || !ocrText) return false;
    const rules = await loadOcrRules(message.guild.id);
    if (!rules.length) return false;
    const { rule, timedOut } = matchOcrRules(rules, ocrText, (t) => foldConfusables(t));
    for (const id of timedOut) {
        await pool.execute(
            "UPDATE automod_patterns SET enabled = 0, disabled_reason = 'too slow to evaluate' WHERE id = ? AND guild_id = ? AND target = 'image_text'",
            [id, message.guild.id]).catch(() => {});
        rulesCache.delete(message.guild.id);
        logger.warn(`[MessageThreats] image-text rule #${id} disabled in ${message.guild.id}: regex timed out`);
    }
    if (!rule) return false;
    void recordRuleHit(message.guild.id, rule.id);
    const out = await enforce({
        guild: message.guild, member: message.member, user: message.author, message, channel: message.channel,
        source: 'image_rule', action: rule.action === 'log' ? 'log' : rule.action, timeoutMinutes: settings.ocrRules.timeoutMinutes,
        reasonKind: 'ocr', reasonExtra: `rule ${rule.id}`, label: `rule #${rule.id}`,
        content: `${message.content || ''}\n[image text] ${ocrText.slice(0, 600)}`,
        reasons: [`image text matched rule #${rule.id} (${rule.pattern_type}: ${String(rule.pattern).slice(0, 80)})${rule.reason ? ` - ${rule.reason}` : ''}`],
        evidence: { rule: { id: rule.id, type: rule.pattern_type, pattern: rule.pattern }, ocr: ocrText.slice(0, 2000) },
        attachments: [...message.attachments.values()].map(a => ({ name: a.name, url: a.url })),
    });
    return out.removed;
}

// ── anti-everyone ────────────────────────────────────────────────────────────

/**
 * events/messageCreate.js, for messages whose mention_everyone flag is set (members and webhooks).
 * @returns {Promise<boolean>} true when the message was removed
 */
export async function checkEveryone(message) {
    try {
        if (!message.guild || !message.mentions?.everyone) return false;
        const { settings } = await getSettings(message.guild.id);
        const ae = settings.everyone;
        if (!ae.enabled) return false;
        if (await isIgnoredChannel(message.channel)) return false;

        if (message.webhookId) {
            // App-owned webhooks (bots, ours included: live announcements) and followed-channel crossposts are fine.
            if (message.applicationId || message.flags?.has?.(MessageFlags.IsCrosspost)) return false;
            if (ae.webhooks === 'ignore') return false;
            let removed = false;
            if (ae.webhooks === 'delete') removed = await message.delete().then(() => true).catch(() => false);
            const outcome = removed ? 'webhook_deleted' : 'webhook_logged';
            const detectionId = await recordDetection({
                guild: message.guild, userId: message.webhookId, channelId: message.channel.id, source: 'anti_everyone',
                label: `webhook ${message.author?.username ?? message.webhookId}`, outcome, messageId: message.id,
                content: message.content, evidence: { webhook: { id: message.webhookId, name: message.author?.username ?? null } },
            });
            await postCard(message.guild, settings, {
                source: 'anti_everyone', outcome, user: null, channel: message.channel, content: message.content,
                reasons: [`a webhook (**${message.author?.username ?? 'unknown'}**, ${message.webhookId}) pinged @everyone/@here`,
                    'If you did not set this webhook up, delete it in Channel Settings > Integrations: its URL may have leaked.'],
                detectionId, messageUrl: removed ? null : message.url,
            });
            if (ae.webhooks === 'delete' && !removed) {
                await manualActionNeeded(message.guild, settings, {
                    action: 'delete', userId: message.webhookId, channel: message.channel, source: 'anti_everyone',
                    why: diagnose(message.guild, { action: 'delete', channel: message.channel }) || 'Discord refused to delete the message.',
                    messageUrl: message.url,
                });
            }
            void logFeatureEvent(() => (message.guild), 'automod.everyone', () => ({
                title: removed ? '📣 Webhook @everyone Removed' : '📣 Webhook Pinged @everyone',
                fields: [['Webhook', `${message.author?.username ?? 'unknown'} (${message.webhookId})`], ['Channel', `${message.channel}`]],
                avoidChannelIds: [settings.threatChannelId, settings.alertChannelId],
            }));
            return removed;
        }

        if (message.author?.bot) return false;
        const member = message.member;
        if (!member) return false;
        const channel = message.channel;
        const permChannel = channel.isThread?.() ? channel.parent : channel;
        const authorised = everyoneAuthorised({
            owner: message.guild.ownerId === member.id,
            everyoneRoleId: message.guild.id,
            roles: [...member.roles.cache.values()].map(r => ({ id: r.id, permissions: r.permissions.bitfield })),
            overwrites: permChannel?.permissionOverwrites?.cache
                ? [...permChannel.permissionOverwrites.cache.values()].map(o => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield }))
                : [],
            memberId: member.id,
            allowedRoleIds: ae.allowedRoles,
            strict: ae.strict,
        });
        if (authorised) return false;

        const out = await enforce({
            guild: message.guild, member, user: message.author, message, channel, source: 'anti_everyone',
            action: ae.timeoutMinutes > 0 ? 'timeout' : 'delete', timeoutMinutes: ae.timeoutMinutes, reasonKind: 'everyone',
            label: '@everyone/@here', content: message.content,
            reasons: [ae.strict
                ? 'pinged @everyone/@here without Administrator, Manage Server or an allowed role (strict mode)'
                : 'pinged @everyone/@here with a permission that only came from the @everyone role (check Mention @everyone on @everyone in Server Settings and this channel)'],
        });
        return out.removed;
    } catch (err) {
        logger.error(`[MessageThreats] anti-everyone failed: ${err.message}`);
        return false;
    }
}

// ── AutoMod escalation ───────────────────────────────────────────────────────

/**
 * events/autoModerationActionExecution.js, for every AutoMod action. Never throws.
 * @param {import('discord.js').AutoModerationActionExecution} execution
 */
export async function handleAutoModExecution(execution) {
    try {
        const guild = execution.guild;
        if (!guild || !execution.userId) return;
        const { settings } = await getSettings(guild.id);
        const esc = settings.escalation;
        if (!esc.enabled || !esc.ruleIds.includes(String(execution.ruleId))) return;

        // One hit fires one event per action on the rule (block, alert, timeout): act once.
        const content = execution.content || execution.matchedContent || '';
        const key = `${guild.id}:${execution.userId}:${execution.ruleId}:${content.slice(0, 200)}`;
        const now = Date.now();
        for (const [k, at] of seenAutomod) if (now - at > 30_000) seenAutomod.delete(k);
        if (seenAutomod.has(key)) return;
        seenAutomod.set(key, now);

        const channel = execution.channelId ? guild.channels.cache.get(execution.channelId) ?? null : null;
        if (channel && await isIgnoredChannel(channel)) return;
        const member = execution.member ?? await guild.members.fetch(execution.userId).catch(() => null);
        const user = member?.user ?? await guild.client.users.fetch(execution.userId).catch(() => null);
        if (!user || user.bot) return;

        const scored = scoreEscalation({
            content,
            accountAgeMs: user.createdTimestamp ? now - user.createdTimestamp : null,
            joinedAgoMs: member?.joinedTimestamp ? now - member.joinedTimestamp : null,
        });
        // The message is there only when the rule did not block it.
        const message = execution.messageId && channel?.messages
            ? await channel.messages.fetch(execution.messageId).catch(() => null) : null;
        let action;
        let ai = null;
        if (scored.tier === 'confirmed') action = esc.action;
        else if (scored.tier === 'review') {
            // A blocked message has no Message: the AI sees the matched content and the channel's latest messages.
            const subject = message || { guild, channel, member, author: user, content, id: null };
            const b = await borderline(subject, {
                reviewAlerts: esc.reviewAlerts, stageAction: esc.action, detector: 'Discord AutoMod hit (review tier)', text: content,
                signals: scored.signals.map(x => x.text),
            });
            if (!b.action) return;
            action = b.action;
            ai = b.ai;
        } else return;
        const rule = execution.autoModerationRule ?? guild.autoModerationRules?.cache?.get(execution.ruleId);
        await enforce({
            guild, member, user, message, channel, source: 'automod_escalation', action, reasonKind: 'escalation',
            reasonExtra: `rule ${execution.ruleId}`, label: rule?.name ? `AutoMod: ${rule.name}` : `AutoMod rule ${execution.ruleId}`,
            links: [...scored.analysis.hiddenInvites, ...scored.analysis.hiddenHosts], content,
            reasons: [`AutoMod rule ${rule?.name ? `**${rule.name}**` : execution.ruleId} matched${execution.matchedKeyword ? ` \`${execution.matchedKeyword}\`` : ''}`, ...scored.analysis.reasons],
            signals: scored.signals, score: scored.score, messageId: execution.messageId,
            evidence: { ruleId: execution.ruleId, matchedKeyword: execution.matchedKeyword ?? null, techniques: scored.analysis.techniques, lure: scored.analysis.lure.groups },
            ai,
        });
    } catch (err) {
        logger.error(`[MessageThreats] AutoMod escalation failed: ${err.message}`);
    }
}

/** This server's AutoMod rules, for the dashboard: which are enforced, and which one we installed. */
export async function listAutomodRules(guild) {
    const { settings } = await getSettings(guild.id);
    const me = guild.members.me;
    if (!me?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
        return { ok: false, error: 'I need the Manage Server permission to read AutoMod rules.', rules: [] };
    }
    const rules = await guild.autoModerationRules.fetch().catch(err => { throw new Error(`Discord refused: ${err.message}`); });
    return {
        ok: true,
        rules: [...rules.values()].map(r => ({
            id: r.id, name: r.name, enabled: r.enabled, triggerType: r.triggerType, eventType: r.eventType,
            actions: r.actions.map(a => a.type),
            enforced: settings.escalation.ruleIds.includes(r.id),
            installed: settings.escalation.installedRuleId === r.id || r.name === AUTOMOD_RULE_NAME,
        })),
    };
}

/** Turn enforcement of one AutoMod rule on or off. */
export async function setRuleEnforced(guild, ruleId, enforced, by = null) {
    if (!/^\d{15,25}$/.test(String(ruleId))) return { ok: false, error: 'Unknown rule.' };
    const { settings } = await getSettings(guild.id);
    const ids = new Set(settings.escalation.ruleIds);
    if (enforced) ids.add(String(ruleId)); else ids.delete(String(ruleId));
    return saveSettings(guild, { esc_rule_ids: [...ids] }, by);
}

/**
 * Create (or refresh) the "Obfuscated URL" AutoMod rule and enforce it. Needs Manage Server.
 * @returns {Promise<{ ok:boolean, ruleId?:string, created?:boolean, error?:string }>}
 */
export async function installAutomodRule(guild, by = null) {
    const me = guild.members.me;
    if (!me?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
        return { ok: false, error: 'I need the Manage Server permission to create AutoMod rules.' };
    }
    const { settings } = await getSettings(guild.id);
    const state = await protectionState(guild.id);
    const spec = automodRuleSpec({
        alertChannelId: cardChannel(guild, settings)?.id ?? null,
        exemptChannelIds: [...state.channels],
    });
    const existing = await guild.autoModerationRules.fetch().catch(() => null);
    const current = existing ? [...existing.values()].find(r => r.id === settings.escalation.installedRuleId || r.name === AUTOMOD_RULE_NAME) : null;
    const attempt = async (payload) => (current ? current.edit({ ...payload, reason: payload.reason }) : guild.autoModerationRules.create(payload));
    let rule;
    try {
        rule = await attempt(spec);
    } catch (err) {
        // Discord's regex engine may refuse the inline case flag; every pattern is lower case-safe without it.
        try {
            rule = await attempt({ ...spec, triggerMetadata: { ...spec.triggerMetadata, regexPatterns: spec.triggerMetadata.regexPatterns.map(p => p.replace(/^\(\?i\)/, '')) } });
        } catch (err2) {
            logger.warn(`[MessageThreats] AutoMod rule install failed in ${guild.id}: ${err.message} / ${err2.message}`);
            return { ok: false, error: `Discord refused the rule: ${err2.message}` };
        }
    }
    const ids = new Set(settings.escalation.ruleIds);
    ids.add(rule.id);
    await pool.execute(
        `INSERT INTO phishing_config (guild_id, enabled, esc_installed_rule_id, esc_rule_ids) VALUES (?, 0, ?, ?)
         ON DUPLICATE KEY UPDATE esc_installed_rule_id = VALUES(esc_installed_rule_id), esc_rule_ids = VALUES(esc_rule_ids)`,
        [guild.id, rule.id, JSON.stringify([...ids])]);
    invalidate(guild.id);
    void logFeatureEvent(() => (guild), 'automod.threatSettings', () => ({
        title: current ? '🧩 Obfuscated URL AutoMod Rule Updated' : '🧩 Obfuscated URL AutoMod Rule Installed',
        description: 'Discord AutoMod now blocks obfuscated links; hits are scored and escalated when AutoMod escalation is on.',
        fields: [['Rule', `${rule.name} (${rule.id})`], ['By', userLabel(by)]],
    }));
    return { ok: true, ruleId: rule.id, created: !current };
}

// ── review queue ─────────────────────────────────────────────────────────────

export async function listReviews(guildId, { status = 'pending', limit = 100 } = {}) {
    const statuses = status === 'all' ? null : [status];
    const [rows] = await pool.execute(
        `SELECT r.user_id, r.username, r.display_name, r.nickname, r.filter_id, r.filter_label, r.field, r.status, r.detail,
                r.found_at, r.decided_by, r.decided_at, r.ai_verdict, r.ai_confidence, r.ai_reason, r.ai_at,
                d.content, d.evidence, d.score, d.channel_id, d.message_id, d.action_taken
           FROM name_filter_reviews r
           LEFT JOIN phishing_detections d ON d.id = r.filter_id AND d.guild_id = ?
          WHERE r.guild_id = ? AND r.kind = 'message' ${statuses ? 'AND r.status = ?' : ''}
          ORDER BY r.found_at DESC LIMIT ${Math.max(1, Math.min(500, Number(limit) || 100))}`,
        // guild_id compared to a parameter, not column to column: the two tables have different collations.
        statuses ? [guildId, guildId, ...statuses] : [guildId, guildId]);
    return rows;
}

export async function reviewCounts(guildId) {
    const [rows] = await pool.execute(
        "SELECT status, COUNT(*) AS n FROM name_filter_reviews WHERE guild_id = ? AND kind = 'message' GROUP BY status", [guildId]);
    return Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
}

/**
 * Ban or dismiss flagged members (card buttons and the dashboard).
 * @param {'ban'|'dismiss'} decision
 * @returns {Promise<{ done:string[], failed:Array<{ id:string, why:string }> }>}
 */
export async function decideReviews(guild, userIds, decision, actorId) {
    const done = [];
    const failed = [];
    const { settings } = await getSettings(guild.id);
    for (const userId of userIds.slice(0, 200)) {
        if (decision === 'dismiss') {
            await pool.execute(
                "UPDATE name_filter_reviews SET status = 'safe', decided_by = ?, decided_at = NOW() WHERE guild_id = ? AND user_id = ? AND kind = 'message'",
                [actorId, guild.id, userId]);
            done.push(userId);
            continue;
        }
        const member = await guild.members.fetch(userId).catch(() => null);
        const why = member ? diagnose(guild, { action: 'ban', member }) : (botPermsIn(guild, null).ban ? null : 'I am missing the **Ban Members** permission.');
        if (why) {
            failed.push({ id: userId, why });
            await manualActionNeeded(guild, settings, { action: 'ban', member, userId, why, source: 'obfuscated_url' });
            continue;
        }
        try {
            await guild.members.ban(userId, { deleteMessageSeconds: DELETE_SECONDS, reason: threatReason('review', `by ${actorId}`) });
            await pool.execute(
                "UPDATE name_filter_reviews SET status = 'banned', decided_by = ?, decided_at = NOW() WHERE guild_id = ? AND user_id = ? AND kind = 'message'",
                [actorId, guild.id, userId]);
            done.push(userId);
        } catch (err) {
            failed.push({ id: userId, why: `Discord refused: ${err.message}` });
        }
    }
    // Ban = confirmed, Dismiss = fine, for the detections behind these reviews (core/ai-moderation.js learning loop).
    if (done.length) import('./ai-moderation.js').then(m => m.onReviewDecision(guild, done, decision, actorId)).catch(() => {});
    if (done.length) {
        void logFeatureEvent(() => (guild), () => (decision === 'ban' ? 'automod.threatBanned' : 'automod.threatLogged'), () => ({
            title: decision === 'ban' ? '🔨 Flagged Members Banned' : '✅ Flagged Members Dismissed',
            fields: [['Members', done.map(id => `<@${id}>`).join(', ').slice(0, 1000), false], ['By', userLabel(actorId)]],
        }));
    }
    return { done, failed };
}

/** Ask the AI about one queued member (the dashboard's "Ask AI" button). Advice only; never acts. */
export async function askAiAboutReview(guild, userId) {
    if (!aiJudge.isConfigured()) return { ok: false, error: 'No AI key is configured for this bot.' };
    const [[row]] = await pool.execute(
        `SELECT r.display_name, d.content, d.channel_id FROM name_filter_reviews r
           LEFT JOIN phishing_detections d ON d.id = r.filter_id AND d.guild_id = ?
          WHERE r.guild_id = ? AND r.user_id = ? AND r.kind = 'message'`, [guild.id, guild.id, String(userId)]);
    if (!row?.content) return { ok: false, error: 'That entry has no message text to judge.' };
    const channel = row.channel_id ? guild.channels.cache.get(row.channel_id) : null;
    if (aiJudge.isAgeRestricted(channel)) return { ok: false, error: 'That message was in an age-restricted channel; it is never sent to the AI.' };
    const r = await aiJudge.judgeScamText(guild.id, { text: row.content, authorName: row.display_name, detector: 'Flagged-member review queue' });
    if (!r.verdict) return { ok: false, error: { capped: "Today's AI cap is used up.", rate_limited: 'Too many AI checks this minute; try again shortly.' }[r.status] || 'The AI gave no usable answer.' };
    await aiJudge.saveReviewVerdict(guild.id, String(userId), 'message', 'text', r.verdict);
    return { ok: true, verdict: r.verdict, line: aiJudge.verdictLine('text', r.verdict) };
}

// ── URL check ────────────────────────────────────────────────────────────────

/**
 * /tools checkurl and the dashboard box.
 * @returns {Promise<{ verdict:string, title:string, reasons:string[], host:string|null, listSize:number }>}
 */
export async function checkUrl(input, guildId = null) {
    const text = String(input ?? '').trim().slice(0, 500);
    const analysis = analyzeMessage(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    const bare = normalizeHost(text);
    const host = analysis.hiddenHosts[0] || analysis.hosts.find(h => h) || (analysis.invites[0] ? analysis.invites[0].split('/')[0] : '')
        || (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(bare) ? bare : '');
    let listed = false;
    let listedAs = null;
    let listSize = 0;
    try {
        const pdm = await import('./phishing-detection-manager.js');
        const hit = host ? pdm.phishingLookup(host) : null;
        listSize = pdm.phishingListSize();
        if (hit) { listed = true; listedAs = hit; }
    } catch { /* list not loaded in this process */ }
    let guildAllowed = false;
    if (guildId && host) {
        const { row } = await getSettings(guildId);
        try {
            const allow = JSON.parse(row?.whitelist_domains || '[]');
            guildAllowed = Array.isArray(allow) && allow.some(a => { const h = normalizeHost(a); return h && (host === h || host.endsWith(`.${h}`)); });
        } catch { guildAllowed = false; }
    }
    const via = host ? safeSource(host) : null;
    const result = explainUrl({
        input: text, host, listed, listedAs, safe: !!via, safeOverride: via === 'override',
        policy: host ? classifyHost(host, {}) : null, guildAllowed, analysis,
    });
    return { ...result, host: host || null, listSize, listed, listedAs };
}

// ── dashboard summary ────────────────────────────────────────────────────────

export async function recentDetections(guildId, { limit = 50, source = null } = {}) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const [rows] = await pool.execute(
        `SELECT id, user_id, channel_id, matched_domain, matched_url, source, action_taken, message_id, content, evidence, score, created_at
           FROM phishing_detections WHERE guild_id = ? ${source ? 'AND source = ?' : ''} ORDER BY id DESC LIMIT ${lim}`,
        source ? [guildId, source] : [guildId]);
    return rows.map(r => ({ ...r, evidence: (() => { try { return r.evidence ? JSON.parse(r.evidence) : null; } catch { return null; } })() }));
}

export async function detectionStats(guildId) {
    const [rows] = await pool.execute(
        `SELECT source, action_taken, COUNT(*) AS n FROM phishing_detections
          WHERE guild_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY) GROUP BY source, action_taken`, [guildId]);
    return rows.map(r => ({ source: r.source, action: r.action_taken, n: Number(r.n) }));
}

export { techniqueLabel, cleanSettingsPatch };

export default {
    getSettings, invalidate, saveSettings, cleanSettingsPatch, loadOcrRules, listOcrRules, addOcrRule, updateOcrRule, removeOcrRule,
    obfuscationStage, qrStage, imageRulesStage, checkEveryone, handleAutoModExecution, listAutomodRules, setRuleEnforced,
    installAutomodRule, resetBreaker, breakerState, listReviews, reviewCounts, decideReviews, checkUrl, recentDetections,
    detectionStats, manualActionNeeded, diagnose, enforce, isStaffMember, askAiAboutReview, aiScamTextReview,
};
