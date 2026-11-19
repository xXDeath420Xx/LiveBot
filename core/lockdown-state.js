/*
 * Pure helpers for `/admin mod lock` / `unlock` (core/lockdown-manager.js).
 *
 * A lock records what the channel's @everyone overwrite said about Send Messages BEFORE the lock,
 * so unlock can put back exactly that: an explicit allow, an explicit deny, or nothing at all
 * ("neutral" — inherit from the category/server). `had_overwrite` additionally remembers whether
 * an @everyone overwrite existed at all, so unlocking a channel that never had one removes the
 * overwrite the lock created instead of leaving an empty one behind.
 *
 * Bitfields are BigInt (discord.js PermissionsBitField.bitfield) so this file needs no discord.js.
 */

export const STATE_VERSION = 1;
const STATES = new Set(['allow', 'deny', 'neutral']);

/**
 * @param {bigint|null} allowBits  @everyone overwrite allow bitfield, or null when there is no overwrite
 * @param {bigint|null} denyBits   @everyone overwrite deny bitfield, or null when there is no overwrite
 * @param {bigint} sendBit         PermissionFlagsBits.SendMessages
 */
export function describeSendState(allowBits, denyBits, sendBit) {
    const had = allowBits !== null && allowBits !== undefined;
    const allow = had ? BigInt(allowBits) : 0n;
    const deny = had ? BigInt(denyBits ?? 0n) : 0n;
    const bit = BigInt(sendBit);
    let state = 'neutral';
    if ((allow & bit) === bit) state = 'allow';
    else if ((deny & bit) === bit) state = 'deny';
    return { version: STATE_VERSION, send_messages: state, had_overwrite: had };
}

export function serialiseLockState(state) {
    return JSON.stringify({
        version: STATE_VERSION,
        send_messages: state.send_messages,
        had_overwrite: !!state.had_overwrite,
    });
}

/** lockdowns.original_perms → state, or null when it is missing/unreadable (caller falls back). */
export function parseLockState(raw) {
    if (!raw) return null;
    let v;
    try {
        v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
    if (!v || !STATES.has(v.send_messages)) return null;
    return { version: Number(v.version) || STATE_VERSION, send_messages: v.send_messages, had_overwrite: !!v.had_overwrite };
}

/** The value to pass as `SendMessages` in permissionOverwrites.edit() to restore `state`. */
export function restoreValueFor(state) {
    if (!state) return null;
    if (state.send_messages === 'allow') return true;
    if (state.send_messages === 'deny') return false;
    return null;
}

/**
 * After restoring, should the @everyone overwrite be deleted outright? Only when there was none
 * before the lock and the restore left it empty — an overwrite someone has since added other
 * permissions to is kept.
 */
export function shouldDeleteOverwrite(state, allowBits, denyBits) {
    if (!state || state.had_overwrite) return false;
    return BigInt(allowBits ?? 0n) === 0n && BigInt(denyBits ?? 0n) === 0n;
}

export function describeStateForHumans(state) {
    if (!state) return 'unknown';
    if (state.send_messages === 'allow') return 'explicitly allowed';
    if (state.send_messages === 'deny') return 'explicitly denied';
    return state.had_overwrite ? 'not set (inherited)' : 'no @everyone overwrite (inherited)';
}
