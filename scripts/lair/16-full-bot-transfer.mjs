// Full content transfer: every CertiFried Utility message in the Lair gets re-posted
// as CertiFried Bear. DB pointers updated. Originals deleted. Both bots keep working
// through the swap — we post new before deleting old, so the channel is never empty.
import 'dotenv/config';
import fs from 'fs';
import mysql from 'mysql2/promise';

const GUILD    = '1216126780767731722';
const OLD_BOT  = '1409904443125665875';  // CertiFried Utility (default)
const NEW_BOT  = '1496406792417185802';  // CertiFried Bear (custom)

const pool = mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
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
        if (r.status === 404) return null;
        if (!r.ok) { console.log('  ' + method + ' ' + url + ': ' + r.status + ' ' + (await r.text()).slice(0, 200)); return null; }
        return r.status === 204 ? null : r.json();
    }
    return null;
}

// 1. List all text/announcement/forum channels in Lair
const channels = await rest(OLD_H, 'GET', `https://discord.com/api/v10/guilds/${GUILD}/channels`);
const textLike = channels.filter(c => [0, 5, 15].includes(c.type));
console.log(`scanning ${textLike.length} channels for CertiFried Utility messages...`);

// 2. Scan each channel, build mapping of old → new message IDs
const idMap = new Map(); // old msg id → new msg id
const perChannel = {};   // channel_id → { scanned, matched, reposted, failed }

for (const ch of textLike) {
    const stat = { scanned: 0, matched: 0, reposted: 0, failed: 0 };
    perChannel[ch.id] = stat;

    // Paginate — CertiFried Utility's history here is short, 100-msg pages are fine
    let before = null, pages = 0;
    const toRepost = []; // in chronological order (oldest first)
    while (true) {
        const url = `https://discord.com/api/v10/channels/${ch.id}/messages?limit=100${before ? '&before=' + before : ''}`;
        const batch = await rest(OLD_H, 'GET', url);
        if (!batch || !batch.length) break;
        stat.scanned += batch.length;
        for (const m of batch) {
            if (m.author?.id === OLD_BOT) {
                stat.matched++;
                toRepost.push(m);
            }
        }
        before = batch[batch.length - 1].id;
        pages++;
        if (batch.length < 100 || pages > 30) break;
    }
    if (!toRepost.length) continue;
    toRepost.reverse(); // post oldest first so order reads naturally

    // 3. Re-post each as CertiFried Bear
    for (const m of toRepost) {
        try {
            const body = {};
            if (m.content && m.content.trim()) body.content = m.content;
            if (m.embeds?.length) body.embeds = m.embeds.map(e => ({
                title: e.title, description: e.description, url: e.url, color: e.color,
                timestamp: e.timestamp, author: e.author, footer: e.footer,
                image: e.image, thumbnail: e.thumbnail, fields: e.fields,
            }));
            if (m.components?.length) body.components = m.components;
            // Attachments: re-download, re-attach. Skip if none (most of our posts have none).
            if (m.attachments?.length) {
                const files = [];
                for (const a of m.attachments) {
                    try {
                        const r = await fetch(a.url);
                        if (r.ok) {
                            const buf = Buffer.from(await r.arrayBuffer());
                            files.push({ name: a.filename, data: buf, contentType: a.content_type });
                        }
                    } catch { /* skip missing */ }
                }
                // For attachments we need multipart upload — using FormData
                if (files.length) {
                    const fd = new FormData();
                    fd.append('payload_json', JSON.stringify(body));
                    files.forEach((f, i) => fd.append(`files[${i}]`, new Blob([f.data], { type: f.contentType || 'application/octet-stream' }), f.name));
                    const r = await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
                        method: 'POST', headers: { Authorization: 'Bot ' + newToken }, body: fd
                    });
                    if (!r.ok) { stat.failed++; console.log(`  repost failed in #${ch.name}: ${r.status}`); continue; }
                    const newMsg = await r.json();
                    idMap.set(m.id, newMsg.id);
                    stat.reposted++;
                    continue;
                }
            }

            const posted = await rest(NEW_H, 'POST', `https://discord.com/api/v10/channels/${ch.id}/messages`, body);
            if (posted?.id) { idMap.set(m.id, posted.id); stat.reposted++; }
            else stat.failed++;
        } catch (err) {
            stat.failed++;
            console.log(`  exception in #${ch.name}: ${err.message}`);
        }
    }
    console.log(`  #${ch.name}: matched=${stat.matched}, reposted=${stat.reposted}, failed=${stat.failed}`);
}

// 4. Update DB pointers using idMap
console.log(`\n== updating DB pointers ==`);
const ptrUpdates = [
    ['verify_config', 'gate_message_id', 'guild_id', GUILD],
    ['stream_signup_config', 'stream_signup_message_id', 'guild_id', GUILD],
    ['music_panels', 'message_id', 'guild_id', GUILD],
    ['reaction_role_panels', 'message_id', 'guild_id', GUILD],
    ['ticket_panels', 'panel_message_id', 'guild_id', GUILD],
    ['welcome_settings', null, null, null], // no message_id field; skip
];
for (const [table, col, whereCol, whereVal] of ptrUpdates) {
    if (!col) continue;
    try {
        const [rows] = await pool.execute(`SELECT ${col} AS v, ${whereCol} AS w FROM ${table} WHERE ${whereCol} = ?`, [whereVal]);
        for (const row of rows) {
            const newId = idMap.get(row.v);
            if (!newId) continue;
            // handle multi-row tables (reaction_role_panels has many per guild)
            await pool.execute(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [newId, row.v]);
            console.log(`  ${table}.${col}: ${row.v} → ${newId}`);
        }
    } catch (e) { console.log(`  ${table}: ${e.message}`); }
}

// Also reaction_role_panels may have multiple message_ids per guild
try {
    const [panels] = await pool.execute('SELECT id, message_id FROM reaction_role_panels WHERE guild_id = ?', [GUILD]);
    for (const p of panels) {
        const newId = idMap.get(p.message_id);
        if (newId && newId !== p.message_id) {
            await pool.execute('UPDATE reaction_role_panels SET message_id = ? WHERE id = ?', [newId, p.id]);
            console.log(`  reaction_role_panels[${p.id}].message_id: ${p.message_id} → ${newId}`);
        }
    }
} catch (e) { console.log(`  reaction_role_panels sweep: ${e.message}`); }

// 5. Delete original CertiFried Utility messages (now that re-posts are live + DB is updated)
console.log(`\n== deleting original CertiFried Utility messages ==`);
let deleted = 0;
for (const [oldId, newId] of idMap) {
    // Need the channel id — grab from the originals by walking textLike again would be slow
    // Instead pull channel per id from the earlier scan: we know which channels had matches
    // by looking at stat.reposted > 0. But we also need to map msg → channel. Simpler: scan once more
    // or delete via guild-wide search. Discord doesn't have search by id. Iterate channels.
    // Since we already have perChannel stats, we know channels with reposts. For each such channel,
    // try to delete the old message id; 404s are fine (not in this channel).
}
// Simpler: iterate channels that have reposts
for (const [chId, stat] of Object.entries(perChannel)) {
    if (!stat.reposted) continue;
    for (const oldId of idMap.keys()) {
        const r = await fetch(`https://discord.com/api/v10/channels/${chId}/messages/${oldId}`, { method: 'DELETE', headers: OLD_H });
        if (r.ok) deleted++;
        // 404 = old msg wasn't in this channel; skip quietly
    }
}
console.log(`  deleted ${deleted} original messages`);

// Summary
const totals = Object.values(perChannel).reduce((a, s) => ({ scanned: a.scanned + s.scanned, matched: a.matched + s.matched, reposted: a.reposted + s.reposted, failed: a.failed + s.failed }), { scanned: 0, matched: 0, reposted: 0, failed: 0 });
console.log(`\nDONE: scanned=${totals.scanned}, matched=${totals.matched}, reposted=${totals.reposted}, failed=${totals.failed}, db pointers updated, ${deleted} originals deleted`);

// Save mapping to disk for audit
fs.writeFileSync('/home/death/CertiFriedUtility/scripts/lair/transfer-map.json', JSON.stringify(Array.from(idMap.entries()), null, 2));
console.log('mapping saved to scripts/lair/transfer-map.json');

await pool.end();
