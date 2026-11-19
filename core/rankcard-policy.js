/*
 * Server rules for member rank cards (Rank Cards page, feature key 'rankcard'):
 *
 *   allow_custom            off: /rankcard can only preview, list presets and reset, and every
 *                           card is drawn with the server default (stored personal styles are
 *                           kept, so turning it back on restores them).
 *   allow_uploads           off: no new background uploads, and an uploaded background is drawn
 *                           as the default gradient instead.
 *   min_level_to_customise  members below this level cannot change their card.
 *   default_accent          progress bar and avatar ring colour on cards that have not been
 *                           recoloured by the member.
 *
 * One place applies these so the /rankcard preview, /level rank and the dashboard preview all
 * draw the same card.
 */
import { getConfig } from './feature-config.js';

// Built-in colours (utils/rank-card-generator.js, and the rank_card_settings column defaults).
// A stored value equal to these was never chosen by the member, so the server accent may replace it.
const BUILTIN = {
    progress_bar_color_start: '#667eea',
    progress_bar_color_end: '#764ba2',
    avatar_border_color: '#3498db',
};

function isOn(v) {
    return v === true || v === 1 || v === '1' || v === 'true';
}

export function normaliseHex(v) {
    const s = String(v ?? '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
    if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s.toLowerCase()}`;
    return null;
}

/** A darker shade of a #rrggbb colour, for the far end of the progress bar. */
export function shade(hex, factor = 0.6) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => Math.max(0, Math.min(255, Math.round(v * factor))).toString(16).padStart(2, '0');
    return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

export async function getRankCardPolicy(guildId) {
    const cfg = await getConfig('rankcard', guildId);
    const min = Math.trunc(Number(cfg.min_level_to_customise));
    return {
        allowCustom: cfg.allow_custom === undefined ? true : isOn(cfg.allow_custom),
        allowUploads: cfg.allow_uploads === undefined ? true : isOn(cfg.allow_uploads),
        minLevel: Number.isFinite(min) ? Math.min(Math.max(min, 0), 200) : 0,
        accent: normaliseHex(cfg.default_accent),
    };
}

/**
 * The customisation a card is actually drawn with, given the member's stored row (or null).
 * Returns null when the built-in look applies unchanged.
 */
export async function effectiveRankCardSettings(guildId, stored, policy = null) {
    const p = policy || await getRankCardPolicy(guildId);
    let s = p.allowCustom && stored ? { ...stored } : null;

    if (s && s.background_type === 'image' && !p.allowUploads) {
        s.background_type = 'gradient';
        s.background_value = null;
    }

    if (p.accent) {
        const accent = {
            progress_bar_color_start: p.accent,
            progress_bar_color_end: shade(p.accent),
            avatar_border_color: p.accent,
        };
        if (!s) return accent;
        for (const [key, value] of Object.entries(accent)) {
            const mine = normaliseHex(s[key]);
            if (!mine || mine === BUILTIN[key]) s[key] = value;
        }
    }
    return s;
}

/**
 * May this member change their card right now? `action` is 'upload' for a background upload,
 * anything else for other changes. Returns { allowed, reason } with the reason written for the member.
 */
export async function canCustomise(guildId, level, action = 'change', policy = null) {
    const p = policy || await getRankCardPolicy(guildId);
    if (!p.allowCustom) {
        return { allowed: false, reason: 'Rank card customisation is turned off in this server. Everyone uses the server\'s card style.' };
    }
    if (p.minLevel > 0 && (Number(level) || 0) < p.minLevel) {
        return { allowed: false, reason: `You can customise your rank card from level ${p.minLevel}. You are level ${Number(level) || 0}.` };
    }
    if (action === 'upload' && !p.allowUploads) {
        return { allowed: false, reason: 'Custom background uploads are turned off in this server. Use `/rankcard background preset`, `color` or `gradient` instead.' };
    }
    return { allowed: true, reason: null };
}

export default { getRankCardPolicy, effectiveRankCardSettings, canCustomise, normaliseHex, shade };
