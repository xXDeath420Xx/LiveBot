/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 * Port of upstream OwO Bot's profile wallpapers (src/commands/commandList/social/wallpaper.js and
 * social/util/wallpaperUtil.js, Copyright (C) Christopher Thai), per server.
 *
 *   owo_backgrounds       global catalog (bid, bname, price, name_color, active) plus how to draw
 *                         it: style + colors + description (migration 310 adds those and seeds
 *                         the catalog — upstream served pre-made PNGs we don't have).
 *   owo_user_backgrounds  (guild_id, uid, bid) wallpapers a member owns in this server.
 *   owo_user_profile.bid  the equipped one (0 / NULL = none).
 *
 * Shop ids follow upstream: wallpaper bid N is item 200 + N in `owo shop` / `owo buy`.
 */
import pool from '../../utils/db.js';
import { withTx, OwoUserError } from './tx.js';
import { debitTx } from './cowoncy.js';
import { ensureProfile } from './profile-service.js';
import { WALLPAPER_SHOP_OFFSET, parseColorList } from './social-math.js';

function shape(row) {
    if (!row) return null;
    return {
        bid: Number(row.bid),
        shopId: WALLPAPER_SHOP_OFFSET + Number(row.bid),
        name: row.bname,
        price: Number(row.price) || 0,
        nameColor: row.name_color || '255,255,255,255',
        style: row.style || 'gradient',
        colors: parseColorList(row.colors),
        description: row.description || '',
        active: Number(row.active) === 1,
    };
}

const COLS = 'bid, bname, price, name_color, active, style, colors, description';

export async function listWallpapers() {
    const [rows] = await pool.execute(`SELECT ${COLS} FROM owo_backgrounds WHERE active = 1 ORDER BY price, bid`);
    return rows.map(shape);
}

export async function getWallpaper(bid) {
    const [[row]] = await pool.execute(`SELECT ${COLS} FROM owo_backgrounds WHERE bid = ?`, [bid]);
    return shape(row);
}

/** @returns {Promise<Set<number>>} bids this member owns here */
export async function ownedWallpaperIds(guildId, userId) {
    const [rows] = await pool.execute('SELECT bid FROM owo_user_backgrounds WHERE guild_id = ? AND uid = ?', [guildId, userId]);
    return new Set(rows.map(r => Number(r.bid)));
}

export async function ownedWallpapers(guildId, userId) {
    const [rows] = await pool.execute(
        `SELECT b.bid, b.bname, b.price, b.name_color, b.active, b.style, b.colors, b.description
         FROM owo_user_backgrounds ub JOIN owo_backgrounds b ON b.bid = ub.bid
         WHERE ub.guild_id = ? AND ub.uid = ? ORDER BY b.bid`,
        [guildId, userId]
    );
    return rows.map(shape);
}

/** Buy a wallpaper (one of each). */
export async function buyWallpaper(guildId, userId, bid) {
    const wp = await getWallpaper(bid);
    if (!wp || !wp.active) throw new OwoUserError('That wallpaper id is not available! See `owo shop`.');
    return withTx(async (conn) => {
        const [[have]] = await conn.execute(
            'SELECT bid FROM owo_user_backgrounds WHERE guild_id = ? AND uid = ? AND bid = ? FOR UPDATE',
            [guildId, userId, wp.bid]
        );
        if (have) throw new OwoUserError('You already own that wallpaper!');
        await debitTx(conn, guildId, userId, wp.price, "You don't have enough cowoncy! :c");
        await conn.execute('INSERT INTO owo_user_backgrounds (guild_id, uid, bid) VALUES (?, ?, ?)', [guildId, userId, wp.bid]);
        return wp;
    }, { label: 'wallpaper-buy' });
}

/** Equip an owned wallpaper; bid 0 / null takes it off. */
export async function equipWallpaper(guildId, userId, bid) {
    await ensureProfile(guildId, userId);
    const id = Number(bid) || 0;
    if (id) {
        const owned = await ownedWallpaperIds(guildId, userId);
        if (!owned.has(id)) throw new OwoUserError("You don't own that wallpaper! Buy it from `owo shop` first.");
    }
    await pool.execute('UPDATE owo_user_profile SET bid = ? WHERE guild_id = ? AND uid = ?', [id || null, guildId, userId]);
    return id ? getWallpaper(id) : null;
}

/** The member's equipped wallpaper, or null. */
export async function getEquippedWallpaper(guildId, userId) {
    const [[row]] = await pool.execute(
        `SELECT b.bid, b.bname, b.price, b.name_color, b.active, b.style, b.colors, b.description
         FROM owo_user_profile p JOIN owo_backgrounds b ON b.bid = p.bid
         WHERE p.guild_id = ? AND p.uid = ?`,
        [guildId, userId]
    );
    return shape(row);
}
