#!/usr/bin/env node
/*
 * Backfills variant_group / theme onto the QOTD history rows written before the library
 * existed.
 *
 * Without this the 90-day window can't see what the guilds were already served last month,
 * so a legacy "Early bird or night owl?" from three weeks ago wouldn't block the library's
 * "When do you do your best thinking?" — which is the same question. Legacy cards that map
 * onto a library group get that group; everything else gets a stable per-card key so it at
 * least can't repeat against itself.
 */
import dotenv from 'dotenv'; dotenv.config();
import mysql from 'mysql2/promise';

// Substring of the legacy card → the library variant group it belongs to.
const LEGACY_GROUPS = [
    ['coffee, tea',                        'morning-drink'],
    ['sunk the most hours',                'game-most-hours'],
    ['instantly master one skill',         'instant-skill'],
    ['any animal as a pet',                'dream-pet'],
    ['best concert',                       'best-live-show'],
    ['early bird or night owl',            'chronotype'],
    ["hobby you'd pick up",                'dormant-hobby'],
    ['pineapple on pizza',                 'pizza-topping-debate'],
    ['fictional world',                    'fictional-world-live'],
    ['small that always makes your day',   'small-daily-joy'],
    ['won the lottery',                    'sudden-money'],
    ['most-used emoji',                    'most-used-emoji'],
    ['summer or winter',                   'season-preference'],
    ['best piece of advice',               'advice-received'],
    ['best advice you have ever',          'advice-received'],
];

const db = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
});

try {
    const [rows] = await db.execute(`
        SELECT h.history_id, h.card_id, c.content
        FROM qotd_history h
        LEFT JOIN qotd_cards c ON c.card_id = h.card_id
        WHERE h.variant_group IS NULL
    `);

    let mapped = 0, generic = 0;
    for (const row of rows) {
        const text = (row.content || '').toLowerCase();
        const hit = LEGACY_GROUPS.find(([needle]) => text.includes(needle));
        const group = hit ? hit[1] : `deck-card-${row.card_id ?? row.history_id}`;
        await db.execute('UPDATE qotd_history SET variant_group = ? WHERE history_id = ?',
            [group, row.history_id]);
        hit ? mapped++ : generic++;
    }

    console.log(`Backfilled ${rows.length} rows — ${mapped} mapped onto library groups, ${generic} kept as deck keys.`);

    const [summary] = await db.execute(`
        SELECT guild_id, COUNT(*) AS posts, COUNT(DISTINCT variant_group) AS groups_used
        FROM qotd_history
        WHERE posted_at > DATE_SUB(NOW(), INTERVAL 90 DAY)
        GROUP BY guild_id
    `);
    console.table(summary);
} finally {
    await db.end();
}
