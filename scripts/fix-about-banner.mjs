// One-shot: delete the current banner-message in both About channels and
// re-post it attachment-only (no duplicate embed image). Re-pins the new one.
import 'dotenv/config';
import fs from 'fs';
import mysql from 'mysql2/promise';

const BANNER_LOCAL = '/home/death/CertiFriedUtility/dashboard/public/images/certifried-banner.png';
const TARGETS = [
    { name: 'Lair',  channelId: '1496641274151698673', oldMsgId: '1496641275569377474', botId: '1496406792417185802' },
    { name: 'Pac',   channelId: '1496641417173532683', oldMsgId: '1496641418892939356', botId: '1496352090950467595' },
];

const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const enc = (await import('/home/death/CertiFriedUtility/utils/encryption.js')).default;

async function tokenFor(botId) {
    if (botId === '1409904443125665875') return process.env.DISCORD_TOKEN;
    const [r] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [botId]);
    return enc.decrypt(JSON.parse(r[0].bot_token));
}

for (const t of TARGETS) {
    console.log(`\n-- ${t.name} --`);
    const token = await tokenFor(t.botId);

    // 1. Delete old duplicate-image banner message
    const del = await fetch(
        `https://discord.com/api/v10/channels/${t.channelId}/messages/${t.oldMsgId}`,
        { method: 'DELETE', headers: { Authorization: 'Bot ' + token } });
    console.log(`  delete old banner (${t.oldMsgId}): HTTP ${del.status}`);

    // 2. Re-post attachment-only
    const buf = fs.readFileSync(BANNER_LOCAL);
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({}));
    fd.append('files[0]', new Blob([buf], { type: 'image/png' }), 'certifried-banner.png');
    const post = await fetch(
        `https://discord.com/api/v10/channels/${t.channelId}/messages`,
        { method: 'POST', headers: { Authorization: 'Bot ' + token }, body: fd });
    if (!post.ok) {
        console.log(`  post FAILED: ${post.status} ${(await post.text()).slice(0,200)}`);
        continue;
    }
    const newMsg = await post.json();
    console.log(`  new banner posted: ${newMsg.id}`);

    // 3. Pin it
    const pin = await fetch(
        `https://discord.com/api/v10/channels/${t.channelId}/pins/${newMsg.id}`,
        { method: 'PUT', headers: { Authorization: 'Bot ' + token } });
    console.log(`  pin: HTTP ${pin.status}`);
}

console.log('\nDONE');
await pool.end();
