/**
 * KumaBot Defender on Twitch.
 *
 * KumaBot Defender (BearOrso / orsokuma, v4.17.0) protected Twitch chats from bot and spam
 * accounts. Its Kick port lives in services/certifried-bot/defender; this is the Twitch side.
 * It shares that port's network lists (kbd_banlist, kbd_unbanlist, kbd_malicious_sites + the
 * phishing feed), link-offense counter and per-channel settings, and acts through the
 * broadcaster's tier-B write grant (core/twitch-write.js, which audit-logs every Helix call).
 *
 * Off unless the broadcaster turns it on: twitch_analytics_alerts_config.kbd_mode
 *   'off'     nothing runs
 *   'detect'  decisions are logged to kbd_enforcement_log as 'detected'; nothing is done on Twitch
 *   'enforce' bans / deletes happen
 *
 * What it looks for, in order (first match wins):
 *   1. the account is on the network banlist (by Twitch user id, or by login)  -> ban
 *   2. the login matches a known bot-name pattern (KBD botNamePatterns.json)   -> ban
 *   3. the whole message matches a known follow/viewer-selling spam template    -> ban (+ banlist in enforce)
 *   4. the message links a known phishing/scam domain                           -> delete, ban on repeat
 *
 * Never acted on: the broadcaster, moderators, VIPs, subscribers/founders, Twitch staff,
 * channel service bots, and anyone on the network unban list. Same safety model as the
 * known-bot ban (core/twitch-known-bot-bans.js).
 *
 * Not ported on purpose: KBD followed every posted link to see where it redirected. Fetching
 * arbitrary user-supplied URLs from the server is a server-side request forgery risk, so links
 * are matched on their own domain only.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { isChatBot } from '../utils/twitch-chat-bots.js';
import { isOnBanlist, isOnUnbanlist, addBan, addUnban } from '../services/certifried-bot/defender/banlist.js';
import { findPhishingDomain, startDomainRefresh } from '../services/certifried-bot/defender/phishing-domains.js';
import { recordOffense } from '../services/certifried-bot/defender/link-offenses.js';
import { getChannelSettings } from '../services/certifried-bot/defender/channel-settings.js';
import { banUser, unbanUser, deleteChatMessage } from './twitch-write.js';

const LOG = '[KBD Twitch]';
const PLATFORM = 'twitch';
const ACTOR = { triggeredByDiscordUsername: 'KumaBot Defender (CertiFried)' };
const MODE_TTL_MS = 60_000;
const REPEAT_WINDOW_MS = 10 * 60_000;
const MAX_BANS_PER_MINUTE = 20;
const MAX_TEXT = 600;
export const BAN_REASON_PREFIX = 'KumaBot Defender';

const EXEMPT_BADGES = new Set(['broadcaster', 'moderator', 'lead_moderator', 'vip', 'subscriber', 'founder', 'staff', 'admin', 'global_mod']);
// KBD's own whitelist of channel service bots, on top of utils/twitch-chat-bots.js.
const SERVICE_BOTS = new Set(['streamelements', 'nightbot', 'wizebot', 'wzbot', 'frostytoolsdotcom']);

// ── patterns (copied verbatim from KBD; see defender/data/SOURCE.txt) ──
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../services/certifried-bot/defender/data');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
const NAME_PATTERNS = readJson('bot-name-patterns.json').map(p => new RegExp(p));
// isMessageSpam: anchored, first space becomes \s*, case-insensitive.
const SPAM_PATTERNS = readJson('spam-patterns.json').map(v => new RegExp(`^${v.replace(' ', '\\s*')}$`, 'i'));
const STRIP_EMOTES = readJson('strip-emotes.json');

/** Pure decision. Returns { action: 'ban'|'delete', reason, kind, domain? } or null. */
export function decide({ login, text, onBanlist, phishingDomain }) {
    if (onBanlist) return { action: 'ban', kind: 'banlist', reason: `${BAN_REASON_PREFIX}: account is on the network banlist` };
    if (login && NAME_PATTERNS.some(re => re.test(login))) {
        return { action: 'ban', kind: 'name_pattern', reason: `${BAN_REASON_PREFIX}: known bot account name pattern` };
    }
    if (text && isSpam(text)) return { action: 'ban', kind: 'spam_pattern', reason: `${BAN_REASON_PREFIX}: follower/viewer-selling spam` };
    if (phishingDomain) return { action: 'delete', kind: 'phishing', domain: phishingDomain, reason: `${BAN_REASON_PREFIX}: scam link (${phishingDomain})` };
    return null;
}

/** KBD's isBuyFollowersBot spam half: strip channel emotes, then match a whole-message template. */
export function isSpam(text) {
    let content = String(text).slice(0, MAX_TEXT);
    for (const e of STRIP_EMOTES) content = content.replace(e, '');
    content = content.normalize('NFC');
    return SPAM_PATTERNS.some(re => re.test(content));
}

/** True when this chatter must never be acted on. */
export function isExempt(event) {
    const bid = String(event.broadcaster_user_id || '');
    const uid = String(event.chatter_user_id || '');
    const login = String(event.chatter_user_login || '').toLowerCase();
    if (!uid || uid === bid) return true;
    if ((event.badges || []).some(b => EXEMPT_BADGES.has(b?.set_id))) return true;
    if (SERVICE_BOTS.has(login) || isChatBot(login)) return true;
    return false;
}

// ── per-broadcaster mode, cached ──
const modeCache = new Map(); // bid -> { mode, at }
export function invalidateKbdMode(bid) { if (bid) modeCache.delete(String(bid)); else modeCache.clear(); }
async function getMode(bid) {
    const hit = modeCache.get(bid);
    if (hit && Date.now() - hit.at < MODE_TTL_MS) return hit.mode;
    let mode = 'off';
    try {
        // A broadcaster can be linked to several servers; the strictest setting any of them chose wins.
        const [rows] = await pool.execute(
            `SELECT kbd_mode FROM twitch_analytics_alerts_config WHERE broadcaster_id = ?
              ORDER BY FIELD(kbd_mode, 'enforce', 'detect', 'off') LIMIT 1`, [bid]);
        mode = rows[0]?.kbd_mode || 'off';
    } catch (e) {
        logger.warn(`${LOG} mode lookup failed for ${bid}: ${e.message}`);
    }
    modeCache.set(bid, { mode, at: Date.now() });
    return mode;
}

// ── repeat + rate guards ──
const recent = new Map();      // `${bid}:${uid}` -> ts of last action
const banTimes = new Map();    // bid -> [ts...] in the last minute
function seenRecently(bid, uid) {
    const k = `${bid}:${uid}`, t = recent.get(k);
    if (t && Date.now() - t < REPEAT_WINDOW_MS) return true;
    recent.set(k, Date.now());
    if (recent.size > 5000) for (const [kk, tt] of recent) if (Date.now() - tt > REPEAT_WINDOW_MS) recent.delete(kk);
    return false;
}
function overRateLimit(bid) {
    const now = Date.now();
    const list = (banTimes.get(bid) || []).filter(t => now - t < 60_000);
    if (list.length >= MAX_BANS_PER_MINUTE) { banTimes.set(bid, list); return true; }
    list.push(now); banTimes.set(bid, list);
    return false;
}

async function logAction({ bid, uid, login, action, reason, success }) {
    try {
        await pool.execute(
            `INSERT INTO kbd_enforcement_log (platform, channel_id, target_user_id, target_username, action, reason, success)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [PLATFORM, bid, uid, login || uid, action, String(reason || '').slice(0, 255), success ? 1 : 0]);
    } catch (e) { logger.warn(`${LOG} log insert failed: ${e.message}`); }
}

let domainsStarted = false;

/**
 * The AI layer for a message the KBD lists passed. detect: logged as 'detected'. enforce: the message is deleted
 * (never a ban: a model alone does not ban anyone on Twitch). Off channels never get here.
 */
async function aiCheck(event, { bid, uid, login, mode }) {
    try {
        const { screenChat } = await import('./ai-moderation.js');
        const r = await screenChat({ platform: PLATFORM, channelId: bid, userId: uid, text: event.message?.text || '', mode });
        if (!r || r.action === 'none') return { acted: false, why: 'clean' };
        const reason = `AI ${r.label} ${Math.round(r.confidence * 100)}%${r.reason ? `: ${r.reason}` : ''}`;
        if (r.action !== 'delete') {
            await logAction({ bid, uid, login, action: 'detected', reason: `delete: ${reason}`, success: true });
            return { acted: false, why: 'ai_detect', ai: r };
        }
        const res = await deleteChatMessage(bid, event.message_id, ACTOR);
        await logAction({ bid, uid, login, action: 'delete', reason: res.ok ? reason : `${reason} (failed: ${res.error || res.status})`, success: res.ok });
        return { acted: !!res.ok, why: 'ai_delete', ai: r };
    } catch (e) {
        logger.debug(`${LOG} AI check failed: ${e.message}`);
        return { acted: false, why: 'clean' };
    }
}

/**
 * Called for every Twitch chat message (core/twitch-eventsub-manager.js handleChatMessage).
 * Never throws; returns what it did for tests and logs.
 */
export async function checkTwitchMessage(event) {
    try {
        const bid = String(event?.broadcaster_user_id || '');
        if (!bid) return { acted: false, why: 'no_broadcaster' };
        const mode = await getMode(bid);
        if (mode === 'off') return { acted: false, why: 'off' };
        if (!domainsStarted) { domainsStarted = true; startDomainRefresh(); }
        if (isExempt(event)) return { acted: false, why: 'exempt' };

        const uid = String(event.chatter_user_id);
        const login = String(event.chatter_user_login || '').toLowerCase();
        if (await isOnUnbanlist(PLATFORM, uid, login)) return { acted: false, why: 'unbanlisted' };

        const text = event.message?.text || '';
        const onBanlist = await isOnBanlist(PLATFORM, uid, login);
        const d = decide({ login, text, onBanlist, phishingDomain: onBanlist ? null : findPhishingDomain(text) });
        // Nothing on the KBD lists: the shared AI layer (core/ai-moderation.js, local models only) gets a look.
        if (!d) return await aiCheck(event, { bid, uid, login, mode });

        // Phishing escalates to a ban after the channel's threshold (default 2) of offenses.
        let action = d.action;
        if (d.kind === 'phishing') {
            const settings = await getChannelSettings(bid).catch(() => ({}));
            const threshold = Number.isInteger(settings.phishingThreshold) ? settings.phishingThreshold : 2;
            const count = mode === 'enforce' ? await recordOffense(PLATFORM, uid, login, d.domain).catch(() => 1) : 1;
            if (count >= threshold) action = 'ban';
        }
        if (action === 'ban' && seenRecently(bid, uid)) return { acted: false, why: 'repeat' };

        if (mode === 'detect') {
            await logAction({ bid, uid, login, action: 'detected', reason: `${action}: ${d.reason}`, success: true });
            return { acted: false, why: 'detect', decision: { ...d, action } };
        }

        if (action === 'ban' && overRateLimit(bid)) {
            await logAction({ bid, uid, login, action: 'detected', reason: `rate limit (${MAX_BANS_PER_MINUTE}/min): ${d.reason}`, success: false });
            return { acted: false, why: 'rate_limited' };
        }

        let res;
        if (action === 'ban') {
            res = await banUser(bid, uid, `${d.reason}. Automatic ban by CertiFried; send an unban request if this is a mistake.`, null, ACTOR);
            // KBD put spam-template senders on the shared list so every protected channel benefits.
            if (res.ok && d.kind === 'spam_pattern') {
                await addBan({ platform: PLATFORM, userId: uid, username: login, reason: 'Spam template (auto)', listType: 'ban' })
                    .then(() => pool.execute("UPDATE kbd_banlist SET source = 'auto_spam' WHERE platform = ? AND platform_user_id = ? AND source IS NULL", [PLATFORM, uid]))
                    .catch(e => logger.warn(`${LOG} auto-banlist failed: ${e.message}`));
            }
        } else {
            res = await deleteChatMessage(bid, event.message_id, ACTOR);
        }
        await logAction({ bid, uid, login, action, reason: res.ok ? d.reason : `${d.reason} (failed: ${res.error || res.status})`, success: res.ok });
        if (!res.ok) logger.warn(`${LOG} ${action} failed in ${bid} for ${login}: ${res.error || res.status}`);
        return { acted: !!res.ok, why: action, decision: { ...d, action } };
    } catch (e) {
        logger.warn(`${LOG} check failed: ${e.message}`);
        return { acted: false, why: 'error' };
    }
}

/**
 * Dashboard unban: lift the ban on Twitch and put the account on the network unban list, so no
 * KBD-protected channel acts on it again (KBD's false-positive list).
 */
export async function unbanKbd(bid, userId, login, actor) {
    const res = await unbanUser(String(bid), String(userId), actor || ACTOR);
    if (res.ok || res.status === 400) {
        // 400 = not banned any more; still record the exemption.
        await addUnban({ platform: PLATFORM, userId: String(userId), username: login || String(userId) }).catch(() => {});
    }
    return res;
}

/** Recent KBD activity for one broadcaster, newest first. */
export async function recentKbdActions(bid, limit = 25) {
    const [rows] = await pool.execute(
        `SELECT target_user_id, target_username, action, reason, success, created_at
           FROM kbd_enforcement_log WHERE platform = 'twitch' AND channel_id = ?
          ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(100, Number(limit) || 25))}`, [String(bid)]);
    const [counts] = await pool.execute(
        `SELECT action, SUM(success) ok, COUNT(*) n FROM kbd_enforcement_log
          WHERE platform = 'twitch' AND channel_id = ? GROUP BY action`, [String(bid)]);
    return { recent: rows, counts: Object.fromEntries(counts.map(c => [c.action, { ok: Number(c.ok), n: Number(c.n) }])) };
}
