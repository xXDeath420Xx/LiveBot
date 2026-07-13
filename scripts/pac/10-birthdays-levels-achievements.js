// Cleanup batch: extract birthdays from #pac-birthdays + clone channel,
// clone #pac-levels to a clean channel, delete #pac-achievements.
import { ChannelType, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GUILD_ID, createPool, connectClient, getGuild, log, CHANNELS_EXISTING } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'pac-state.json'), 'utf8'));

const BIRTHDAY_CH_ID = '1457195020749901875';
const LEVELS_CH_ID   = '1439845927031672994';
const ACHIEVEMENTS_CH_ID = '1466200600067838175';

const MONTH_MAP = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// MEE6 confirmation embed:  "Duly noted, I'll wish <@!ID>'s **next/42nd** birthday in N days, on DD Month YYYY"
const BIRTHDAY_RE = /<@!?(\d+)>.*?birthday\s+in\s+\d+\s+days?,\s+on\s+(\d{1,2})\s+(\w+)\s+\d{4}/i;

function flush(prefix, msg) {
    const stamp = new Date().toISOString().slice(11, 19);
    process.stdout.write(`[${stamp}] ${prefix}: ${msg}\n`);
}

async function extractBirthdays(client) {
    flush('bday', `reading all messages from <#${BIRTHDAY_CH_ID}> via REST`);
    const results = new Map(); // user_id -> { month, day }
    let before = null, pages = 0, total = 0;
    while (true) {
        const url = `https://discord.com/api/v10/channels/${BIRTHDAY_CH_ID}/messages?limit=100` + (before ? `&before=${before}` : '');
        const res = await fetch(url, { headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` } });
        if (!res.ok) { flush('bday', `REST error ${res.status}: ${await res.text()}`); break; }
        const msgs = await res.json();
        if (!msgs.length) break;
        total += msgs.length;

        for (const m of msgs) {
            if (m.author?.id !== '159985870458322944') continue; // MEE6 only
            for (const e of m.embeds || []) {
                const src = e.description || '';
                const match = src.match(BIRTHDAY_RE);
                if (!match) continue;
                const userId = match[1];
                const day = parseInt(match[2], 10);
                const monthName = match[3].toLowerCase();
                const month = MONTH_MAP[monthName];
                if (!month || !day) continue;
                // Later messages override older ones (most recent confirmation wins)
                if (!results.has(userId)) results.set(userId, { month, day });
            }
        }

        before = msgs[msgs.length - 1].id;
        pages++;
        if (msgs.length < 100) break;
        if (pages > 40) break;
    }
    flush('bday', `read ${total} messages across ${pages} pages; parsed ${results.size} unique birthdays`);
    return results;
}

async function migrateBirthdays(ctx) {
    const birthdays = await extractBirthdays(ctx.client);

    // Clone the channel (preserves name, topic, perms, position) — fresh channel, no history.
    const old = ctx.guild.channels.cache.get(BIRTHDAY_CH_ID);
    if (!old) throw new Error('original #pac-birthdays not found');
    const clone = await old.clone({ reason: 'Pac migration: clean-slate birthday channel' });
    await clone.setPosition(old.rawPosition).catch(() => {});
    flush('bday', `cloned ${old.name} -> ${clone.id}`);

    // Wire CertiFried's birthday_config at the new channel.
    await ctx.pool.execute(`
        INSERT INTO birthday_config (guild_id, announcement_channel_id, enabled, message_template, cards_enabled, default_card_type)
        VALUES (?, ?, 1, '🎂 Happy birthday, {mention}! Hope The Pac makes it a great one.', 1, 'classic')
        ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id), enabled = 1,
                                message_template = VALUES(message_template), cards_enabled = 1
    `, [GUILD_ID, clone.id]);
    flush('bday', 'birthday_config row upserted');

    // Bulk insert parsed birthdays (skip if row already exists for that user+guild)
    let inserted = 0, skipped = 0;
    for (const [userId, { month, day }] of birthdays) {
        try {
            const [res] = await ctx.pool.execute(`
                INSERT IGNORE INTO user_birthdays (user_id, guild_id, month, day) VALUES (?, ?, ?, ?)
            `, [userId, GUILD_ID, month, day]);
            if (res.affectedRows) inserted++; else skipped++;
        } catch (e) {
            flush('bday', `  insert failed for ${userId}: ${e.message}`);
        }
    }
    flush('bday', `user_birthdays: inserted=${inserted}, skipped-existing=${skipped}`);

    // Post a header in the new channel
    const embed = new EmbedBuilder()
        .setColor(0xE91E63)
        .setTitle('🎂 Birthdays')
        .setDescription([
            'Your birthday will be announced here automatically by CertiFried on the day.',
            '',
            'To set or update yours, run **`/birthday set`** anywhere in the server.',
            '',
            `We imported **${inserted}** birthdays from MEE6's history.`,
        ].join('\n'));
    await clone.send({ embeds: [embed] }).catch(() => {});

    // Delete the old channel
    await old.delete('Pac migration: replaced by clean cloned birthday channel').catch(e => flush('bday', `  old delete failed: ${e.message}`));
    flush('bday', `old channel deleted; new id ${clone.id}`);

    // Update pac-state.json with the new id for future reference
    state.channels.birthdays = clone.id;
    fs.writeFileSync(path.join(__dirname, 'pac-state.json'), JSON.stringify(state, null, 2));
}

async function migrateLevels(ctx) {
    const old = ctx.guild.channels.cache.get(LEVELS_CH_ID);
    if (!old) { flush('lvl', 'original #pac-levels not found; skipping'); return; }
    const clone = await old.clone({ reason: 'Pac migration: clean-slate level-up channel' });
    await clone.setPosition(old.rawPosition).catch(() => {});
    flush('lvl', `cloned ${old.name} -> ${clone.id}`);

    // Rewire level_config.level_up_channel_id to the new channel
    await ctx.pool.execute(
        'UPDATE level_config SET level_up_channel_id = ? WHERE guild_id = ?',
        [clone.id, GUILD_ID]
    );
    flush('lvl', 'level_config.level_up_channel_id updated');

    // Delete the old
    await old.delete('Pac migration: replaced by clean cloned levels channel').catch(e => flush('lvl', `  old delete failed: ${e.message}`));
    flush('lvl', `old channel deleted; new id ${clone.id}`);

    state.channels.levels = clone.id;
    fs.writeFileSync(path.join(__dirname, 'pac-state.json'), JSON.stringify(state, null, 2));
}

async function deleteAchievements(ctx) {
    const ch = ctx.guild.channels.cache.get(ACHIEVEMENTS_CH_ID);
    if (!ch) { flush('ach', 'already gone'); return; }
    await ch.delete('Pac migration: achievements channel not needed').catch(e => flush('ach', `delete failed: ${e.message}`));
    flush('ach', 'deleted');
}

async function main() {
    const client = await connectClient();
    const pool = createPool();
    const guild = await getGuild(client);
    const ctx = { client, pool, guild };
    flush('main', `logged in as ${client.user.tag}`);

    const tasks = process.argv.slice(2).length ? process.argv.slice(2) : ['bday', 'lvl', 'ach'];
    try {
        for (const t of tasks) {
            if (t === 'bday') await migrateBirthdays(ctx);
            else if (t === 'lvl') await migrateLevels(ctx);
            else if (t === 'ach') await deleteAchievements(ctx);
            else flush('main', `unknown task: ${t}`);
        }
    } finally {
        try { await client.destroy(); } catch (_) {}
        try { await pool.end(); } catch (_) {}
    }
}

main().catch(err => { process.stdout.write(`FATAL ${err?.stack || err}\n`); process.exit(1); });
