/*
 * Migration 310: OwO profile wallpapers, luck points and pray/curse tallies.
 * (OwO module — CC-BY-NC-SA derivative of OwO Bot, see /LICENSE-OWO-NOTICE.md.)
 *
 *   owo_backgrounds (existing, empty: bid, bname, price, name_color, active)
 *     + style        VARCHAR(12)  how core/owo/profile-card.js paints it:
 *                                 solid | gradient | stars | waves | stripes
 *     + colors       VARCHAR(64)  comma-separated #rrggbb stops
 *     + description  VARCHAR(120) one line for the shop
 *     Seeded (INSERT IGNORE) with 14 wallpapers. Upstream served pre-made PNGs from its own image
 *     host; these are drawn procedurally instead. Shop id = 200 + bid, as upstream.
 *
 *   owo_luck (existing: guild_id, id, lcount)
 *     + rolls        INT UNSIGNED — number of daily /luck rolls. Until now core/owo/luck-service.js
 *                    stored that count in lcount, which upstream (and `owo pray` / `owo curse`,
 *                    `owo top luck`) use for LUCK POINTS. When the column is first added the
 *                    existing values are MOVED: rolls = lcount, lcount = 0 (nobody had luck points
 *                    yet — pray/curse did not exist). This runs once, inside the add-column guard.
 *
 *   owo_user_pray (existing, empty: guild_id, sender, receiver, count, latest)
 *     + curses       INT UNSIGNED — curses sender put on receiver (count stays = prays), so a
 *                    profile can show "prayed for N times · cursed M times".
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
const COLUMNS = [
    ['owo_backgrounds', 'style', "VARCHAR(12) NOT NULL DEFAULT 'gradient'"],
    ['owo_backgrounds', 'colors', "VARCHAR(64) NOT NULL DEFAULT '#2c2f33'"],
    ['owo_backgrounds', 'description', 'VARCHAR(120) NULL DEFAULT NULL'],
    ['owo_user_pray', 'curses', 'INT UNSIGNED NOT NULL DEFAULT 0'],
];

// bid, bname, price, name_color (r,g,b,a), style, colors, description
const WALLPAPERS = [
    [1, 'Midnight', 2500, '255,255,255,255', 'gradient', '#0f2027,#203a43,#2c5364', 'Deep blue night tones.'],
    [2, 'Sunset', 2500, '255,255,255,255', 'gradient', '#ff7e5f,#feb47b', 'Warm orange evening glow.'],
    [3, 'Ocean', 2500, '255,255,255,255', 'waves', '#1a6fa3,#4fb3d9', 'Calm waves rolling in.'],
    [4, 'Forest', 2500, '255,255,255,255', 'gradient', '#134e5e,#71b280', 'Pine green and moss.'],
    [5, 'Charcoal', 2500, '255,255,255,255', 'solid', '#2b2d31', 'A clean dark backdrop.'],
    [6, 'Paper', 2500, '40,40,40,255', 'solid', '#f2ede3', 'Soft off-white with dark lettering.'],
    [7, 'Sakura', 10000, '74,30,48,255', 'gradient', '#ffd1dc,#ffafbd,#ffc3a0', 'Cherry blossom pinks.'],
    [8, 'Lavender', 10000, '255,255,255,255', 'gradient', '#7f7fd5,#86a8e7,#91eae4', 'Lilac fading into mint.'],
    [9, 'Ember', 10000, '255,255,255,255', 'gradient', '#8e0e00,#f12711,#f5af19', 'Glowing coals.'],
    [10, 'Candy Stripe', 10000, '255,255,255,255', 'stripes', '#ec6f9c,#f8b195', 'Playful pink stripes.'],
    [11, 'Starry Night', 25000, '255,255,255,255', 'stars', '#0b1026,#1c2260,#2b2f77', 'A sky full of stars.'],
    [12, 'Aurora', 25000, '255,255,255,255', 'waves', '#0b3d3a,#11998e,#38ef7d', 'Northern lights over still water.'],
    [13, 'Galaxy', 50000, '255,255,255,255', 'stars', '#2f0743,#41295a,#7b4397', 'Purple nebula and distant suns.'],
    [14, 'Royal Gold', 50000, '255,226,140,255', 'stripes', '#1f1c2c,#3a3550,#928dab', 'Midnight velvet, gold lettering.'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    for (const [table, column, type] of COLUMNS) {
        if (!(await hasColumn(db, table, column))) {
            await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
        }
    }

    if (!(await hasColumn(db, 'owo_luck', 'rolls'))) {
        await db.execute('ALTER TABLE `owo_luck` ADD COLUMN `rolls` INT UNSIGNED NOT NULL DEFAULT 0');
        // One-time move: lcount was being used as the /luck roll counter (see header).
        await db.execute('UPDATE `owo_luck` SET `rolls` = GREATEST(`lcount`, 0), `lcount` = 0');
    }

    for (const [bid, bname, price, nameColor, style, colors, description] of WALLPAPERS) {
        await db.execute(
            `INSERT IGNORE INTO owo_backgrounds (bid, bname, price, name_color, active, style, colors, description)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
            [bid, bname, price, nameColor, style, colors, description]
        );
    }
}

export async function down(db) {
    if (await hasColumn(db, 'owo_luck', 'rolls')) {
        // Put the roll counts back where the old code expects them.
        await db.execute('UPDATE `owo_luck` SET `lcount` = `rolls`');
        await db.execute('ALTER TABLE `owo_luck` DROP COLUMN `rolls`');
    }
    await db.execute(`DELETE FROM owo_backgrounds WHERE bid BETWEEN 1 AND ${WALLPAPERS.length}`);
    for (const [table, column] of COLUMNS) {
        if (await hasColumn(db, table, column)) {
            await db.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        }
    }
}
