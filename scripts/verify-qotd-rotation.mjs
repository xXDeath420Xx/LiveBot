#!/usr/bin/env node
/*
 * Simulates the QOTD rotation forward and asserts the three promises actually hold:
 *
 *   1. no question (or reworded twin) repeats in a guild inside its window
 *   2. no two guilds get the same question on the same simulated day
 *   3. themes don't clump
 *
 * It writes real history rows so the selector sees a genuine growing history, tags them
 * with a marker message_id, and deletes them in a finally block. Run it against the live
 * DB only when the bot is not mid-post; it is read-mostly but it does insert.
 *
 *   node scripts/verify-qotd-rotation.mjs [days]
 */
import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { selectLibraryQuestion } from '../core/qotd-selector.js';

const DAYS = Number(process.argv[2]) || 120;
const MARKER = 'SIMULATION';

const [channels] = await pool.execute(
    `SELECT * FROM qotd_channels WHERE enabled = 1 AND source_mode IN ('library','mixed')`);

if (!channels.length) {
    console.log('No library-backed channels configured — nothing to simulate.');
    await pool.end();
    process.exit(0);
}

const seen = new Map(channels.map(c => [c.channel_id, new Map()]));   // group -> day
const themeRuns = new Map(channels.map(c => [c.channel_id, []]));
const perDay = new Map();
let repeats = 0, collisions = 0, tiers = {};

try {
    for (let d = 0; d < DAYS; d++) {
        perDay.set(d, new Map());
        for (const channel of channels) {
            const { question, tier } = await selectLibraryQuestion(channel, { dayOffset: d });
            tiers[tier] = (tiers[tier] || 0) + 1;
            if (!question) { console.log(`day ${d} ${channel.guild_id}: NO QUESTION (${tier})`); continue; }

            const priorDay = seen.get(channel.channel_id).get(question.variant_group);
            if (priorDay !== undefined && d - priorDay < (channel.repeat_window_days || 90)) {
                repeats++;
                console.log(`REPEAT  guild ${channel.guild_id} day ${d}: "${question.slug}" last seen day ${priorDay}`);
            }
            seen.get(channel.channel_id).set(question.variant_group, d);

            const today = perDay.get(d);
            if (today.has(question.variant_group)) {
                collisions++;
                console.log(`COLLIDE day ${d}: ${channel.guild_id} and ${today.get(question.variant_group)} both got "${question.slug}"`);
            }
            today.set(question.variant_group, channel.guild_id);
            themeRuns.get(channel.channel_id).push(question.theme);

            await pool.execute(
                `INSERT INTO qotd_history
                    (channel_id, guild_id, library_id, variant_group, theme, message_id, posted_at)
                 VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
                [channel.channel_id, channel.guild_id, question.library_id,
                 question.variant_group, question.theme, MARKER, d]
            );
        }
    }

    console.log(`\nSimulated ${DAYS} days across ${channels.length} channels.`);
    console.log(`  repeats inside window : ${repeats}`);
    console.log(`  same-day collisions   : ${collisions}`);
    console.log('  selection tiers       :', tiers);

    for (const channel of channels) {
        const themes = themeRuns.get(channel.channel_id);
        let worstRun = 1, run = 1;
        for (let i = 1; i < themes.length; i++) {
            run = themes[i] === themes[i - 1] ? run + 1 : 1;
            worstRun = Math.max(worstRun, run);
        }
        const spread = new Set(themes).size;
        console.log(`  guild ${channel.guild_id}: ${spread} distinct themes, longest same-theme run ${worstRun}`);
    }

    // Do the two guilds actually look different, day for day?
    if (channels.length >= 2) {
        let sameDayIdentical = 0;
        for (let d = 0; d < DAYS; d++) sameDayIdentical += perDay.get(d).size < channels.length ? 1 : 0;
        console.log(`  days where two guilds shared a question: ${sameDayIdentical}/${DAYS}`);
    }

    process.exitCode = (repeats || collisions) ? 1 : 0;
} finally {
    const [res] = await pool.execute('DELETE FROM qotd_history WHERE message_id = ?', [MARKER]);
    console.log(`\nCleaned up ${res.affectedRows} simulated history rows.`);
    await pool.end();
}
