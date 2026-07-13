// Finisher: repost remaining functional panels, update DB pointers, delete every
// remaining OLD_BOT message in all channels (logs included — just no more reposts there).
import 'dotenv/config';
import fs from 'fs';
import mysql from 'mysql2/promise';

const GUILD   = '1216126780767731722';
const OLD_BOT = '1409904443125665875';
const NEW_BOT = '1496406792417185802';
const MAP_PATH = '/home/death/CertiFriedUtility/scripts/lair/transfer-map.json';

// Channels where we still care to repost (functional panels / recent user-facing)
// Everything else: delete only, no repost.
const REPOST_CHANNELS = new Set([
    '1216126782131142658', // replaced below, real ids derived at runtime by name
]);
// We resolve by name instead — easier:
const REPOST_NAMES = ['stream-signup', 'roles', 'music'];

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
        if (r.status === 403) return { __forbidden: true };
        if (!r.ok) {
            const t = await r.text().catch(() => '');
            console.log(`  ${method} ${url.slice(-60)}: ${r.status} ${t.slice(0, 160)}`);
            return null;
        }
        return r.status === 204 ? { __ok: true } : r.json();
    }
    return null;
}

// Load existing map
let idMap = new Map();
if (fs.existsSync(MAP_PATH)) {
    try {
        const raw = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
        for (const [k, v] of raw) idMap.set(k, typeof v === 'string' ? { newId: v, channelId: null } : v);
    } catch { /* ignore */ }
}
console.log(`loaded ${idMap.size} prior mappings`);

function saveMap() {
    fs.writeFileSync(MAP_PATH, JSON.stringify(Array.from(idMap.entries()), null, 2));
}

// 1. List channels
const channels = await rest(OLD_H, 'GET', `https://discord.com/api/v10/guilds/${GUILD}/channels`);
const textLike = channels.filter(c => [0, 5, 15].includes(c.type));

// 2. Repost remaining functional messages ONLY in #stream-signup, #roles, #music
const repostChannels = textLike.filter(c =>
    REPOST_NAMES.some(n => c.name.toLowerCase().includes(n)));
console.log(`repost phase: ${repostChannels.length} channels → ${repostChannels.map(c => c.name).join(', ')}`);

for (const ch of repostChannels) {
    let before = null, pages = 0, reposted = 0, skipped = 0, failed = 0;
    const toRepost = [];
    while (true) {
        const url = `https://discord.com/api/v10/channels/${ch.id}/messages?limit=100${before ? '&before=' + before : ''}`;
        const batch = await rest(OLD_H, 'GET', url);
        if (!batch || !batch.length || batch.__notfound) break;
        for (const m of batch) if (m.author?.id === OLD_BOT) toRepost.push(m);
        before = batch[batch.length - 1].id;
        pages++;
        if (batch.length < 100 || pages > 30) break;
    }
    toRepost.reverse();
    for (const m of toRepost) {
        if (idMap.has(m.id)) { skipped++; continue; }
        const body = {};
        if (m.content && m.content.trim()) body.content = m.content;
        if (m.embeds?.length) body.embeds = m.embeds.map(e => ({
            title: e.title, description: e.description, url: e.url, color: e.color,
            timestamp: e.timestamp, author: e.author, footer: e.footer,
            image: e.image, thumbnail: e.thumbnail, fields: e.fields,
        }));
        if (m.components?.length) body.components = m.components;
        if (!body.content && !body.embeds?.length && !body.components?.length) { failed++; continue; }

        const posted = await rest(NEW_H, 'POST',
            `https://discord.com/api/v10/channels/${ch.id}/messages`, body);
        if (posted?.id) {
            idMap.set(m.id, { newId: posted.id, channelId: ch.id });
            reposted++;
            saveMap();
        } else {
            failed++;
        }
    }
    console.log(`  #${ch.name}: matched=${toRepost.length}, reposted=${reposted}, skipped=${skipped}, failed=${failed}`);
}

// 3. Update DB pointers
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

// 4. Delete every OLD_BOT message in every channel (fresh scan — doesn't rely on idMap)
console.log(`\n== deleting ALL old CertiFried Utility messages (fresh scan) ==`);
let totalDeleted = 0, totalNotFound = 0, totalFailed = 0;
for (const ch of textLike) {
    let before = null, pages = 0;
    const ids = [];
    while (true) {
        const url = `https://discord.com/api/v10/channels/${ch.id}/messages?limit=100${before ? '&before=' + before : ''}`;
        const batch = await rest(OLD_H, 'GET', url);
        if (!batch || !batch.length || batch.__notfound) break;
        for (const m of batch) if (m.author?.id === OLD_BOT) ids.push(m.id);
        before = batch[batch.length - 1].id;
        pages++;
        if (batch.length < 100 || pages > 50) break;
    }
    if (!ids.length) continue;

    // Prefer bulk-delete for messages < 14 days old. Simplest: try individual deletes.
    let d = 0, nf = 0, f = 0;
    for (const id of ids) {
        const r = await rest(OLD_H, 'DELETE',
            `https://discord.com/api/v10/channels/${ch.id}/messages/${id}`);
        if (r?.__ok) d++;
        else if (r?.__notfound) nf++;
        else f++;
    }
    totalDeleted += d; totalNotFound += nf; totalFailed += f;
    console.log(`  #${ch.name}: deleted=${d} notfound=${nf} failed=${f}`);
}
console.log(`\nDELETE totals: deleted=${totalDeleted}, notfound=${totalNotFound}, failed=${totalFailed}`);

saveMap();
console.log('\nDONE — mapping saved to', MAP_PATH);
await pool.end();
