/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * OwO user profile — about-me, title, accent colors. Backgrounds are
 * catalogued in owo_backgrounds but seeding them is a follow-up.
 */

import pool from '../../utils/db.js';

const ABOUT_MAX = 255;
const TITLE_MAX = 30;
const ACCENT_RE = /^#?[0-9a-fA-F]{6}$/;

function normalizeAccent(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (!ACCENT_RE.test(s)) return null;
    return s.startsWith('#') ? s : '#' + s;
}

async function ensureProfile(guildId, userId) {
    await pool.execute(
        `INSERT IGNORE INTO owo_user_profile (guild_id, uid, bid, accent, about, accent2, title, private)
         VALUES (?, ?, 0, NULL, NULL, NULL, NULL, 0)`,
        [guildId, userId]
    );
}

export async function getProfile(guildId, userId) {
    await ensureProfile(guildId, userId);
    const [[row]] = await pool.execute(
        'SELECT bid, accent, about, accent2, title, private FROM owo_user_profile WHERE guild_id = ? AND uid = ?',
        [guildId, userId]
    );
    return row
        ? {
            bid: Number(row.bid) || 0,
            accent: row.accent,
            about: row.about,
            accent2: row.accent2,
            title: row.title,
            private: row.private === 1,
        }
        : { bid: 0, accent: null, about: null, accent2: null, title: null, private: false };
}

export async function setAbout(guildId, userId, about) {
    await ensureProfile(guildId, userId);
    const v = about ? String(about).slice(0, ABOUT_MAX) : null;
    await pool.execute(
        'UPDATE owo_user_profile SET about = ? WHERE guild_id = ? AND uid = ?',
        [v, guildId, userId]
    );
    return { about: v };
}

export async function setTitle(guildId, userId, title) {
    await ensureProfile(guildId, userId);
    const v = title ? String(title).slice(0, TITLE_MAX) : null;
    await pool.execute(
        'UPDATE owo_user_profile SET title = ? WHERE guild_id = ? AND uid = ?',
        [v, guildId, userId]
    );
    return { title: v };
}

export async function setAccent(guildId, userId, accent, accent2 = null) {
    await ensureProfile(guildId, userId);
    const a = normalizeAccent(accent);
    const b = accent2 ? normalizeAccent(accent2) : null;
    if (accent && !a) return { error: 'Accent must be a 6-digit hex color (e.g., #F0A500).' };
    if (accent2 && !b) return { error: 'Second accent must be a 6-digit hex color.' };
    await pool.execute(
        'UPDATE owo_user_profile SET accent = ?, accent2 = ? WHERE guild_id = ? AND uid = ?',
        [a, b, guildId, userId]
    );
    return { accent: a, accent2: b };
}

export async function setPrivate(guildId, userId, isPrivate) {
    await ensureProfile(guildId, userId);
    await pool.execute(
        'UPDATE owo_user_profile SET private = ? WHERE guild_id = ? AND uid = ?',
        [isPrivate ? 1 : 0, guildId, userId]
    );
    return { private: !!isPrivate };
}
