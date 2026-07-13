// Phase 2 — Raw message extraction from Mama Bear's Lair.
// Dumps every MEE6 / Birthday Bot / relevant-webhook message in the entire
// guild history (all text channels, announcement channels, forum posts, and
// all associated threads — active AND archived) to disk as JSONL.
//
// Nothing is modified on Discord. Parsing / migration happens in later phases
// against this saved data.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ChannelType } from 'discord.js';

const GUILD = '1216126780767731722';
const OUT = path.resolve('/home/death/CertiFriedUtility/scripts/lair/messages.jsonl');
const LOG = path.resolve('/home/death/CertiFriedUtility/scripts/lair/extract.log');

// Users/bots whose messages we want to preserve
const TARGET_AUTHORS = new Set([
    '159985870458322944', // MEE6
    '543317156705337344', // Birthday Bot (common id)
    '298822483060981760', // Tatsumaki (if present — common leveling bot)
    '235148962103951360', // Carl-bot (if present)
]);
// Also scan webhook messages whose name/author contains these substrings
const WEBHOOK_NAME_RX = /mee6|birthday/i;

const token = process.env.DISCORD_TOKEN;
const H = { Authorization: 'Bot ' + token };

const outStream = fs.createWriteStream(OUT, { flags: 'w' });
const logStream = fs.createWriteStream(LOG, { flags: 'w' });
const log = (msg) => {
    const ts = new Date().toISOString().slice(11, 19);
    const line = `[${ts}] ${msg}`;
    console.log(line);
    logStream.write(line + '\n');
};

async function rest(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        const r = await fetch(url, { headers: H });
        if (r.status === 429) {
            const body = await r.json().catch(() => ({ retry_after: 1 }));
            const waitMs = Math.ceil((body.retry_after || 1) * 1000);
            log(`  rate-limited, sleeping ${waitMs}ms`);
            await new Promise(res => setTimeout(res, waitMs));
            continue;
        }
        if (r.ok) return r.json();
        if (r.status === 403 || r.status === 404) return null; // not accessible
        log(`  ${r.status} on ${url} (attempt ${i + 1})`);
        await new Promise(res => setTimeout(res, 500));
    }
    return null;
}

function shouldCapture(msg) {
    if (TARGET_AUTHORS.has(msg.author?.id)) return true;
    if (msg.webhook_id && WEBHOOK_NAME_RX.test(msg.author?.username || '')) return true;
    return false;
}

async function scanChannel(ch, scanned, captured) {
    let before = null, pages = 0;
    const scope = ch.parent_id ? `thread:${ch.name}` : `#${ch.name}`;
    while (true) {
        const url = `https://discord.com/api/v10/channels/${ch.id}/messages?limit=100${before ? '&before=' + before : ''}`;
        const batch = await rest(url);
        if (!batch || !batch.length) break;
        pages++;
        scanned.count += batch.length;
        for (const m of batch) {
            if (shouldCapture(m)) {
                outStream.write(JSON.stringify({
                    scope_id: ch.id, scope_name: ch.name, parent_id: ch.parent_id || null,
                    msg_id: m.id,
                    author_id: m.author?.id, author_username: m.author?.username,
                    webhook_id: m.webhook_id || null,
                    timestamp: m.timestamp,
                    content: m.content || '',
                    embeds: m.embeds || [],
                    attachments: (m.attachments || []).map(a => ({ url: a.url, filename: a.filename, content_type: a.content_type })),
                }) + '\n');
                captured.count++;
            }
        }
        before = batch[batch.length - 1].id;
        if (batch.length < 100) break;
        if (pages % 25 === 0) log(`  ${scope}: ${pages} pages, scanned=${scanned.count}, captured=${captured.count}`);
    }
    if (pages > 0) log(`  ${scope}: done (${pages} pages)`);
}

async function listThreads(channelId) {
    const threads = [];
    // Active threads — guild-wide endpoint gives all active threads cheaply
    // But for per-channel we use channel/{id}/threads/active if available, fallback to guild-wide filter
    const archived = await rest(`https://discord.com/api/v10/channels/${channelId}/threads/archived/public?limit=100`);
    if (archived?.threads) threads.push(...archived.threads);
    return threads;
}

async function main() {
    log('fetching channel list');
    const chans = await rest(`https://discord.com/api/v10/guilds/${GUILD}/channels`);
    if (!chans) { log('FATAL: could not list channels'); process.exit(1); }

    // Active threads guild-wide
    const activeThreads = await rest(`https://discord.com/api/v10/guilds/${GUILD}/threads/active`);
    log(`active threads: ${activeThreads?.threads?.length || 0}`);

    const scanned = { count: 0 }, captured = { count: 0 };
    const textLike = chans.filter(c =>
        c.type === ChannelType.GuildText ||
        c.type === ChannelType.GuildAnnouncement ||
        c.type === ChannelType.GuildForum ||
        c.type === ChannelType.GuildMedia
    );
    log(`scanning ${textLike.length} text/announcement/forum channels`);

    for (const ch of textLike) {
        // Forum channels don't have direct messages — only threads
        if (ch.type !== ChannelType.GuildForum && ch.type !== ChannelType.GuildMedia) {
            await scanChannel(ch, scanned, captured);
        }

        // Per-channel archived public threads
        const arch = await listThreads(ch.id);
        for (const t of arch) await scanChannel(t, scanned, captured);

        // Any currently-active threads under this channel
        const active = (activeThreads?.threads || []).filter(t => t.parent_id === ch.id);
        for (const t of active) await scanChannel(t, scanned, captured);
    }

    log(`\nSCAN COMPLETE: scanned=${scanned.count}, captured=${captured.count}`);
    log(`output: ${OUT}`);
    outStream.end();
    logStream.end();
}

main().catch(err => {
    log('FATAL: ' + (err?.stack || err));
    outStream.end();
    logStream.end();
    process.exit(1);
});
