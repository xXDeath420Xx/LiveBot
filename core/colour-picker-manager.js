/*
 * Name-colour picker.
 *
 * Discord caps a select menu at 25 options, so a long palette normally gets a
 * "page 2" button. Five menus fit on one message instead — 125 slots — so the
 * palette is split by shade and every colour stays one tap away. Groups are
 * derived from the hue of each role's own colour, which means a colour a member
 * invents lands in the right menu without anybody maintaining a list.
 *
 * Two rules the rest of the server depends on:
 *   - A member holds at most one colour role. Picking swaps, it never stacks.
 *   - Discord paints a name with the member's HIGHEST coloured role, so every
 *     colour role must outrank any blanket role like Member, and Member itself
 *     must carry no colour. scripts/metalgurl-channel-permissions.mjs and the
 *     role build both enforce that; this module assumes it.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/** Discord's two grounds, for the readability warning. */
const DARK = '#313338';
const LIGHT = '#FFFFFF';

const srgb = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export function luminance(hex) {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => srgb(parseInt(h.slice(i, i + 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** What a member should be told before they commit to a colour. */
export function readability(hex) {
    const dark = contrast(hex, DARK);
    const light = contrast(hex, LIGHT);
    if (dark >= 3 && light >= 3) return { ok: true, dark, light };
    if (dark < 3 && light < 3) return { ok: false, dark, light, why: 'hard to read on both light and dark mode' };
    if (dark < 3) return { ok: false, dark, light, why: 'nearly invisible on dark mode, which most people use' };
    return { ok: false, dark, light, why: 'hard to read on light mode' };
}

/** Hue in degrees, for bucketing a colour into a menu. */
function hue(hex) {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return -1;                       // grey: no hue
    let deg;
    if (max === r) deg = ((g - b) / d) % 6;
    else if (max === g) deg = (b - r) / d + 2;
    else deg = (r - g) / d + 4;
    return ((deg * 60) + 360) % 360;
}
function saturation(hex) {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return max === 0 ? 0 : (max - min) / max;
}

/*
 * Four groups, not five. A message takes at most five action rows, and the
 * "Other…" / "Remove my colour" buttons need one of them — a fifth menu makes
 * Discord reject the whole panel. Greys ride with the blues rather than losing
 * a menu of their own; there are only ever a handful of them.
 */
export const GROUPS = [
    { key: 'pinks',  emoji: '🌸', label: 'Pinks & reds' },
    { key: 'warm',   emoji: '🔥', label: 'Warm' },
    { key: 'greens', emoji: '🌿', label: 'Greens & teals' },
    { key: 'blues',  emoji: '💙', label: 'Blues, purples & neutrals' },
];
export function groupFor(hex) {
    if (saturation(hex) < 0.12) return 'blues';     // greys live with the cool shades
    const d = hue(hex);
    if (d < 0) return 'blues';
    if (d >= 300 || d < 15) return 'pinks';
    if (d < 70) return 'warm';
    if (d < 200) return 'greens';
    return 'blues';
}

const hex6 = (n) => '#' + n.toString(16).padStart(6, '0').toUpperCase();

/**
 * Every role in the guild that acts as a name colour: coloured, not managed, not
 * a staff rank, and below the lowest staff role. Derived live so a colour a
 * member adds today is pickable by everyone tomorrow with no extra bookkeeping.
 */
export async function colourRoles(guild) {
    const [rows] = await pool.execute(
        'SELECT role_id FROM colour_picker_roles WHERE guild_id = ?', [guild.id]);
    const seen = new Set();
    const out = [];
    for (const { role_id } of rows) {
        if (seen.has(role_id)) continue;
        seen.add(role_id);
        const role = guild.roles.cache.get(role_id);
        // A role someone deleted by hand shouldn't keep appearing in the menu.
        if (!role) { await pool.execute(
            'DELETE FROM colour_picker_roles WHERE guild_id = ? AND role_id = ?', [guild.id, role_id]); continue; }
        out.push(role);
    }
    return out.sort((a, b) => b.position - a.position);
}

/** Where a new colour should sit: just under the top of the existing block. */
async function colourAnchor(guild) {
    const list = await colourRoles(guild);
    if (list.length) return list[0];
    const [rows] = await pool.execute(
        'SELECT role_id FROM colour_picker_config WHERE guild_id = ?', [guild.id]);
    return rows.length ? guild.roles.cache.get(rows[0].role_id) : null;
}

/** Build the five menus plus the two buttons. Pure data — no discord.js needed. */
export async function buildPicker(guild) {
    const roles = await colourRoles(guild);
    const buckets = new Map(GROUPS.map((g) => [g.key, []]));
    for (const r of roles) buckets.get(groupFor(hex6(r.color)))?.push(r);

    const components = [];
    for (const g of GROUPS) {
        const list = buckets.get(g.key) || [];
        if (!list.length) continue;
        // 25 is Discord's hard cap per menu. A group that somehow exceeds it keeps
        // its most recently created colours rather than silently truncating the new ones.
        // No per-option emoji: the same group glyph repeated down every row
        // carries no information and just makes the list harder to read. The
        // group is already named in the placeholder, and the hex says the rest.
        const options = list.slice(0, 25).map((r) => ({
            label: r.name.slice(0, 100),
            value: r.id,
            description: hex6(r.color),
        }));
        components.push({
            type: 1,
            components: [{
                type: 3,
                custom_id: `colour_pick:${g.key}`,
                placeholder: `${g.emoji} ${g.label} — ${options.length} colour${options.length === 1 ? '' : 's'}`,
                min_values: 0,
                max_values: 1,
                options,
            }],
        });
    }
    components.push({
        type: 1,
        components: [
            { type: 2, style: 1, custom_id: 'colour_other', label: 'Pick your own colour' },
            { type: 2, style: 2, custom_id: 'colour_clear', label: 'Remove my colour' },
        ],
    });
    return { components, count: roles.length };
}

/**
 * Swap a member onto one colour role. Returns the role given, or null when the
 * member asked for none.
 */
export async function applyColour(member, roleId) {
    const current = (await colourRoles(member.guild)).filter((r) => member.roles.cache.has(r.id));
    // Remove first: if the add fails on hierarchy we must not leave two colours on.
    for (const r of current) {
        if (r.id === roleId) continue;
        await member.roles.remove(r, 'Colour picker: one colour at a time').catch(() => {});
    }
    if (!roleId) return null;
    if (member.roles.cache.has(roleId)) return member.guild.roles.cache.get(roleId);
    const role = member.guild.roles.cache.get(roleId);
    if (!role) return null;
    await member.roles.add(role, 'Colour picker');
    await pool.execute(
        `INSERT INTO colour_role_usage (guild_id, role_id, last_used) VALUES (?,?,NOW())
         ON DUPLICATE KEY UPDATE last_used = NOW()`, [member.guild.id, roleId]).catch(() => {});
    return role;
}

/**
 * Create a colour a member asked for, or hand back the existing role when the
 * same shade already exists — otherwise the palette fills with near-duplicates.
 */
export async function ensureColourRole(guild, name, hex, requestedBy) {
    const wanted = hex.toUpperCase();
    const existing = (await colourRoles(guild)).find((r) => hex6(r.color) === wanted);
    if (existing) return { role: existing, created: false };

    const anchor = await colourAnchor(guild);

    const role = await guild.roles.create({
        name,
        color: parseInt(wanted.slice(1), 16),
        hoist: false,
        mentionable: false,
        permissions: [],
        reason: `Colour picker: requested by ${requestedBy}`,
    });
    // Sit it inside the colour block, never above it.
    if (anchor) await role.setPosition(Math.max(1, anchor.position - 1)).catch(() => {});
    await pool.execute(
        `INSERT INTO color_roles (guild_id, role_id, color_hex, created_by) VALUES (?,?,?,?)`,
        [guild.id, role.id, wanted, requestedBy]).catch(() => {});
    // Registering it is what makes it appear in everyone else's menu from now on.
    await pool.execute(
        `INSERT IGNORE INTO colour_picker_roles (guild_id, role_id, source, added_by) VALUES (?,?,'member',?)`,
        [guild.id, role.id, requestedBy]);
    logger.info(`[ColourPicker] created ${name} ${wanted} in ${guild.id}`, { category: 'roles' });
    return { role, created: true };
}

/**
 * Retire member-added colours nobody is wearing. Only ever touches roles this
 * feature created — a colour the owner made by hand is left alone for good.
 */
export async function retireUnusedColours(guild, olderThanDays = 30) {
    const [rows] = await pool.execute(
        `SELECT role_id FROM color_roles
          WHERE guild_id = ? AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [guild.id, olderThanDays]);
    let removed = 0;
    for (const { role_id } of rows) {
        const role = guild.roles.cache.get(role_id);
        if (!role) { await pool.execute('DELETE FROM color_roles WHERE role_id = ?', [role_id]); continue; }
        if (role.members.size > 0) continue;               // somebody is wearing it
        await role.delete('Colour picker: unused for 30 days').catch(() => {});
        await pool.execute('DELETE FROM color_roles WHERE role_id = ?', [role_id]);
        await pool.execute('DELETE FROM colour_picker_roles WHERE guild_id = ? AND role_id = ?', [guild.id, role_id]);
        removed++;
    }
    if (removed) logger.info(`[ColourPicker] retired ${removed} unused colour(s) in ${guild.id}`, { category: 'roles' });
    return removed;
}
