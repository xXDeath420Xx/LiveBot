/*
 * Message threats — the pure rules (no Discord or DB access; unit-tested in tests/message-threats.test.js).
 * The live side is core/message-threats.js; the obfuscated-link detector is core/obfuscated-url.js.
 *
 *   settingsFrom      phishing_config row → the message-threat settings (migration 327 columns), all OFF
 *                     until a server turns them on; cleanSettingsPatch validates a change before it is saved
 *   scoreEscalation   a Discord AutoMod hit, scored on obfuscation, invite, account age, join recency,
 *                     lure words and emoji (Hashbot's signals); only the confirmed pattern is enforced
 *   breaker           the circuit breaker: more than BREAKER_LIMIT automatic bans inside BREAKER_WINDOW_MS
 *                     pauses the feature for the server until someone resets it
 *   qrUrls            the links inside decoded QR payloads (handed to the same link checks as text)
 *   explainUrl        /tools checkurl and the dashboard box: one verdict from the phishing list, the
 *                     never-flag list, the link policy and the obfuscation detector, with the reasons
 *   ocrRule*          per-guild keyword / regex rules for text read out of images (automod_patterns rows,
 *                     target 'image_text'), validated with the same guards as message patterns
 *   cannotAct         why the bot cannot carry out an action (now core/manual-action-logic.js, re-exported)
 *   automodRuleSpec   the "Obfuscated URL" Discord AutoMod rule the dashboard installs in one click
 *   everyoneAuthorised  anti-everyone: may this member ping @everyone (other than through @everyone itself)?
 *   isIgnored         channel / category ignore decision (categories cover channels created later)
 *   settings.nsfw     the NSFW chat-image stage's settings (nsfw_img_* columns, migration 330; rules in
 *                     core/nsfw-logic.js, live side core/nsfw-protection.js)
 */
import { analyzeMessage, techniqueLabel } from './obfuscated-url.js';
import { cannotAct } from './manual-action-logic.js';
import { validatePattern, matchPattern, compilePattern, REGEX_TIMEOUT_MS } from './automod-patterns.js';
import { imageSettingsFrom, IMAGE_ACTIONS as NSFW_IMAGE_ACTIONS, MIN_REVIEW as NSFW_MIN, MAX_THRESHOLD as NSFW_MAX, MIN_CAP as NSFW_MIN_CAP, MAX_CAP as NSFW_MAX_CAP } from './nsfw-logic.js';

export const OBF_ACTIONS = Object.freeze(['ban', 'timeout', 'delete', 'flag', 'log']);
export const ESC_ACTIONS = Object.freeze(['ban', 'flag']);
export const QR_ACTIONS = Object.freeze(['delete', 'timeout', 'ban', 'flag', 'log']);
export const OCR_ACTIONS = Object.freeze(['log', 'delete', 'timeout', 'ban']);
export const OCR_TYPES = Object.freeze(['contains', 'regex', 'exact', 'domain']);
export const WEBHOOK_MODES = Object.freeze(['ignore', 'log', 'delete']);
export const MAX_OCR_RULES = 50;
export const BREAKER_LIMIT = 25;
export const BREAKER_WINDOW_MS = 10 * 60_000;
export const REVIEW_MIN = 3;
export const DELETE_SECONDS = 3600;          // "delete the last hour" on a ban
export const MAX_TIMEOUT_MIN = 40320;       // Discord's 28-day cap

const json = (value, fallback) => {
    try { const v = typeof value === 'string' ? JSON.parse(value) : value; return v ?? fallback; } catch { return fallback; }
};
const pick = (value, allowed, fallback) => (allowed.includes(String(value)) ? String(value) : fallback);
const minutes = (value, fallback, min = 0) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.max(min, Math.min(MAX_TIMEOUT_MIN, n)) : fallback;
};
const ids = (value) => (Array.isArray(value) ? value : json(value, [])).map(String).filter(id => /^\d{15,25}$/.test(id));

/** phishing_config row (or null) → settings. Missing columns (migration not run) read as off. */
export function settingsFrom(row) {
    const r = row || {};
    return {
        phishingOn: !!Number(r.enabled ?? 0),
        scanImages: !!Number(r.scan_images ?? 0),
        alertChannelId: r.alert_channel_id || null,
        threatChannelId: r.threat_channel_id || null,
        obf: {
            enabled: !!Number(r.obf_enabled ?? 0),
            action: pick(r.obf_action, OBF_ACTIONS, 'ban'),
            timeoutMinutes: minutes(r.obf_timeout_minutes, 1440, 1),
            reviewAlerts: !!Number(r.obf_review_alerts ?? 0),
        },
        everyone: {
            enabled: !!Number(r.everyone_enabled ?? 0),
            timeoutMinutes: minutes(r.everyone_timeout_minutes, 60, 0),
            strict: !!Number(r.everyone_strict ?? 0),
            allowedRoles: ids(r.everyone_allowed_roles),
            webhooks: pick(r.everyone_webhooks, WEBHOOK_MODES, 'log'),
        },
        qr: {
            enabled: !!Number(r.qr_enabled ?? 0),
            strict: !!Number(r.qr_strict ?? 0),
            action: pick(r.qr_action, QR_ACTIONS, 'delete'),
            timeoutMinutes: minutes(r.qr_timeout_minutes, 1440, 1),
        },
        ocrRules: { enabled: !!Number(r.ocr_rules_enabled ?? 0), timeoutMinutes: minutes(r.ocr_timeout_minutes, 1440, 1) },
        escalation: {
            enabled: !!Number(r.esc_enabled ?? 0),
            action: pick(r.esc_action, ESC_ACTIONS, 'ban'),
            reviewAlerts: !!Number(r.esc_review_alerts ?? 0),
            ruleIds: ids(r.esc_rule_ids),
            installedRuleId: r.esc_installed_rule_id || null,
        },
        breaker: {
            trippedAt: r.breaker_tripped_at ? new Date(r.breaker_tripped_at).toISOString() : null,
        },
        nsfw: imageSettingsFrom(r),
    };
}

const SETTING_COLUMNS = {
    obf_enabled: 'bool', obf_action: OBF_ACTIONS, obf_timeout_minutes: 'minutes', obf_review_alerts: 'bool',
    everyone_enabled: 'bool', everyone_timeout_minutes: 'minutes0', everyone_strict: 'bool', everyone_allowed_roles: 'ids',
    everyone_webhooks: WEBHOOK_MODES,
    qr_enabled: 'bool', qr_strict: 'bool', qr_action: QR_ACTIONS, qr_timeout_minutes: 'minutes',
    ocr_rules_enabled: 'bool', ocr_timeout_minutes: 'minutes',
    esc_enabled: 'bool', esc_action: ESC_ACTIONS, esc_review_alerts: 'bool', esc_rule_ids: 'ids',
    threat_channel_id: 'channel',
    nsfw_img_enabled: 'bool', nsfw_img_action: NSFW_IMAGE_ACTIONS, nsfw_img_timeout_minutes: 'minutes',
    nsfw_img_act_threshold: 'score', nsfw_img_review_threshold: 'score', nsfw_img_review_alerts: 'bool', nsfw_img_daily_cap: 'count',
};

/** Validate a settings patch → column values. @returns {{ ok:boolean, values?:object, error?:string }} */
export function cleanSettingsPatch(patch) {
    const values = {};
    for (const [col, kind] of Object.entries(SETTING_COLUMNS)) {
        if (!(col in (patch || {}))) continue;
        const v = patch[col];
        if (kind === 'bool') values[col] = v ? 1 : 0;
        else if (kind === 'minutes' || kind === 'minutes0') {
            const n = Math.round(Number(v));
            const min = kind === 'minutes0' ? 0 : 1;
            if (!Number.isFinite(n) || n < min || n > 40320) return { ok: false, error: `${col.replace(/_/g, ' ')} must be ${min}-40320 minutes.` };
            values[col] = n;
        } else if (kind === 'ids') {
            const list = (Array.isArray(v) ? v : []).map(String).filter(id => /^\d{15,25}$/.test(id));
            values[col] = JSON.stringify([...new Set(list)].slice(0, 100));
        } else if (kind === 'score' || kind === 'count') {
            const n = Number(v);
            const [lo, hi] = kind === 'score' ? [NSFW_MIN, NSFW_MAX] : [NSFW_MIN_CAP, NSFW_MAX_CAP];
            if (!Number.isFinite(n) || n < lo || n > hi) return { ok: false, error: `${col.replace(/_/g, ' ')} must be ${lo}-${hi}.` };
            values[col] = kind === 'count' ? Math.round(n) : Math.round(n * 1000) / 1000;
        } else if (kind === 'channel') {
            if (v && !/^\d{15,25}$/.test(String(v))) return { ok: false, error: 'Pick a channel from the list.' };
            values[col] = v ? String(v) : null;
        } else if (Array.isArray(kind)) {
            if (!kind.includes(String(v))) return { ok: false, error: `${col.replace(/_/g, ' ')} must be one of ${kind.join(', ')}.` };
            values[col] = String(v);
        }
    }
    return { ok: true, values };
}

/** Does any message-threat stage want the images of this message? (They are downloaded once.) */
export function wantsImages(settings, { hasOcrRules = false } = {}) {
    return (settings.phishingOn && settings.scanImages) || settings.qr.enabled || (settings.ocrRules.enabled && hasOcrRules);
}

// ── AutoMod escalation scoring ───────────────────────────────────────────────

const DAY = 86_400_000;

/**
 * Score one AutoMod hit (or one message) on Hashbot's signals.
 * @param {object} p
 * @param {string} p.content           the message text AutoMod saw
 * @param {object} [p.analysis]        analyzeMessage(content), computed when omitted
 * @param {number|null} p.accountAgeMs  now - account creation
 * @param {number|null} p.joinedAgoMs   now - joined the server (null = unknown)
 * @returns {{ score:number, tier:'confirmed'|'review'|'none', signals:Array<{ key:string, points:number, text:string }>, analysis:object }}
 */
export function scoreEscalation({ content, analysis = null, accountAgeMs = null, joinedAgoMs = null }) {
    const a = analysis || analyzeMessage(content);
    const signals = [];
    const add = (key, points, text) => { if (points > 0) signals.push({ key, points, text }); };

    if (a.discordTarget) add('obfuscation', 3, `obfuscated Discord invite (${a.techniques.map(techniqueLabel).join(', ') || 'disguised'})`);
    else if (a.obfuscated) add('obfuscation', 2, `obfuscated link (${a.techniques.map(techniqueLabel).join(', ') || 'disguised'})`);
    if (a.invites.length) add('invite', 1, 'contains a Discord invite');
    if (accountAgeMs != null) {
        if (accountAgeMs < 7 * DAY) add('account_age', 2, 'account under 7 days old');
        else if (accountAgeMs < 30 * DAY) add('account_age', 1, 'account under 30 days old');
    }
    if (joinedAgoMs != null) {
        if (joinedAgoMs < DAY) add('join_recency', 2, 'joined in the last 24 hours');
        else if (joinedAgoMs < 7 * DAY) add('join_recency', 1, 'joined in the last 7 days');
    }
    if (a.lure.score) add('lure', Math.min(3, a.lure.score), `lure words: ${a.lure.groups.join(', ')}`);
    if (a.emoji >= 3) add('emoji', 1, `${a.emoji} emoji`);

    const score = signals.reduce((n, s) => n + s.points, 0);
    // Only the confirmed pattern is enforced; the rest is at most a review alert.
    let tier = 'none';
    if (a.verdict === 'confirmed') tier = 'confirmed';
    else if (score >= REVIEW_MIN && (a.obfuscated || a.lure.score >= 2 || a.invites.length)) tier = 'review';
    return { score, tier, signals, analysis: a };
}

// ── circuit breaker ──────────────────────────────────────────────────────────

/**
 * Before an automatic ban: drop timestamps outside the window and say whether this ban would go over
 * the limit. More than BREAKER_LIMIT bans in BREAKER_WINDOW_MS trips it (the 26th is not carried out).
 * @param {number[]} times  recent ban times (ms) for this server
 * @returns {{ times:number[], trip:boolean, count:number }}
 */
export function breakerCheck(times, now = Date.now(), { limit = BREAKER_LIMIT, windowMs = BREAKER_WINDOW_MS } = {}) {
    const recent = (times || []).filter(t => now - t < windowMs);
    return { times: recent, trip: recent.length >= limit, count: recent.length };
}

/** Record a ban that went ahead. */
export function breakerRecord(times, now = Date.now(), { windowMs = BREAKER_WINDOW_MS } = {}) {
    return [...(times || []).filter(t => now - t < windowMs), now];
}

/**
 * What an action becomes while the breaker is tripped: bans are held back and flagged for a human,
 * everything else (a delete, a timeout) carries on.
 */
export function underBreaker(action, tripped) {
    return tripped && action === 'ban' ? 'flag' : action;
}

// ── QR payloads ──────────────────────────────────────────────────────────────

/**
 * Links inside decoded QR payloads. A QR code is text: a URL, a bare domain, or a "discord.gg/x".
 * The payload goes through the same canonicalisation as chat, so an obfuscated payload is still read.
 * @param {string[]} payloads
 * @returns {{ urls:string[], hosts:string[], invites:string[], hasLink:boolean }}
 */
export function qrUrls(payloads) {
    const urls = new Set();
    const hosts = new Set();
    const invites = new Set();
    for (const raw of payloads || []) {
        const text = String(raw ?? '').slice(0, 2000);
        if (!text.trim()) continue;
        for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) urls.add(m[0]);
        // A bare "example.com/path" payload: phone cameras open it as a link.
        const bare = text.trim();
        if (!/\s/.test(bare) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(?:[/?#].*)?$/i.test(bare)) {
            urls.add(`https://${bare}`);
        }
        const a = analyzeMessage(urls.size ? [...urls].join('\n') + '\n' + text : text);
        for (const h of a.hosts) hosts.add(h);
        for (const i of a.invites) invites.add(i);
        for (const u of urls) {
            try { hosts.add(new URL(u).hostname.toLowerCase().replace(/^www\./, '')); } catch { /* not a URL */ }
        }
    }
    return { urls: [...urls], hosts: [...hosts], invites: [...invites], hasLink: urls.size > 0 || hosts.size > 0 || invites.size > 0 };
}

/**
 * What to do about the QR codes in one message.
 * @param {{ strict:boolean, action:string }} qr   settings.qr
 * @param {{ codes:number, phishingHosts:string[], verdict:string }} found
 * @returns {{ act:boolean, action:string|null, why:string|null }}
 */
export function qrDecision(qr, found) {
    if (!found?.codes) return { act: false, action: null, why: null };
    if (found.phishingHosts?.length) return { act: true, action: qr.action, why: `QR code links to a known phishing domain (${found.phishingHosts.join(', ')})` };
    if (found.verdict === 'confirmed') return { act: true, action: qr.action, why: 'QR code hides an obfuscated support-scam link' };
    if (qr.strict) return { act: true, action: qr.action, why: 'QR code in an image (any QR code is removed in this server)' };
    return { act: false, action: null, why: null };
}

// ── URL check ────────────────────────────────────────────────────────────────

/**
 * One verdict for /tools checkurl and the dashboard URL box.
 * @param {object} p
 * @param {string} p.input
 * @param {string|null} p.host            normalised host ('' when none could be found)
 * @param {boolean} p.listed              in the phishing domain list (the host or a parent domain)
 * @param {string|null} p.listedAs        the listed domain that matched
 * @param {boolean} p.safe                on the never-flag list
 * @param {boolean} [p.safeOverride]     ...because a dispute was approved (core/domain-reports.js), not built in
 * @param {{ verdict:string, category:string }|null} p.policy  core/link-policy.js classifyHost
 * @param {boolean} p.guildAllowed        on this server's phishing allowlist
 * @param {object} p.analysis             analyzeMessage(input)
 * @returns {{ verdict:'malicious'|'suspicious'|'safe'|'unknown', title:string, reasons:string[] }}
 */
export function explainUrl({ input, host, listed = false, listedAs = null, safe = false, safeOverride = false, policy = null, guildAllowed = false, analysis = null }) {
    const reasons = [];
    const a = analysis || analyzeMessage(input);
    if (!host) {
        return { verdict: 'unknown', title: 'No link found', reasons: ['That does not look like a URL or a domain.'] };
    }
    if (safe && safeOverride) reasons.push(`${host} is on the bot's global allow list (a dispute of its block was approved).`);
    else if (safe) reasons.push(`${host} is on the built-in never-flag list (platforms and embed fixers that bulk lists get wrong).`);
    if (guildAllowed) reasons.push(`${host} is on this server's phishing allowlist.`);
    if (listed) reasons.push(`${listedAs || host} is on the phishing / scam domain list (community feeds, refreshed every 4 hours).`);
    if (a.obfuscated) reasons.push(`The link is obfuscated: ${a.techniques.map(techniqueLabel).join(', ') || 'disguised'}.`);
    if (a.defanged && !a.obfuscated) reasons.push('The link is defanged (written so it cannot be clicked); that alone is not treated as malicious.');
    if (policy) {
        const word = { allow: 'allowed', review: 'sent to review', block: 'blocked' }[policy.verdict] || policy.verdict;
        reasons.push(`Link policy: ${policy.category} - would be ${word} where the link filter is on.`);
    }

    let verdict = 'unknown';
    if (listed && !safe && !guildAllowed) verdict = 'malicious';
    else if (a.verdict === 'confirmed') verdict = 'malicious';
    else if (a.obfuscated || policy?.verdict === 'block') verdict = 'suspicious';
    else if (safe || guildAllowed || policy?.verdict === 'allow') verdict = 'safe';
    if (verdict === 'unknown') reasons.push('Not on any list we hold. Unknown is not the same as safe: check where it really goes before trusting it.');

    const title = {
        malicious: `Malicious: ${host}`,
        suspicious: `Suspicious: ${host}`,
        safe: `No problems found: ${host}`,
        unknown: `Unknown: ${host}`,
    }[verdict];
    return { verdict, title, reasons };
}

// ── per-guild OCR rules ──────────────────────────────────────────────────────

/** Validate a rule before it is stored (same guards as message patterns). */
export function validateOcrRule({ type, pattern, action }) {
    if (!OCR_TYPES.includes(type)) return { ok: false, error: `Unknown rule type "${type}".` };
    if (!OCR_ACTIONS.includes(action)) return { ok: false, error: `Unknown action "${action}".` };
    const check = validatePattern(type, pattern);
    if (!check.ok) return check;
    if ((type === 'contains' || type === 'exact') && check.value.replace(/\s+/g, '').length < 3) {
        return { ok: false, error: 'Text rules need at least 3 characters; shorter ones are inside ordinary words.' };
    }
    return { ok: true, value: check.value };
}

/**
 * The first rule the image text matches, strictest action first.
 * @param {Array<{ id:number, pattern_type:string, pattern:string, action:string, reason?:string }>} rules
 * @param {string} text  OCR text (the folded form is tried too, so lookalike text in images still matches)
 * @param {(text:string)=>string} [fold]
 * @param {{ regexTimeoutMs?: number }} [opts]  regex budget per rule (default the automod 25 ms)
 * @returns {{ rule:object, timedOut:number[] }|{ rule:null, timedOut:number[] }}
 */
export function matchOcrRules(rules, text, fold = null, { regexTimeoutMs = REGEX_TIMEOUT_MS } = {}) {
    const timedOut = [];
    const forms = [String(text ?? '')];
    if (fold) { const f = fold(forms[0]); if (f && f !== forms[0]) forms.push(f); }
    const rank = { ban: 3, timeout: 2, delete: 1, log: 0 };
    let best = null;
    for (const rule of rules || []) {
        const compiled = rule.pattern_type === 'regex' ? compilePattern(rule) : null;
        for (const form of forms) {
            const r = matchPattern(rule, form, compiled, regexTimeoutMs);
            if (r.timedOut) { timedOut.push(rule.id); break; }
            if (r.matched) {
                if (!best || (rank[rule.action] ?? 0) > (rank[best.action] ?? 0)) best = rule;
                break;
            }
        }
    }
    return { rule: best, timedOut };
}

// ── manual action needed ─────────────────────────────────────────────────────

// cannotAct moved to core/manual-action-logic.js (shared by every automated punitive path); re-exported here so
// existing imports keep working.
export { cannotAct };

// ── audit reasons (plain ASCII) ──────────────────────────────────────────────

const REASONS = {
    obfuscated: 'Message threats: obfuscated support-scam link',
    escalation: 'Message threats: AutoMod hit confirmed as support-scam link',
    everyone: 'Message threats: unauthorised @everyone/@here mention',
    qr: 'Message threats: QR code in image',
    qr_phish: 'Message threats: QR code links to a phishing domain',
    ocr: 'Message threats: image text matched a server rule',
    review: 'Message threats: banned from a review card',
    nsfw: 'NSFW image in chat',
};
/** Audit-log reason, ASCII only, capped at Discord's 512. */
export function threatReason(kind, extra = '') {
    const base = REASONS[kind] || 'Message threats';
    const text = extra ? `${base} (${extra})` : base;
    return text.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').slice(0, 500);
}

// ── Discord AutoMod rule ─────────────────────────────────────────────────────

export const AUTOMOD_RULE_NAME = 'Obfuscated URL (CertiFried v2)';

/**
 * Regexes for the AutoMod rule (Rust flavour; Discord allows 10, each up to 260 characters). Each one
 * matches an obfuscation TRICK, never a plain link, so the rule cannot block an ordinary invite.
 */
export const AUTOMOD_REGEXES = Object.freeze([
    '(?i)h\\s*t\\s*t\\s*p\\s*s?\\s*:\\s*/{3,}',                                    // https:////
    '(?i)h\\s*t\\s*t\\s*p\\s*s?\\s*:\\s*\\\\',                                       // https:\\
    '(?i)https?://[^\\s/]*@',                                                       // https://@host, https://junk@host
    '(?i)(?:discord|dsc)\\s*(?:app)?\\s*[。．｡︒﹒]',         // discord。gg
    '(?i)https?://[^\\s/]*%[0-9a-f]{2}',                                            // percent-encoded host
    '(?i)(?:d\\s+i\\s*s\\s*c\\s*o\\s*r\\s*d|dis\\s+cord|disc\\s+ord|disco\\s+rd)\\s*\\.\\s*g\\s*g\\s*/',  // dis cord.gg/
    '(?i)discord\\s*\\.\\s+g\\s*g\\s*/|discord\\s+\\.\\s*g\\s*g\\s*/',             // discord . gg/
    '(?i)(?:disc\\s*\\n\\s*ord|discord\\s*\\n\\s*\\.|\\.\\s*\\n\\s*gg\\s*/|https?:/*\\s*\\n)',   // chopped across lines
]);

/**
 * The rule payload for guild.autoModerationRules.create().
 * @param {{ alertChannelId?:string|null, exemptChannelIds?:string[], exemptRoleIds?:string[] }} opts
 */
export function automodRuleSpec({ alertChannelId = null, exemptChannelIds = [], exemptRoleIds = [] } = {}) {
    const actions = [{ type: 1, metadata: { customMessage: 'Links written like this are blocked here. Paste the plain link if it is genuine.' } }];
    if (alertChannelId) actions.push({ type: 2, metadata: { channel: alertChannelId } });
    return {
        name: AUTOMOD_RULE_NAME,
        eventType: 1,           // MessageSend
        triggerType: 1,         // Keyword (regexPatterns)
        triggerMetadata: { keywordFilter: [], regexPatterns: [...AUTOMOD_REGEXES], allowList: [] },
        actions,
        enabled: true,
        exemptChannels: exemptChannelIds.slice(0, 50),
        exemptRoles: exemptRoleIds.slice(0, 20),
        reason: 'Message threats: install the Obfuscated URL AutoMod rule',
    };
}

// ── anti-everyone ────────────────────────────────────────────────────────────

const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;
const MENTION_EVERYONE = 1n << 17n;
const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };

/**
 * Was this member allowed to ping @everyone / @here?
 *
 * Discord only sets a message's mention_everyone flag when the sender HAD the permission, so "lacks the
 * permission" has to mean "lacks it apart from what @everyone itself was given". That is the
 * misconfiguration this guards against: Mention @everyone switched on for the @everyone role (server-wide
 * or in one channel's overwrites), which hands it to every account that joins. A role that was granted it
 * on purpose, a member overwrite, Administrator through a role, the owner and the allowed roles all count.
 *
 *   strict  only Administrator / Manage Server (through a real role), the owner and the allowed roles count;
 *           a role that merely has Mention @everyone does not.
 *
 * @param {object} p
 * @param {boolean} p.owner
 * @param {string} p.everyoneRoleId                 = guild id
 * @param {Array<{ id:string, permissions:bigint|string|number }>} p.roles   the member's roles (incl. @everyone)
 * @param {Array<{ id:string, type:0|1, allow:bigint|string|number, deny:bigint|string|number }>} p.overwrites
 *        the channel's overwrites (type 0 role, 1 member)
 * @param {string} p.memberId
 * @param {string[]} [p.allowedRoleIds]
 * @param {boolean} [p.strict]
 */
export function everyoneAuthorised({ owner = false, everyoneRoleId, roles = [], overwrites = [], memberId, allowedRoleIds = [], strict = false }) {
    if (owner) return true;
    const roleIds = new Set(roles.map(r => String(r.id)).filter(id => id !== String(everyoneRoleId)));
    if (allowedRoleIds.some(id => roleIds.has(String(id)))) return true;

    let base = 0n;
    for (const r of roles) if (String(r.id) !== String(everyoneRoleId)) base |= big(r.permissions);
    if (base & ADMINISTRATOR) return true;
    if (strict) return (base & MANAGE_GUILD) !== 0n;

    // Channel overwrites in Discord's order, but the @everyone overwrite may only take away.
    let perms = base;
    const ow = (id, type) => overwrites.find(o => String(o.id) === String(id) && Number(o.type) === type);
    const everyoneOw = ow(everyoneRoleId, 0);
    if (everyoneOw) perms &= ~big(everyoneOw.deny);
    let allow = 0n, deny = 0n;
    for (const id of roleIds) { const o = ow(id, 0); if (o) { allow |= big(o.allow); deny |= big(o.deny); } }
    perms = (perms & ~deny) | allow;
    const mine = ow(memberId, 1);
    if (mine) perms = (perms & ~big(mine.deny)) | big(mine.allow);
    return (perms & MENTION_EVERYONE) !== 0n;
}

// ── ignore lists ─────────────────────────────────────────────────────────────

/**
 * Is this channel ignored by the message protections? A category covers every channel in it,
 * including ones made later (tickets); a thread follows its parent channel.
 * @param {{ id:string, parentId?:string|null, parentParentId?:string|null }} where
 * @param {{ channels:Set<string>|string[], categories:Set<string>|string[] }} lists
 */
export function isIgnored(where, lists) {
    if (!where?.id || !lists) return false;
    const channels = lists.channels instanceof Set ? lists.channels : new Set(lists.channels || []);
    const categories = lists.categories instanceof Set ? lists.categories : new Set(lists.categories || []);
    if (!channels.size && !categories.size) return false;
    for (const id of [where.id, where.parentId, where.parentParentId]) {
        if (id && (channels.has(id) || categories.has(id))) return true;
    }
    return false;
}

export default {
    settingsFrom, cleanSettingsPatch, wantsImages, scoreEscalation, breakerCheck, breakerRecord, underBreaker, qrUrls, qrDecision,
    explainUrl, validateOcrRule, matchOcrRules, cannotAct, threatReason, automodRuleSpec, isIgnored, everyoneAuthorised,
    OBF_ACTIONS, ESC_ACTIONS, QR_ACTIONS, OCR_ACTIONS, OCR_TYPES, WEBHOOK_MODES, AUTOMOD_REGEXES, AUTOMOD_RULE_NAME,
    BREAKER_LIMIT, BREAKER_WINDOW_MS, DELETE_SECONDS, MAX_OCR_RULES,
};
