/*
 * Verification — the rules, with no Discord or database in them (the live side is core/verification.js).
 *
 *   config      verify_config row <-> the settings object the dashboard and commands use, and the
 *               validation of a settings change.
 *   CAPTCHA     the code, the keypad state machine, how an answer is judged against the attempts
 *               allowed, the completion window, and the SVG the image is rendered from.
 *   wizard      which channels are "public", the permission overwrites that lock them behind the
 *               verification role (two strategies), and how each change is put back on undo without
 *               trampling anything staff changed since.
 *   stats       verified / failed / timed out / punished counts and the verification rate.
 *
 * Everything takes plain data (ids, bitfields as strings or BigInts, an injected random source) so the
 * tests can pin it exactly (tests/verify-prune.test.js).
 */
import crypto from 'node:crypto';

export const MODES = ['button', 'captcha'];
export const FAIL_ACTIONS = ['none', 'timeout', 'kick', 'ban'];
export const LOCK_STRATEGIES = ['none', 'unverified', 'verified'];
export const CODE_LENGTH = 6;
export const LIMITS = Object.freeze({
    attempts: [1, 10],
    windowMinutes: [0, 20160],     // up to 14 days, like auto-prune (core/auto-prune-logic.js PRUNE_LIMITS)
    timeoutMinutes: [1, 40320],
    unverifiedKickDays: [0, 365],
});
export const DEFAULTS = Object.freeze({
    mode: 'button', attempts: 3, windowMinutes: 5, failAction: 'kick', timeoutMinutes: 60, failDm: true,
});
/** A code is good for 5 minutes (or until the window closes, if sooner). */
export const CODE_TTL_MS = 5 * 60_000;
/** "New image" presses per code before it has to be answered or left to expire. */
export const MAX_REFRESHES = 3;

const clampInt = (v, [lo, hi], fallback) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const snowflake = (v) => (v != null && /^\d{15,25}$/.test(String(v)) ? String(v) : null);

// ── config ───────────────────────────────────────────────────────────────────

/** A verify_config row (or null) as the settings object everything else uses. */
export function normaliseConfig(row) {
    if (!row) return null;
    let wizard = null;
    if (row.wizard_snapshot) {
        try { wizard = typeof row.wizard_snapshot === 'string' ? JSON.parse(row.wizard_snapshot) : row.wizard_snapshot; } catch { wizard = null; }
    }
    return {
        guildId: String(row.guild_id),
        enabled: !!row.enabled,
        verifiedRoleId: snowflake(row.verified_role_id),
        unverifiedRoleId: snowflake(row.unverified_role_id),
        channelId: snowflake(row.gate_channel_id),
        messageId: snowflake(row.gate_message_id),
        mode: MODES.includes(row.mode) ? row.mode : DEFAULTS.mode,
        attempts: clampInt(row.captcha_attempts, LIMITS.attempts, DEFAULTS.attempts),
        windowMinutes: clampInt(row.captcha_window_minutes, LIMITS.windowMinutes, DEFAULTS.windowMinutes),
        failAction: FAIL_ACTIONS.includes(row.fail_action) ? row.fail_action : DEFAULTS.failAction,
        timeoutMinutes: clampInt(row.fail_timeout_minutes, LIMITS.timeoutMinutes, DEFAULTS.timeoutMinutes),
        failDm: row.fail_dm == null ? DEFAULTS.failDm : !!row.fail_dm,
        panelTitle: row.panel_title || null,
        panelText: row.panel_text || null,
        unverifiedKickDays: clampInt(row.unverified_kick_days, LIMITS.unverifiedKickDays, 0),
        wizard,
        wizardAt: row.wizard_at || null,
    };
}

/** Does a CAPTCHA deadline apply to joins in this config? */
export const windowApplies = (cfg) => !!cfg?.enabled && cfg.mode === 'captcha' && cfg.windowMinutes > 0;

/**
 * A settings change from the dashboard or a command, as verify_config columns. Unknown keys are
 * ignored; a bad value is an error (nothing is half-saved).
 * @returns {{ patch: Record<string, any>, errors: string[] }}
 */
export function validateSettings(input = {}) {
    const patch = {};
    const errors = [];
    const intIn = (key, col, [lo, hi], label) => {
        if (input[key] === undefined) return;
        const n = Number(input[key]);
        if (!Number.isInteger(n) || n < lo || n > hi) errors.push(`${label} must be a whole number from ${lo} to ${hi}.`);
        else patch[col] = n;
    };
    if (input.enabled !== undefined) patch.enabled = input.enabled ? 1 : 0;
    if (input.mode !== undefined) {
        if (!MODES.includes(input.mode)) errors.push('Mode must be "button" or "captcha".');
        else patch.mode = input.mode;
    }
    if (input.failAction !== undefined) {
        if (!FAIL_ACTIONS.includes(input.failAction)) errors.push('The fail action must be none, timeout, kick or ban.');
        else patch.fail_action = input.failAction;
    }
    intIn('attempts', 'captcha_attempts', LIMITS.attempts, 'Attempts');
    intIn('windowMinutes', 'captcha_window_minutes', LIMITS.windowMinutes, 'The time limit (minutes)');
    intIn('timeoutMinutes', 'fail_timeout_minutes', LIMITS.timeoutMinutes, 'The timeout length (minutes)');
    intIn('unverifiedKickDays', 'unverified_kick_days', LIMITS.unverifiedKickDays, 'Days before unverified members are removed');
    if (input.failDm !== undefined) patch.fail_dm = input.failDm ? 1 : 0;
    for (const [key, col] of [['verifiedRoleId', 'verified_role_id'], ['unverifiedRoleId', 'unverified_role_id'], ['channelId', 'gate_channel_id']]) {
        if (input[key] === undefined) continue;
        if (input[key] === null || input[key] === '') {
            if (key === 'verifiedRoleId') errors.push('A verified role is required.');
            else patch[col] = null;
        } else if (!snowflake(input[key])) errors.push(`${key} is not a Discord id.`);
        else patch[col] = String(input[key]);
    }
    if (patch.verified_role_id && patch.unverified_role_id && patch.verified_role_id === patch.unverified_role_id) {
        errors.push('The verified and unverified roles must be different roles.');
    }
    for (const [key, col, max] of [['panelTitle', 'panel_title', 100], ['panelText', 'panel_text', 1000]]) {
        if (input[key] === undefined) continue;
        const text = String(input[key] ?? '').trim();
        if (text.length > max) errors.push(`The panel ${key === 'panelTitle' ? 'title' : 'text'} is limited to ${max} characters.`);
        else patch[col] = text || null;
    }
    return { patch, errors };
}

// ── CAPTCHA ──────────────────────────────────────────────────────────────────

const defaultRandomInt = (max) => crypto.randomInt(max);

/** A fresh numeric code. `randomInt(max)` → integer in [0, max); crypto by default. */
export function generateCode(randomInt = defaultRandomInt, length = CODE_LENGTH) {
    let code = '';
    for (let i = 0; i < length; i++) code += String(randomInt(10));
    return code;
}

/** Digits only: people type "123 456" or paste with a trailing space. */
export const cleanAnswer = (input) => String(input ?? '').replace(/\D+/g, '').slice(0, 32);

/** Constant-time comparison of a typed answer with the code. */
export function answerMatches(code, input) {
    const a = Buffer.from(String(code ?? ''));
    const b = Buffer.from(cleanAnswer(input));
    if (!a.length || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/** A new challenge. `deadline` (ms or null) is the end of the completion window, if there is one. */
export function newChallenge({ code, now, deadline = null }) {
    const expiresAt = deadline == null ? now + CODE_TTL_MS : Math.min(now + CODE_TTL_MS, deadline);
    return { code, entered: '', issuedAt: now, expiresAt, refreshes: 0 };
}

export const challengeExpired = (challenge, now) => !challenge || now >= challenge.expiresAt;

/** One keypad press: a digit, 'back' or 'clear'. Anything else leaves the entry as it was. */
export function pressKey(challenge, key) {
    const entered = challenge.entered || '';
    let next = entered;
    if (/^\d$/.test(key)) next = entered.length < CODE_LENGTH ? entered + key : entered;
    else if (key === 'back') next = entered.slice(0, -1);
    else if (key === 'clear') next = '';
    return { ...challenge, entered: next };
}

/** A new code for the same challenge ("New image" or after a wrong answer). */
export function refreshChallenge(challenge, { code, now, deadline = null, countsAsRefresh = true }) {
    const fresh = newChallenge({ code, now, deadline });
    return { ...fresh, refreshes: (challenge?.refreshes || 0) + (countsAsRefresh ? 1 : 0) };
}

export const canRefresh = (challenge) => (challenge?.refreshes || 0) < MAX_REFRESHES;

/** What the entry box shows: typed digits, then a placeholder per missing one. */
export function entryDisplay(entered) {
    const typed = String(entered || '').split('');
    while (typed.length < CODE_LENGTH) typed.push('_');
    return typed.join(' ');
}

/**
 * Judge one submitted answer.
 * @returns {{ outcome: 'passed'|'retry'|'failed', attemptsUsed: number, remaining: number }}
 *   attemptsUsed counts WRONG answers only — a correct one does not use an attempt.
 */
export function judgeAttempt({ correct, attemptsUsed = 0, maxAttempts = DEFAULTS.attempts }) {
    const used = Math.max(0, Number(attemptsUsed) || 0);
    const max = Math.max(1, Number(maxAttempts) || DEFAULTS.attempts);
    if (correct) return { outcome: 'passed', attemptsUsed: used, remaining: Math.max(0, max - used) };
    const now = used + 1;
    return now >= max
        ? { outcome: 'failed', attemptsUsed: now, remaining: 0 }
        : { outcome: 'retry', attemptsUsed: now, remaining: max - now };
}

/** When the completion window closes (ms), or null for no limit. */
export function windowDeadline(startMs, windowMinutes) {
    const w = Number(windowMinutes) || 0;
    return w > 0 ? Number(startMs) + w * 60_000 : null;
}

export const windowExpired = (deadline, now) => deadline != null && now >= deadline;

/** Seconds from `now` to a deadline (ms), floored at 0; null stays null (no deadline). */
export const secondsUntil = (deadline, now) => (deadline == null ? null : Math.max(0, Math.ceil((deadline - now) / 1000)));

/**
 * The CAPTCHA picture as SVG (core/verification.js renders it to PNG; the SVG itself never leaves the
 * server). Each digit gets its own size, rotation, skew, offset and colour; noise curves cross the text
 * (one of them in each digit's colour), there is a dot field, and a turbulence displacement filter
 * warps the glyph outlines so plain OCR and template matching struggle.
 * `random()` → float in [0, 1); injected for tests.
 */
export function buildCaptchaSvg(code, random = Math.random, { width = 360, height = 120 } = {}) {
    const r = (lo, hi) => lo + random() * (hi - lo);
    const ri = (lo, hi) => Math.floor(r(lo, hi + 1));
    const hsl = (h, s, l) => `hsl(${Math.round(h)},${Math.round(s)}%,${Math.round(l)}%)`;
    const digits = String(code).replace(/\D/g, '').split('');
    const bgHue = r(0, 360);
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
    parts.push('<defs>');
    parts.push(`<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hsl(bgHue, 35, 90)}"/><stop offset="1" stop-color="${hsl(bgHue + r(40, 120), 35, 82)}"/></linearGradient>`);
    parts.push(`<filter id="warp" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="${r(0.018, 0.032).toFixed(3)}" numOctaves="2" seed="${ri(1, 9999)}" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="${r(7, 11).toFixed(1)}" xChannelSelector="R" yChannelSelector="G"/></filter>`);
    parts.push('</defs>');
    parts.push(`<rect width="${width}" height="${height}" fill="url(#bg)"/>`);
    // Background noise: faint curves and a dot field.
    for (let i = 0; i < 7; i++) {
        parts.push(`<path d="M ${r(-20, 40).toFixed(1)} ${r(0, height).toFixed(1)} C ${r(60, 160).toFixed(1)} ${r(-40, height + 40).toFixed(1)}, ${r(180, 300).toFixed(1)} ${r(-40, height + 40).toFixed(1)}, ${r(width - 40, width + 20).toFixed(1)} ${r(0, height).toFixed(1)}" stroke="${hsl(r(0, 360), 45, r(45, 70))}" stroke-width="${r(1, 2.5).toFixed(1)}" fill="none" opacity="${r(0.45, 0.8).toFixed(2)}"/>`);
    }
    for (let i = 0; i < 110; i++) {
        parts.push(`<circle cx="${r(0, width).toFixed(1)}" cy="${r(0, height).toFixed(1)}" r="${r(0.6, 2).toFixed(1)}" fill="${hsl(r(0, 360), 40, r(30, 70))}" opacity="${r(0.4, 0.9).toFixed(2)}"/>`);
    }
    // The digits, warped as one group.
    const step = (width - 40) / Math.max(1, digits.length);
    const colours = [];
    parts.push('<g filter="url(#warp)">');
    digits.forEach((d, i) => {
        const x = 20 + step * i + step / 2 + r(-6, 6);
        const y = height / 2 + r(-10, 12);
        const colour = hsl(r(0, 360), r(55, 80), r(18, 34));
        colours.push(colour);
        parts.push(`<text x="0" y="0" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${r(-28, 28).toFixed(1)}) skewX(${r(-14, 14).toFixed(1)})" font-family="DejaVu Sans, Lato, Arial, sans-serif" font-weight="bold" font-size="${ri(46, 60)}" fill="${colour}" text-anchor="middle" dominant-baseline="central">${d}</text>`);
    });
    // Strike-through curves in the text colours, so a colour filter cannot simply peel them off.
    for (let i = 0; i < 3; i++) {
        const colour = colours.length ? colours[ri(0, colours.length - 1)] : hsl(0, 0, 25);
        parts.push(`<path d="M ${r(0, 30).toFixed(1)} ${r(30, height - 30).toFixed(1)} Q ${r(width * 0.3, width * 0.7).toFixed(1)} ${r(-20, height + 20).toFixed(1)}, ${r(width - 30, width).toFixed(1)} ${r(30, height - 30).toFixed(1)}" stroke="${colour}" stroke-width="${r(2, 3.5).toFixed(1)}" fill="none"/>`);
    }
    parts.push('</g>');
    parts.push('</svg>');
    return parts.join('');
}

// ── setup wizard: locking channels ───────────────────────────────────────────

export const VIEW_CHANNEL = 1n << 10n;
export const SEND_MESSAGES = 1n << 11n;
export const ADD_REACTIONS = 1n << 6n;
export const READ_HISTORY = 1n << 16n;

const big = (v) => {
    try { return BigInt(v ?? 0); } catch { return 0n; }
};
const owOf = (channel, id) => (channel.overwrites || []).find(o => String(o.id) === String(id)) || null;
const bits = (ow) => (ow ? { allow: big(ow.allow), deny: big(ow.deny) } : null);
export const bitsOut = (b) => (b ? { allow: b.allow.toString(), deny: b.deny.toString() } : null);

/** Can @everyone see this channel? Its own @everyone overwrite decides, else the role's base permission. */
export function everyoneCanView(channel, everyoneId, everyoneBaseView) {
    const ow = bits(owOf(channel, everyoneId));
    if (ow && (ow.deny & VIEW_CHANNEL)) return false;
    if (ow && (ow.allow & VIEW_CHANNEL)) return true;
    return !!everyoneBaseView;
}

/** `before` with the View bit forced to allow or deny (every other bit untouched). */
export function withView(before, state) {
    const b = before || { allow: 0n, deny: 0n };
    if (state === 'deny') return { allow: b.allow & ~VIEW_CHANNEL, deny: b.deny | VIEW_CHANNEL };
    if (state === 'allow') return { allow: b.allow | VIEW_CHANNEL, deny: b.deny & ~VIEW_CHANNEL };
    return { allow: b.allow & ~VIEW_CHANNEL, deny: b.deny & ~VIEW_CHANNEL };
}

const sameBits = (a, b) => (a?.allow ?? 0n) === (b?.allow ?? 0n) && (a?.deny ?? 0n) === (b?.deny ?? 0n) && !!a === !!b;

/**
 * Plan the permission changes that put a server behind verification. Pure: works on a snapshot.
 *
 * snapshot = { everyoneId, everyoneBaseView, gateChannelId, rulesChannelId, updatesChannelId,
 *              verifiedRoleId, unverifiedRoleId,
 *              channels: [{ id, name, type, parentId, manageable, overwrites: [{ id, type, allow, deny }] }] }
 * opts     = { strategy: 'none'|'unverified'|'verified', hideGate: boolean }
 *
 *   'unverified'  every channel @everyone can see gets "Unverified: no View". New members carry the
 *                 role until they verify; everyone already here is untouched. The safe default.
 *   'verified'    every channel @everyone can see gets "@everyone: no View" + "Verified: View". Members
 *                 already here need the Verified role first (the wizard hands it out before locking).
 *
 * The verification channel itself is opened to whoever must use it and, with hideGate, hidden from
 * verified members. Community rules / updates channels are left alone (Discord requires @everyone to
 * see them), as are channels the bot cannot manage and channels that are already private.
 *
 * @returns {{ edits: Array<{ channelId, name, type, targetId, before, after, reason }>,
 *             skipped: Array<{ channelId, name, why }>, privateCount: number, lockedCount: number }}
 *   before/after are { allow, deny } as BigInt (null before = no overwrite yet).
 */
export function buildLockPlan(snapshot, { strategy = 'none', hideGate = true } = {}) {
    const edits = [];
    const skipped = [];
    let privateCount = 0;
    let lockedCount = 0;
    const s = snapshot;
    const push = (ch, targetId, state, reason) => {
        if (!targetId) return false;
        const before = bits(owOf(ch, targetId));
        const after = withView(before, state);
        if (before && sameBits(before, after)) return false;
        edits.push({ channelId: ch.id, name: ch.name, type: ch.type, targetId: String(targetId), before, after, reason });
        return true;
    };

    for (const ch of s.channels || []) {
        const isGate = s.gateChannelId && String(ch.id) === String(s.gateChannelId);
        if (isGate) {
            if (!ch.manageable) { skipped.push({ channelId: ch.id, name: ch.name, why: 'no-permission' }); continue; }
            if (strategy === 'unverified') push(ch, s.unverifiedRoleId, 'allow', 'gate');
            if (strategy === 'verified' && !everyoneCanView(ch, s.everyoneId, s.everyoneBaseView)) push(ch, s.everyoneId, 'allow', 'gate');
            if (hideGate && strategy !== 'none') push(ch, s.verifiedRoleId, 'deny', 'gate');
            continue;
        }
        if (strategy === 'none') continue;
        if (!everyoneCanView(ch, s.everyoneId, s.everyoneBaseView)) { privateCount++; continue; }
        if ([s.rulesChannelId, s.updatesChannelId].filter(Boolean).map(String).includes(String(ch.id))) {
            skipped.push({ channelId: ch.id, name: ch.name, why: 'community' });
            continue;
        }
        if (!ch.manageable) { skipped.push({ channelId: ch.id, name: ch.name, why: 'no-permission' }); continue; }
        let changed = false;
        if (strategy === 'unverified') {
            changed = push(ch, s.unverifiedRoleId, 'deny', 'lock');
        } else if (strategy === 'verified') {
            changed = push(ch, s.everyoneId, 'deny', 'lock');
            changed = push(ch, s.verifiedRoleId, 'allow', 'lock') || changed;
        }
        if (changed) lockedCount++;
        else skipped.push({ channelId: ch.id, name: ch.name, why: 'already-locked' });
    }
    return { edits, skipped, privateCount, lockedCount };
}

/**
 * Undo one recorded edit against what the overwrite looks like NOW. Only the View bit the wizard
 * changed is put back; every other bit (and anything staff changed since on other bits) stays.
 * An overwrite the wizard created is deleted again if nothing else is left in it.
 * @param before   { allow, deny } (BigInt or string) or null (the overwrite did not exist)
 * @param current  { allow, deny } or null (it no longer exists)
 * @returns {{ op: 'none' } | { op: 'delete' } | { op: 'put', allow: bigint, deny: bigint }}
 */
export function undoEdit(before, current, mask = VIEW_CHANNEL) {
    const b = before ? { allow: big(before.allow), deny: big(before.deny) } : { allow: 0n, deny: 0n };
    const c = current ? { allow: big(current.allow), deny: big(current.deny) } : null;
    const base = c || { allow: 0n, deny: 0n };
    const allow = (base.allow & ~mask) | (b.allow & mask);
    const deny = (base.deny & ~mask) | (b.deny & mask);
    if (!before && allow === 0n && deny === 0n) return c ? { op: 'delete' } : { op: 'none' };
    if (c && allow === c.allow && deny === c.deny) return { op: 'none' };
    return { op: 'put', allow, deny };
}

/** A Discord channel name the way the client would make it: lower case, dashes, 1-90 characters. */
export function channelSlug(name, fallback = 'verify') {
    const slug = String(name ?? '').toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/[^a-z0-9\-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
    return slug || fallback;
}

const roleName = (name, fallback) => {
    const n = String(name ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 100);
    return n || fallback;
};

/**
 * The wizard's inputs (dashboard form or command options), checked and with defaults filled in.
 * An empty channel / role id means "create one". The 'unverified' strategy needs an Unverified role,
 * so it creates one when none was picked.
 * @returns {{ options: object, errors: string[] }}
 */
export function normaliseWizardOptions(input = {}) {
    const errors = [];
    const id = (v, label) => {
        if (v == null || v === '' || v === 'create') return null;
        if (!snowflake(v)) { errors.push(`${label} is not a Discord id.`); return null; }
        return String(v);
    };
    const strategy = input.strategy ?? 'unverified';
    if (!LOCK_STRATEGIES.includes(strategy)) errors.push('The lock strategy must be none, unverified or verified.');
    const mode = input.mode ?? 'captcha';
    if (!MODES.includes(mode)) errors.push('Mode must be "button" or "captcha".');
    const options = {
        channelId: id(input.channelId, 'The channel'),
        channelName: channelSlug(input.channelName, 'verify'),
        verifiedRoleId: id(input.verifiedRoleId, 'The verified role'),
        verifiedRoleName: roleName(input.verifiedRoleName, 'Verified'),
        unverifiedRoleId: input.unverifiedRoleId === 'none' ? null : id(input.unverifiedRoleId, 'The unverified role'),
        unverifiedRoleName: roleName(input.unverifiedRoleName, 'Unverified'),
        createUnverified: input.unverifiedRoleId === 'create' || (!!input.createUnverified && !input.unverifiedRoleId),
        mode,
        strategy,
        hideGate: input.hideGate === undefined ? true : !!input.hideGate,
        grantExisting: input.grantExisting === undefined ? true : !!input.grantExisting,
        postPanel: input.postPanel === undefined ? true : !!input.postPanel,
    };
    if (strategy === 'unverified' && !options.unverifiedRoleId) options.createUnverified = true;
    if (options.verifiedRoleId && options.verifiedRoleId === options.unverifiedRoleId) {
        errors.push('The verified and unverified roles must be different roles.');
    }
    return { options, errors };
}

/** The wizard's record, as stored in verify_config.wizard_snapshot (BigInts as strings). */
export function snapshotRecord({ at, by, strategy, hideGate, created, edits, granted = null, status = 'applying' }) {
    return {
        v: 1, at, by, strategy, hideGate: !!hideGate, status,
        created: { roles: created?.roles || [], channelId: created?.channelId || null },
        edits: edits.map(e => ({ channelId: String(e.channelId), name: e.name, targetId: String(e.targetId), before: bitsOut(e.before), mask: VIEW_CHANNEL.toString() })),
        granted,
        failures: [],
    };
}

/**
 * A second wizard run on top of one that was not undone keeps the first run's edits (and what it
 * created) in front of its own. Undo walks the list backwards, so each overwrite returns to what it
 * was before the FIRST run, through the intermediate state, in one pass.
 */
export function mergeSnapshot(previous, next) {
    if (!previous || previous.status === 'undone' || !Array.isArray(previous.edits)) return next;
    return {
        ...next,
        created: {
            roles: [...new Set([...(previous.created?.roles || []), ...(next.created?.roles || [])])],
            channelId: next.created?.channelId || previous.created?.channelId || null,
        },
        edits: [...previous.edits, ...next.edits],
        runs: (previous.runs || 1) + 1,
    };
}

// ── stats ────────────────────────────────────────────────────────────────────

export const VERIFY_EVENT_LABEL = Object.freeze({
    verify_passed: 'Verified', verify_wrong: 'Wrong code', verify_failed: 'Failed (too many wrong codes)',
    verify_expired: 'Timed out', verify_kicked: 'Kicked', verify_banned: 'Banned', verify_timedout: 'Timed out (Discord timeout)',
    verify_held: 'Held (exempt or paused)', prune_kicked: 'Auto-pruned', prune_logged: 'Auto-prune (log only)',
    prune_held: 'Auto-prune held (exempt or paused)', failed: 'Could not act',
    // Inactivity prune (core/inactivity-prune.js).
    prune_inactive_kicked: 'Removed for inactivity', prune_inactive_warned: 'Warned: inactive',
    prune_inactive_logged: 'Inactive (log only)', prune_inactive_held: 'Inactivity kick held (exempt or paused)',
});

/**
 * Counts by event action (rows of { action, n }) as the numbers the dashboard and `/systems
 * verification status` show. rate = verified / (verified + failed + timed out), null with no outcomes.
 */
export function summariseStats(rows = []) {
    const n = Object.fromEntries((rows || []).map(r => [r.action, Number(r.n) || 0]));
    const out = {
        verified: n.verify_passed || 0,
        wrong: n.verify_wrong || 0,
        failed: n.verify_failed || 0,
        timedOut: n.verify_expired || 0,
        kicked: n.verify_kicked || 0,
        banned: n.verify_banned || 0,
        timeouts: n.verify_timedout || 0,
        held: n.verify_held || 0,
        pruned: n.prune_kicked || 0,
        pruneLogged: n.prune_logged || 0,
        pruneHeld: n.prune_held || 0,
        inactiveKicked: n.prune_inactive_kicked || 0,
        inactiveWarned: n.prune_inactive_warned || 0,
        inactiveLogged: n.prune_inactive_logged || 0,
        inactiveHeld: n.prune_inactive_held || 0,
    };
    const outcomes = out.verified + out.failed + out.timedOut;
    out.rate = outcomes ? out.verified / outcomes : null;
    return out;
}

export default {
    MODES, FAIL_ACTIONS, LOCK_STRATEGIES, CODE_LENGTH, LIMITS, DEFAULTS, CODE_TTL_MS, MAX_REFRESHES,
    normaliseConfig, windowApplies, validateSettings, generateCode, cleanAnswer, answerMatches, newChallenge,
    challengeExpired, pressKey, refreshChallenge, canRefresh, entryDisplay, judgeAttempt, windowDeadline,
    windowExpired, secondsUntil, buildCaptchaSvg, everyoneCanView, withView, buildLockPlan, undoEdit,
    snapshotRecord, mergeSnapshot, bitsOut, summariseStats, VERIFY_EVENT_LABEL, VIEW_CHANNEL, channelSlug, normaliseWizardOptions,
};
