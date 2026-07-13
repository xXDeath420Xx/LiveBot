// Final cleanup for Lair:
//   1. Clone + delete the 5 log channels (no reposts), update DB paths
//   2. In every other channel, delete only the old CertiFried Utility messages
//      (leave CertiFried Bear's already-posted messages)
// Uses Bear's token since Utility has left the guild.
import 'dotenv/config';
import mysql from 'mysql2/promise';

const GUILD   = '1216126780767731722';
const OLD_BOT = '1409904443125665875';
const NEW_BOT = '1496406792417185802';
const LOG_NAMES = ['member-log', 'message-log', 'mod-log', 'channel-log', 'role-log'];

const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const enc = (await import('/home/death/CertiFriedUtility/utils/encryption.js')).default;
const [r] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [NEW_BOT]);
const bearToken = enc.decrypt(JSON.parse(r[0].bot_token));
const H = { Authorization: 'Bot ' + bearToken, 'Content-Type': 'application/json' };
const H_NO_CT = { Authorization: 'Bot ' + bearToken };

async function rest(method, url, body) {
    for (let i = 0; i < 6; i++) {
        const headers = body ? H : H_NO_CT;
        const r = await fetch(url, { method, headers, body: body && JSON.stringify(body) });
        if (r.status === 429) {
            const b = await r.json().catch(() => ({ retry_after: 1 }));
            await new Promise(res => setTimeout(res, Math.ceil((b.retry_after || 1) * 1000) + 150));
            continue;
        }
        if (r.status === 404) return { __notfound: true };
        if (!r.ok) {
            const t = await r.text().catch(() => '');
            console.log(`  ${method} ${url.slice(-60)}: ${r.status} ${t.slice(0, 180)}`);
            return null;
        }
        return r.status === 204 ? { __ok: true } : r.json();
    }
    return null;
}

const channels = await rest('GET', `https://discord.com/api/v10/guilds/${GUILD}/channels`);
const textLike = channels.filter(c => [0, 5, 15].includes(c.type));
const isLog = n => LOG_NAMES.some(s => n.toLowerCase().includes(s));

// PHASE 1: clone + delete log channels
console.log('== PHASE 1: log channels — clone + delete ==');
const logChans = textLike.filter(c => isLog(c.name));
for (const old of logChans) {
    console.log(`-- #${old.name} (${old.id}) --`);
    const payload = {
        name: old.name,
        type: old.type,
        topic: old.topic || undefined,
        nsfw: old.nsfw || false,
        rate_limit_per_user: old.rate_limit_per_user || 0,
        parent_id: old.parent_id || undefined,
        permission_overwrites: old.permission_overwrites || [],
        default_auto_archive_duration: old.default_auto_archive_duration || undefined,
    };
    const created = await rest('POST', `https://discord.com/api/v10/guilds/${GUILD}/channels`, payload);
    if (!created?.id) { console.log('  clone failed, skip'); continue; }
    console.log(`  clone → ${created.id}`);
    await rest('PATCH', `https://discord.com/api/v10/channels/${created.id}`, { position: old.position });

    // DB path updates (logging_config per-event columns + log_event_config)
    try {
        const [cols] = await pool.execute(`SHOW COLUMNS FROM logging_config WHERE Field LIKE '%channel_id'`);
        for (const c of cols) {
            const [u] = await pool.execute(
                `UPDATE logging_config SET \`${c.Field}\` = ? WHERE guild_id = ? AND \`${c.Field}\` = ?`,
                [created.id, GUILD, old.id]);
            if (u.affectedRows) console.log(`  logging_config.${c.Field} updated (${u.affectedRows})`);
        }
        const [u2] = await pool.execute(
            `UPDATE log_event_config SET channel_id = ? WHERE guild_id = ? AND channel_id = ?`,
            [created.id, GUILD, old.id]);
        if (u2.affectedRows) console.log(`  log_event_config.channel_id updated (${u2.affectedRows})`);
    } catch (e) { console.log(`  DB err: ${e.message}`); }

    const del = await rest('DELETE', `https://discord.com/api/v10/channels/${old.id}`);
    console.log(`  old deleted: ${del?.__ok || del?.id ? 'yes' : 'no'}`);
}

// PHASE 2: in every OTHER channel, delete old Utility messages
console.log('\n== PHASE 2: delete old CertiFried Utility messages in non-log channels ==');
const otherChans = textLike.filter(c => !isLog(c.name));
let delTotal = 0, nfTotal = 0, failTotal = 0;
for (const ch of otherChans) {
    let before = null, pages = 0;
    const ids = [];
    while (true) {
        const url = `https://discord.com/api/v10/channels/${ch.id}/messages?limit=100${before ? '&before=' + before : ''}`;
        const batch = await rest('GET', url);
        if (!batch || !batch.length || batch.__notfound) break;
        for (const m of batch) if (m.author?.id === OLD_BOT) ids.push(m.id);
        before = batch[batch.length - 1].id;
        pages++;
        if (batch.length < 100 || pages > 20) break;
    }
    if (!ids.length) continue;
    let d = 0, nf = 0, f = 0;
    for (const id of ids) {
        const r = await rest('DELETE', `https://discord.com/api/v10/channels/${ch.id}/messages/${id}`);
        if (r?.__ok) d++;
        else if (r?.__notfound) nf++;
        else f++;
    }
    delTotal += d; nfTotal += nf; failTotal += f;
    console.log(`  #${ch.name}: deleted=${d} notfound=${nf} failed=${f}`);
}
console.log(`\nPHASE 2 totals: deleted=${delTotal}, notfound=${nfTotal}, failed=${failTotal}`);

console.log('\nDONE');
await pool.end();
