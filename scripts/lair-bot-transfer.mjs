// Full content transfer: CertiFried Utility (default) → CertiFried Bear (custom)
// in Mama Bear's Lair. Resumable via idMap.json on disk.
//
// Fixes vs. prior 16-full-bot-transfer.mjs:
//  - idMap stores { newId, channelId } so deletes go to the correct channel only
//  - Deletes use the rate-limit-aware rest() wrapper (was raw fetch, silently lost 429s)
//  - DB UPDATE also scopes by guild_id (was by old message id alone — safer)
//  - Writes idMap.json incrementally so a mid-run crash is resumable
//  - Dry-run mode: `--dry` just counts, no posts/deletes/db writes
import 'dotenv/config';
import fs from 'fs';
import mysql from 'mysql2/promise';

const GUILD    = '1216126780767731722';
const OLD_BOT  = '1409904443125665875';
const NEW_BOT  = '1496406792417185802';
const DRY      = process.argv.includes('--dry');
const SKIP_DEL = process.argv.includes('--skip-delete');
const MAP_PATH = '/home/death/CertiFriedUtility/scripts/lair/transfer-map.json';

const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

const enc = (await import('/home/death/CertiFriedUtility/utils/encryption.js')).default;
const [tokRow] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [NEW_BOT]);
const newToken = enc.decrypt(JSON.parse(tokRow[0].bot_token));
const oldToken = process.env.DISCORD_TOKEN;
const OLD_H = { Authorization: 'Bot ' + oldToken, 'Content-Type': 'application/json' };
const NEW_H = { Authorization: 'Bot ' + newToken, 'Content-Type': 'application/json' };

async function rest(headers, method, url, body) {
    for (let i = 0; i < 6; i++) {
        const r = await fetch(url, { method, headers, body: body && JSON.stringify(body) });
        if (r.status === 429) {
            const b = await r.json().catch(() => ({ retry_after: 1 }));
            await new Promise(res => setTimeout(res, Math.ceil((b.retry_after || 1) * 1000) + 150));
            continue;
        }
        if (r.status === 404) return { __notfound: true };
        if (!r.ok) {
            const t = await r.text().catch(() => '');
            console.log(`  ${method} ${url}: ${r.status} ${t.slice(0, 200)}`);
            return null;
        }
        return r.status === 204 ? { __ok: true } : r.json();
    }
    return null;
}

// Resume map if exists
let idMap = new Map();
if (fs.existsSync(MAP_PATH)) {
    try {
        const raw = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
        if (Array.isArray(raw)) {
            for (const [k, v] of raw) {
                idMap.set(k, typeof v === 'string' ? { newId: v, channelId: null } : v);
            }
        }
        console.log(`resuming with ${idMap.size} prior mappings`);
    } catch { /* ignore */ }
}
function saveMap() {
    fs.writeFileSync(MAP_PATH, JSON.stringify(Array.from(idMap.entries()), null, 2));
}

// 1. List all text/announcement/forum channels
const channels = await rest(OLD_H, 'GET', `https://discord.com/api/v10/guilds/${GUILD}/channels`);
const textLike = channels.filter(c => [0, 5, 15].includes(c.type));
console.log(`${DRY ? '[DRY] ' : ''}scanning ${textLike.length} channels`);

const perChannel = {};
let totalMatched = 0;

// 2. Scan + repost (unless --dry)
for (const ch of textLike) {
    const stat = { scanned: 0, matched: 0, reposted: 0, failed: 0, skipped: 0 };
    perChannel[ch.id] = stat;

    let before = null, pages = 0;
    const toRepost = [];
    while (true) {
        const url = `https://discord.com/api/v10/channels/${ch.id}/messages?limit=100${before ? '&before=' + before : ''}`;
        const batch = await rest(OLD_H, 'GET', url);
        if (!batch || !batch.length || batch.__notfound) break;
        stat.scanned += batch.length;
        for (const m of batch) {
            if (m.author?.id === OLD_BOT) {
                stat.matched++;
                toRepost.push(m);
            }
        }
        before = batch[batch.length - 1].id;
        pages++;
        if (batch.length < 100 || pages > 50) break;
    }
    totalMatched += stat.matched;
    if (!toRepost.length) continue;
    toRepost.reverse();

    if (DRY) {
        console.log(`  #${ch.name}: matched=${stat.matched} (dry)`);
        continue;
    }

    for (const m of toRepost) {
        if (idMap.has(m.id)) { stat.skipped++; continue; }
        try {
            const body = {};
            if (m.content && m.content.trim()) body.content = m.content;
            if (m.embeds?.length) body.embeds = m.embeds.map(e => ({
                title: e.title, description: e.description, url: e.url, color: e.color,
                timestamp: e.timestamp, author: e.author, footer: e.footer,
                image: e.image, thumbnail: e.thumbnail, fields: e.fields,
            }));
            if (m.components?.length) body.components = m.components;

            if (m.attachments?.length) {
                const files = [];
                for (const a of m.attachments) {
                    try {
                        const r = await fetch(a.url);
                        if (r.ok) {
                            const buf = Buffer.from(await r.arrayBuffer());
                            files.push({ name: a.filename, data: buf, contentType: a.content_type });
                        }
                    } catch { /* skip */ }
                }
                if (files.length) {
                    const fd = new FormData();
                    fd.append('payload_json', JSON.stringify(body));
                    files.forEach((f, i) => fd.append(`files[${i}]`,
                        new Blob([f.data], { type: f.contentType || 'application/octet-stream' }), f.name));
                    const r = await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
                        method: 'POST', headers: { Authorization: 'Bot ' + newToken }, body: fd,
                    });
                    if (!r.ok) { stat.failed++; console.log(`  repost failed in #${ch.name}: ${r.status}`); continue; }
                    const newMsg = await r.json();
                    idMap.set(m.id, { newId: newMsg.id, channelId: ch.id });
                    stat.reposted++;
                    if (stat.reposted % 10 === 0) saveMap();
                    continue;
                }
            }

            const posted = await rest(NEW_H, 'POST',
                `https://discord.com/api/v10/channels/${ch.id}/messages`, body);
            if (posted?.id) {
                idMap.set(m.id, { newId: posted.id, channelId: ch.id });
                stat.reposted++;
                if (stat.reposted % 10 === 0) saveMap();
            } else {
                stat.failed++;
            }
        } catch (err) {
            stat.failed++;
            console.log(`  exception in #${ch.name}: ${err.message}`);
        }
    }
    saveMap();
    console.log(`  #${ch.name}: matched=${stat.matched}, reposted=${stat.reposted}, skipped=${stat.skipped}, failed=${stat.failed}`);
}

if (DRY) {
    console.log(`\n[DRY] total matched: ${totalMatched}`);
    await pool.end();
    process.exit(0);
}

// 3. Update DB pointers (scoped by guild_id)
console.log(`\n== updating DB pointers ==`);
const ptrUpdates = [
    { table: 'verify_config',        col: 'gate_message_id' },
    { table: 'stream_signup_config', col: 'stream_signup_message_id' },
    { table: 'music_panels',         col: 'message_id' },
    { table: 'reaction_role_panels', col: 'message_id' },
    { table: 'ticket_panels',        col: 'panel_message_id' },
];
for (const { table, col } of ptrUpdates) {
    try {
        const [rows] = await pool.execute(
            `SELECT ${col} AS v FROM ${table} WHERE guild_id = ? AND ${col} IS NOT NULL`, [GUILD]);
        for (const row of rows) {
            const ent = idMap.get(row.v);
            if (!ent) continue;
            await pool.execute(
                `UPDATE ${table} SET ${col} = ? WHERE guild_id = ? AND ${col} = ?`,
                [ent.newId, GUILD, row.v]);
            console.log(`  ${table}.${col}: ${row.v} → ${ent.newId}`);
        }
    } catch (e) { console.log(`  ${table}: ${e.message}`); }
}

// 4. Delete originals (only in channels where they actually lived)
if (!SKIP_DEL) {
    console.log(`\n== deleting original CertiFried Utility messages ==`);
    let deleted = 0, delFailed = 0;
    for (const [oldId, { channelId }] of idMap) {
        if (!channelId) continue;
        const r = await rest(OLD_H, 'DELETE',
            `https://discord.com/api/v10/channels/${channelId}/messages/${oldId}`);
        if (r?.__ok) deleted++;
        else if (r?.__notfound) { /* already gone */ }
        else delFailed++;
    }
    console.log(`  deleted=${deleted}, failed=${delFailed}`);
}

const totals = Object.values(perChannel).reduce((a, s) => ({
    scanned: a.scanned + s.scanned, matched: a.matched + s.matched,
    reposted: a.reposted + s.reposted, failed: a.failed + s.failed,
}), { scanned: 0, matched: 0, reposted: 0, failed: 0 });
console.log(`\nDONE: scanned=${totals.scanned}, matched=${totals.matched}, reposted=${totals.reposted}, failed=${totals.failed}`);

saveMap();
console.log('mapping saved to', MAP_PATH);
await pool.end();
