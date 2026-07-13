// Phase 18: regenerate entire log category + dedup bot messages elsewhere.
//
//   1. Clone category 1496410178759954463 (Admin Logs) + every child channel
//      into a fresh category, rewire logging_config/log_event_config to new IDs,
//      then delete every old child + the old category.
//   2. In every NON-log channel: delete ALL CertiFried Utility (1409904443125665875)
//      messages.
//   3. In every NON-log channel: delete duplicate CertiFried Bear messages
//      (same content-hash posted more than once in same channel — keep earliest).
//
// Uses CertiFried Bear's token (1496406792417185802).
import 'dotenv/config';
import mysql from 'mysql2/promise';
import crypto from 'crypto';

const GUILD       = '1216126780767731722';
const OLD_CAT_ID  = '1496410178759954463';
const OLD_BOT     = '1409904443125665875';
const NEW_BOT     = '1496406792417185802';

const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const enc = (await import('/home/death/CertiFriedUtility/utils/encryption.js')).default;
const [r0] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [NEW_BOT]);
const token = enc.decrypt(JSON.parse(r0[0].bot_token));
const H = { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' };
const H_NOCT = { Authorization: 'Bot ' + token };

async function rest(method, url, body) {
    for (let i = 0; i < 6; i++) {
        const headers = body ? H : H_NOCT;
        const res = await fetch(url, { method, headers, body: body && JSON.stringify(body) });
        if (res.status === 429) {
            const b = await res.json().catch(() => ({ retry_after: 1 }));
            await new Promise(r => setTimeout(r, Math.ceil((b.retry_after || 1) * 1000) + 150));
            continue;
        }
        if (res.status === 404) return { __notfound: true };
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            console.log(`  ${method} ${url.slice(-70)}: ${res.status} ${t.slice(0, 200)}`);
            return null;
        }
        return res.status === 204 ? { __ok: true } : res.json();
    }
    return null;
}

// PHASE 1: Regenerate log category
const channels = await rest('GET', `https://discord.com/api/v10/guilds/${GUILD}/channels`);
const oldCat = channels.find(c => c.id === OLD_CAT_ID);
if (!oldCat) { console.log(`category ${OLD_CAT_ID} not found — aborting`); process.exit(1); }
const oldChildren = channels.filter(c => c.parent_id === OLD_CAT_ID);

console.log(`== PHASE 1: regenerate ${oldCat.name} (${oldCat.id}) with ${oldChildren.length} children ==`);

// Create new category with same settings
const newCat = await rest('POST', `https://discord.com/api/v10/guilds/${GUILD}/channels`, {
    name: oldCat.name,
    type: 4,
    permission_overwrites: oldCat.permission_overwrites || [],
});
if (!newCat?.id) { console.log('failed to create new category'); process.exit(1); }
console.log(`new category: ${newCat.id}`);
await rest('PATCH', `https://discord.com/api/v10/channels/${newCat.id}`, { position: oldCat.position });

// Clone each child
const idRemap = new Map(); // old child id → new child id
for (const old of oldChildren) {
    const created = await rest('POST', `https://discord.com/api/v10/guilds/${GUILD}/channels`, {
        name: old.name,
        type: old.type,
        topic: old.topic || undefined,
        nsfw: old.nsfw || false,
        rate_limit_per_user: old.rate_limit_per_user || 0,
        parent_id: newCat.id,
        permission_overwrites: old.permission_overwrites || [],
        default_auto_archive_duration: old.default_auto_archive_duration || undefined,
    });
    if (!created?.id) { console.log(`  ${old.name}: clone failed`); continue; }
    idRemap.set(old.id, created.id);
    console.log(`  ${old.name}: ${old.id} → ${created.id}`);
    await rest('PATCH', `https://discord.com/api/v10/channels/${created.id}`, { position: old.position });
}

// Rewire DB
console.log(`\n== updating DB references ==`);
try {
    const [cols] = await pool.execute(`SHOW COLUMNS FROM logging_config WHERE Field LIKE '%channel_id'`);
    for (const c of cols) {
        for (const [oldId, newId] of idRemap) {
            const [u] = await pool.execute(
                `UPDATE logging_config SET \`${c.Field}\` = ? WHERE guild_id = ? AND \`${c.Field}\` = ?`,
                [newId, GUILD, oldId]);
            if (u.affectedRows) console.log(`  logging_config.${c.Field}: ${oldId} → ${newId} (${u.affectedRows})`);
        }
    }
    for (const [oldId, newId] of idRemap) {
        const [u] = await pool.execute(
            `UPDATE log_event_config SET channel_id = ? WHERE guild_id = ? AND channel_id = ?`,
            [newId, GUILD, oldId]);
        if (u.affectedRows) console.log(`  log_event_config.channel_id: ${oldId} → ${newId} (${u.affectedRows})`);
    }
} catch (e) { console.log(`DB err: ${e.message}`); }

// Delete old children first, then old category
console.log(`\n== deleting old log channels ==`);
for (const old of oldChildren) {
    const d = await rest('DELETE', `https://discord.com/api/v10/channels/${old.id}`);
    console.log(`  ${old.name} (${old.id}): ${d?.__ok || d?.id ? 'deleted' : 'failed'}`);
}
console.log(`\n== deleting old category ${oldCat.name} ==`);
const dCat = await rest('DELETE', `https://discord.com/api/v10/channels/${oldCat.id}`);
console.log(`  category delete: ${dCat?.__ok || dCat?.id ? 'OK' : 'FAILED'}`);

// PHASE 2 + 3: delete Utility messages + Bear duplicates in NON-log channels
console.log(`\n== PHASE 2+3: clean Utility messages + Bear duplicates in non-log channels ==`);
const refreshed = await rest('GET', `https://discord.com/api/v10/guilds/${GUILD}/channels`);
const nonLog = refreshed.filter(c => [0, 5, 15].includes(c.type) && c.parent_id !== newCat.id);

let utilDel = 0, bearDupDel = 0;
function embedHash(e) {
    const s = [
        e.title || '', e.description || '', e.url || '',
        (e.fields || []).map(f => `${f.name}=${f.value}`).join('|'),
        e.image?.url || '', e.thumbnail?.url || '',
    ].join('§');
    return crypto.createHash('md5').update(s).digest('hex');
}
function msgHash(m) {
    if (m.content && m.content.trim()) return 'C:' + crypto.createHash('md5').update(m.content).digest('hex');
    if (m.embeds?.length) return 'E:' + m.embeds.map(embedHash).join(';');
    return null;
}

for (const ch of nonLog) {
    let before = null, pages = 0;
    const msgs = [];
    while (true) {
        const u = `https://discord.com/api/v10/channels/${ch.id}/messages?limit=100${before ? '&before=' + before : ''}`;
        const batch = await rest('GET', u);
        if (!batch || !batch.length || batch.__notfound) break;
        msgs.push(...batch);
        before = batch[batch.length - 1].id;
        pages++;
        if (batch.length < 100 || pages > 10) break;
    }

    const utilIds = [];
    const bearByHash = new Map(); // hash → array of { id, ts }
    for (const m of msgs) {
        if (m.author?.id === OLD_BOT) utilIds.push(m.id);
        else if (m.author?.id === NEW_BOT) {
            const h = msgHash(m);
            if (h) {
                if (!bearByHash.has(h)) bearByHash.set(h, []);
                bearByHash.get(h).push({ id: m.id, ts: m.timestamp });
            }
        }
    }

    // Delete Utility messages
    for (const id of utilIds) {
        const d = await rest('DELETE', `https://discord.com/api/v10/channels/${ch.id}/messages/${id}`);
        if (d?.__ok) utilDel++;
    }

    // Delete duplicate Bear messages (keep earliest by timestamp)
    const dupsHere = [];
    for (const [_h, arr] of bearByHash) {
        if (arr.length < 2) continue;
        arr.sort((a, b) => a.ts.localeCompare(b.ts));
        for (let i = 1; i < arr.length; i++) dupsHere.push(arr[i].id);
    }
    for (const id of dupsHere) {
        const d = await rest('DELETE', `https://discord.com/api/v10/channels/${ch.id}/messages/${id}`);
        if (d?.__ok) bearDupDel++;
    }

    if (utilIds.length || dupsHere.length) {
        console.log(`  #${ch.name}: util=${utilIds.length} dupes=${dupsHere.length}`);
    }
}

console.log(`\nSUMMARY: utility deleted=${utilDel}, bear duplicates deleted=${bearDupDel}`);
console.log('DONE');
await pool.end();
