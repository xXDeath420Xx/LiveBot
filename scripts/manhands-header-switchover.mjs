// Re-own the team-live header embed in Team MANHANDS guild from the old default bot
// to the new custom bot (Team Manhands). One-shot: re-fetch source embed, POST a copy
// via the new bot, then DELETE the orphan. No DB writes — there is no row pointing at
// the message in any of the 36 *_message_id columns in the schema (verified).
//
// Flags:
//   --dry         fetch + report; no POST or DELETE
//   --no-delete   POST the new copy but leave the orphan in place (for visual diff)
//   --publish     after posting, call /crosspost on the new message
//                 (channel is type 5 GUILD_ANNOUNCEMENT)
import 'dotenv/config';
import mysql from 'mysql2/promise';

const GUILD     = '1485188364318539837';
const CHANNEL   = '1485258135307292797';   // 🔴︱ᴛᴇᴀᴍ-ᴍᴀɴʜᴀɴᴅꜱ-ʟɪᴠᴇ
const OLD_MSG   = '1486449556710228189';   // posted by old default bot 2026-03-25
const NEW_BOT   = '1486807000854823155';   // ᴛᴇᴀᴍ ᴍᴀɴʜᴀɴᴅꜱ
const DRY       = process.argv.includes('--dry');
const NO_DELETE = process.argv.includes('--no-delete');
const PUBLISH   = process.argv.includes('--publish');

const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const enc = (await import('/home/death/CertiFriedUtility/utils/encryption.js')).default;
const [tokRow] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [NEW_BOT]);
if (!tokRow.length) {
    console.error(`new bot ${NEW_BOT} not in custom_bots`);
    await pool.end();
    process.exit(1);
}
const NEW_TOK = enc.decrypt(JSON.parse(tokRow[0].bot_token));
const H = { Authorization: 'Bot ' + NEW_TOK, 'Content-Type': 'application/json' };

async function rest(method, url, body) {
    for (let i = 0; i < 6; i++) {
        const r = await fetch(url, { method, headers: H, body: body && JSON.stringify(body) });
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

console.log(`mode: ${DRY ? 'DRY' : NO_DELETE ? 'POST-only' : 'POST+DELETE'}${PUBLISH ? ' +publish' : ''}`);

// 1. Fetch the original message
const src = await rest('GET', `https://discord.com/api/v10/channels/${CHANNEL}/messages/${OLD_MSG}`);
if (!src) {
    console.error('failed to fetch source message');
    await pool.end();
    process.exit(1);
}
if (src.__notfound) {
    console.log(`source message ${OLD_MSG} already gone — nothing to do`);
    await pool.end();
    process.exit(0);
}
console.log(`source author: ${src.author?.id} (${src.author?.username})`);
console.log(`source embeds: ${(src.embeds || []).length}, components: ${(src.components || []).length}, attachments: ${(src.attachments || []).length}`);
if (!(src.embeds || []).length && !(src.content || '').trim()) {
    console.error('source has no embed or content — refusing to repost an empty message');
    await pool.end();
    process.exit(1);
}

// Re-shape embeds to fields Discord accepts on POST (drop fields it would 400 on).
// Drop the original `timestamp` so Discord renders no datestamp — this is an
// evergreen channel header, not a dated post.
const newEmbeds = (src.embeds || []).map(e => ({
    title: e.title, description: e.description, url: e.url, color: e.color,
    author: e.author, footer: e.footer,
    image: e.image, thumbnail: e.thumbnail, fields: e.fields,
}));

const body = {};
if (src.content && src.content.trim()) body.content = src.content;
if (newEmbeds.length) body.embeds = newEmbeds;
if ((src.components || []).length) body.components = src.components;

if (DRY) {
    console.log('DRY: would POST embed:', JSON.stringify(newEmbeds[0], null, 2).slice(0, 600));
    console.log(`DRY: would DELETE ${OLD_MSG}${NO_DELETE ? ' (suppressed by --no-delete)' : ''}`);
    await pool.end();
    process.exit(0);
}

// 2. POST new copy
const posted = await rest('POST', `https://discord.com/api/v10/channels/${CHANNEL}/messages`, body);
if (!posted?.id) {
    console.error('POST failed; not deleting source');
    await pool.end();
    process.exit(1);
}
console.log(`POSTED new message: ${posted.id}`);

// 3. Optional crosspost (channel type 5 = GUILD_ANNOUNCEMENT)
if (PUBLISH) {
    const cp = await rest('POST', `https://discord.com/api/v10/channels/${CHANNEL}/messages/${posted.id}/crosspost`);
    if (cp?.id) console.log(`PUBLISHED (crossposted): ${cp.id}`);
    else console.log('crosspost failed or not eligible — message remains in-channel');
}

// 4. DELETE the orphan
if (NO_DELETE) {
    console.log(`--no-delete set; leaving orphan ${OLD_MSG} in place`);
} else {
    const del = await rest('DELETE', `https://discord.com/api/v10/channels/${CHANNEL}/messages/${OLD_MSG}`);
    if (del?.__ok) console.log(`DELETED orphan: ${OLD_MSG}`);
    else if (del?.__notfound) console.log(`orphan ${OLD_MSG} already gone`);
    else console.log('DELETE failed — orphan still present');
}

console.log(`\nold ${OLD_MSG} → new ${posted.id}`);
await pool.end();
