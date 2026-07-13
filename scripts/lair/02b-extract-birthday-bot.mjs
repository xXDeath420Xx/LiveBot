// Phase 2b — targeted re-scan for Birthday Bot messages only.
// Correct user id: 656621136808902656 (missed in first pass).
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ChannelType } from 'discord.js';

const GUILD = '1216126780767731722';
const OUT = path.resolve('/home/death/CertiFriedUtility/scripts/lair/birthday-bot.jsonl');
const LOG = path.resolve('/home/death/CertiFriedUtility/scripts/lair/birthday-bot.log');
const BIRTHDAY_BOT_ID = '656621136808902656';

const token = process.env.DISCORD_TOKEN;
const H = { Authorization: 'Bot ' + token };
const outStream = fs.createWriteStream(OUT, { flags: 'w' });
const logStream = fs.createWriteStream(LOG, { flags: 'w' });
const log = (msg) => { const ts = new Date().toISOString().slice(11, 19); console.log(`[${ts}] ${msg}`); logStream.write(`[${ts}] ${msg}\n`); };

async function rest(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        const r = await fetch(url, { headers: H });
        if (r.status === 429) {
            const body = await r.json().catch(() => ({ retry_after: 1 }));
            await new Promise(res => setTimeout(res, Math.ceil((body.retry_after || 1) * 1000)));
            continue;
        }
        if (r.ok) return r.json();
        if (r.status === 403 || r.status === 404) return null;
        await new Promise(res => setTimeout(res, 500));
    }
    return null;
}

async function scanChannel(ch, stats) {
    let before = null, pages = 0;
    while (true) {
        const batch = await rest(`https://discord.com/api/v10/channels/${ch.id}/messages?limit=100${before ? '&before=' + before : ''}`);
        if (!batch || !batch.length) break;
        pages++;
        stats.scanned += batch.length;
        for (const m of batch) {
            if (m.author?.id === BIRTHDAY_BOT_ID) {
                outStream.write(JSON.stringify({
                    scope_id: ch.id, scope_name: ch.name,
                    msg_id: m.id, timestamp: m.timestamp,
                    content: m.content || '',
                    embeds: m.embeds || [],
                }) + '\n');
                stats.captured++;
            }
        }
        before = batch[batch.length - 1].id;
        if (batch.length < 100) break;
    }
    if (pages > 0) log(`  #${ch.name}: ${pages} pages scanned`);
}

const chans = await rest(`https://discord.com/api/v10/guilds/${GUILD}/channels`);
const activeThreads = await rest(`https://discord.com/api/v10/guilds/${GUILD}/threads/active`);
const textLike = chans.filter(c =>
    c.type === ChannelType.GuildText ||
    c.type === ChannelType.GuildAnnouncement
);
log(`scanning ${textLike.length} channels for Birthday Bot (${BIRTHDAY_BOT_ID})`);

const stats = { scanned: 0, captured: 0 };
for (const ch of textLike) {
    await scanChannel(ch, stats);
    // Archived threads
    const archived = await rest(`https://discord.com/api/v10/channels/${ch.id}/threads/archived/public?limit=100`);
    if (archived?.threads) {
        for (const t of archived.threads) await scanChannel(t, stats);
    }
    // Active threads under this channel
    const active = (activeThreads?.threads || []).filter(t => t.parent_id === ch.id);
    for (const t of active) await scanChannel(t, stats);
}

log(`DONE: scanned=${stats.scanned}, captured=${stats.captured}`);
outStream.end();
logStream.end();
