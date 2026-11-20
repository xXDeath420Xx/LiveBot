/*
 * Profiles, wallpapers and the shop (rings 1..7, wallpapers by shop id 200 + id).
 */
import { q, T, withTx, CritterError } from './db.js';
import { PROFILE_ABOUT_MAX, PROFILE_TITLE_MAX, formatAcorns } from './constants.js';
import { WALLPAPERS, wallpaperById, wallpaperByShopOrId, DEFAULT_ACCENT } from './data/wallpapers.js';
import { RINGS, ringSellPrice } from './data/economy.js';
import { readWallet, debit } from './store.js';
import { buyRing, marriageOf } from './marriage.js';
import { getZoo } from './zoo.js';
import { getLuck, cookieStatus } from './social.js';
import { DAY_MS } from './constants.js';

/* ----------------------------------------------------------------------------------------------- wallpapers */

async function ownedWallpaperIds(conn, g, u) {
    const rows = await q(`SELECT wallpaper_id FROM ${T('wallpapers_owned')} WHERE guild_id = ? AND user_id = ? ORDER BY wallpaper_id`, [g, u], conn);
    return rows.map(r => Number(r.wallpaper_id));
}

/** The shop: rings, wallpapers (with owned marks) and the wallet. */
export async function shopListing(guildId, userId) {
    const g = String(guildId); const u = String(userId);
    const owned = new Set(await ownedWallpaperIds(null, g, u));
    const w = await readWallet(null, g, u);
    return {
        rings: RINGS.map(r => ({ ...r, shopId: r.id, sellPrice: ringSellPrice(r) })),
        wallpapers: WALLPAPERS.filter(x => x.active).map(x => ({ ...x, owned: owned.has(x.id) })),
        balance: w.balance,
    };
}

export function wallpaperPreview(id) {
    const wp = wallpaperByShopOrId(id);
    if (!wp) throw new CritterError('NO_SUCH_ITEM', 'There is no wallpaper with that id.');
    return wp;
}

/** Buy a wallpaper (one of each). Errors: NO_SUCH_ITEM, ALREADY_OWNED, INSUFFICIENT_FUNDS. */
export async function buyWallpaper(guildId, userId, id) {
    const g = String(guildId); const u = String(userId);
    const wp = wallpaperByShopOrId(id);
    if (!wp || !wp.active) throw new CritterError('NO_SUCH_ITEM', 'There is no wallpaper with that id.');
    return withTx(async (conn) => {
        await readWallet(conn, g, u, { lock: true });
        const [have] = await q(`SELECT 1 AS x FROM ${T('wallpapers_owned')} WHERE guild_id = ? AND user_id = ? AND wallpaper_id = ?`, [g, u, wp.id], conn);
        if (have) throw new CritterError('ALREADY_OWNED', `You already own ${wp.name}.`);
        if (!(await debit(conn, g, u, wp.price))) throw new CritterError('INSUFFICIENT_FUNDS', `${wp.name} costs ${formatAcorns(wp.price)}.`, { needed: wp.price });
        await q(`INSERT INTO ${T('wallpapers_owned')} (guild_id, user_id, wallpaper_id, bought_at) VALUES (?, ?, ?, NOW())`, [g, u, wp.id], conn);
        const w = await readWallet(conn, g, u);
        return { wallpaper: wp, balance: w.balance };
    });
}

/**
 * Buy from the shop by id: 1..7 is a ring, 201.. a wallpaper. Errors: NO_SUCH_ITEM plus the ring / wallpaper errors.
 * Returns { kind: 'ring', ...buyRing } or { kind: 'wallpaper', ...buyWallpaper }.
 */
export async function buyFromShop(guildId, userId, id) {
    const n = Number(id);
    if (Number.isInteger(n) && n >= 1 && n <= RINGS.length) return { kind: 'ring', ...(await buyRing(guildId, userId, n)) };
    if (Number.isInteger(n) && n > 200 && wallpaperById(n - 200)) return { kind: 'wallpaper', ...(await buyWallpaper(guildId, userId, n)) };
    throw new CritterError('NO_SUCH_ITEM', 'There is no shop item with that id.');
}

/** Equip an owned wallpaper; 0 / none / off / remove / default unequips. Errors: NO_SUCH_ITEM, NOT_OWNED. */
export async function equipWallpaper(guildId, userId, id) {
    const g = String(guildId); const u = String(userId);
    const s = String(id ?? '').trim().toLowerCase();
    if (['0', 'none', 'off', 'remove', 'default', ''].includes(s)) return unequipWallpaper(g, u);
    const wp = wallpaperByShopOrId(s);
    if (!wp) throw new CritterError('NO_SUCH_ITEM', 'There is no wallpaper with that id.');
    const owned = await ownedWallpaperIds(null, g, u);
    if (!owned.includes(wp.id)) throw new CritterError('NOT_OWNED', `You do not own ${wp.name}. Buy it in the shop first.`);
    await q(`INSERT INTO ${T('profiles')} (guild_id, user_id, wallpaper_id, about) VALUES (?, ?, ?, '') ON DUPLICATE KEY UPDATE wallpaper_id = VALUES(wallpaper_id)`, [g, u, wp.id]);
    return { wallpaper: wp };
}

export async function unequipWallpaper(guildId, userId) {
    await q(`UPDATE ${T('profiles')} SET wallpaper_id = NULL WHERE guild_id = ? AND user_id = ?`, [String(guildId), String(userId)]);
    return { wallpaper: null };
}

/** Owned wallpapers and which is equipped: { owned: [wallpaper], equippedId }. */
export async function ownedWallpapers(guildId, userId) {
    const g = String(guildId); const u = String(userId);
    const ids = await ownedWallpaperIds(null, g, u);
    const p = await getProfileRow(g, u);
    return { owned: ids.map(wallpaperById).filter(Boolean), equippedId: p.wallpaperId };
}

/* ----------------------------------------------------------------------------------------------- profile */

export async function getProfileRow(guildId, userId) {
    const [r] = await q(`SELECT * FROM ${T('profiles')} WHERE guild_id = ? AND user_id = ?`, [String(guildId), String(userId)]);
    return {
        wallpaperId: r?.wallpaper_id ? Number(r.wallpaper_id) : null, accent: r?.accent || null, accent2: r?.accent2 || null,
        about: r?.about || '', title: r?.title || null, isPrivate: !!r?.is_private,
    };
}

const PROFILE_COLS = new Set(['about', 'title', 'is_private']);
async function upsertProfile(g, u, col, value) {
    if (!PROFILE_COLS.has(col)) throw new Error('bad profile column');
    if (col === 'about') {
        await q(`INSERT INTO ${T('profiles')} (guild_id, user_id, about) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE about = VALUES(about)`, [g, u, value]);
    } else {
        await q(`INSERT INTO ${T('profiles')} (guild_id, user_id, ${col}, about) VALUES (?, ?, ?, '') ON DUPLICATE KEY UPDATE ${col} = VALUES(${col})`, [g, u, value]);
    }
}

/** About-me (max 255, longer text is cut; empty clears). */
export async function setAbout(guildId, userId, text) {
    const v = String(text || '').slice(0, PROFILE_ABOUT_MAX);
    await upsertProfile(String(guildId), String(userId), 'about', v);
    return { about: v };
}

/** Title (max 30, longer text is cut; empty clears). */
export async function setTitle(guildId, userId, text) {
    const v = String(text || '').trim().slice(0, PROFILE_TITLE_MAX) || null;
    await upsertProfile(String(guildId), String(userId), 'title', v);
    return { title: v };
}

const HEX = /^#?([0-9a-f]{6})$/i;
export function normalizeHex(v) {
    const m = String(v || '').trim().match(HEX);
    return m ? `#${m[1].toLowerCase()}` : null;
}

/** Accent colours (#RRGGBB, # optional). Errors: BAD_COLOR. */
export async function setAccent(guildId, userId, color, color2 = null) {
    const a = normalizeHex(color);
    if (!a) throw new CritterError('BAD_COLOR', 'Use a hex colour like #5f7a4f.');
    let b = null;
    if (color2 != null && String(color2).trim() !== '') {
        b = normalizeHex(color2);
        if (!b) throw new CritterError('BAD_COLOR', 'Use a hex colour like #5f7a4f for the second colour too.');
    }
    const g = String(guildId); const u = String(userId);
    await q(`INSERT INTO ${T('profiles')} (guild_id, user_id, accent, accent2, about) VALUES (?, ?, ?, ?, '') ON DUPLICATE KEY UPDATE accent = VALUES(accent), accent2 = VALUES(accent2)`, [g, u, a, b]);
    return { accent: a, accent2: b };
}

export async function setPrivacy(guildId, userId, isPrivate) {
    await upsertProfile(String(guildId), String(userId), 'is_private', isPrivate ? 1 : 0);
    return { isPrivate: !!isPrivate };
}

/**
 * Everything a profile card shows. A private profile returns { hidden: true } to anyone but its owner.
 * viewerId = who is looking.
 */
export async function profileView(guildId, userId, { viewerId = null, now = new Date() } = {}) {
    const g = String(guildId); const u = String(userId);
    const p = await getProfileRow(g, u);
    if (p.isPrivate && viewerId && String(viewerId) !== u) return { hidden: true };
    const [zoo, wallet, luck, cookies, m] = await Promise.all([
        getZoo(g, u), readWallet(null, g, u), getLuck(g, u), cookieStatus(g, u, { now }), marriageOf(null, g, u),
    ]);
    const wp = p.wallpaperId ? wallpaperById(p.wallpaperId) : null;
    const rarest = zoo.groups.length ? zoo.groups[0].species[0].species : null;
    return {
        hidden: false, profile: p, wallpaper: wp,
        color: p.accent || wp?.colors?.[0] || DEFAULT_ACCENT,
        uniqueAnimals: zoo.uniqueAnimals, totalCatches: zoo.totalCatches, balance: wallet.balance,
        luck, cookies: cookies.received,
        marriage: m ? { partnerId: m.partnerId, days: Math.max(0, Math.floor((now.getTime() - new Date(m.marriedAt).getTime()) / DAY_MS)), dailies: m.dailies } : null,
        rarest,
    };
}
