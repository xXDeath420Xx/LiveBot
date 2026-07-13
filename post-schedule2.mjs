import mysql from 'mysql2/promise';
import crypto from 'crypto';

const db = await mysql.createConnection({
    host: 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'cert_CertiFriedUtility'
});

const botId = '1490499612262531303';
const channelId = '1480521615514271777';
const guildId = '1175199444187234305';

// Get bot token
const [[botRow]] = await db.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [botId]);
// Decrypt token
const encData = JSON.parse(botRow.bot_token);
const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(process.env.BOT_ENCRYPTION_KEY, 'hex'), Buffer.from(encData.iv, 'hex'));
decipher.setAuthTag(Buffer.from(encData.authTag, 'hex'));
const token = decipher.update(encData.encrypted, 'hex', 'utf8') + decipher.final('utf8');

// Get config
const [[config]] = await db.execute('SELECT * FROM twitch_schedule_sync_config WHERE guild_id = ? AND discord_channel_id = ?', [guildId, channelId]);
const [[streamer]] = await db.execute('SELECT username FROM streamers WHERE id = ?', [config.streamer_id]);
const username = streamer.username;
console.log('Streamer:', username);

// Twitch auth
const tr = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`
});
const ta = await tr.json();

const ur = await fetch(`https://api.twitch.tv/helix/users?login=${username}`, {
    headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${ta.access_token}` }
});
const ud = await ur.json();
const tuid = ud.data[0].id;
const pimg = ud.data[0].profile_image_url;

const sr = await fetch(`https://api.twitch.tv/helix/schedule?broadcaster_id=${tuid}`, {
    headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${ta.access_token}` }
});
const sd = await sr.json();
const segs = (sd.data?.segments || []).slice(0, 10);
console.log('Segments:', segs.length);

const fields = segs.map(s => {
    const ts = Math.floor(new Date(s.start_time).getTime() / 1000);
    let v = `<t:${ts}:F> (<t:${ts}:R>)`;
    if (s.category?.name) v += `\n🎮 ${s.category.name}`;
    return { name: s.title || 'Scheduled Stream', value: v, inline: false };
});

const cm = config.custom_message || `📅 **${username}**'s streaming schedule`;
const content = `@everyone ${cm}`;
const embed = {
    color: 0x9146FF, title: `📅 ${username}'s ꜱᴛʀᴇᴀᴍɪɴɢ ꜱᴄʜᴇᴅᴜʟᴇ`,
    url: `https://twitch.tv/${username}`, thumbnail: pimg ? { url: pimg } : undefined,
    fields, timestamp: new Date().toISOString()
};

const mr = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, embeds: [embed] })
});
const msg = await mr.json();
console.log('Status:', mr.status, 'ID:', msg.id || JSON.stringify(msg));

if (msg.id) {
    const hash = crypto.createHash('md5').update(JSON.stringify(segs)).digest('hex').substring(0, 16);
    await db.execute('UPDATE twitch_schedule_sync_config SET last_message_id = ?, schedule_hash = ?, last_synced = NOW() WHERE id = ?', [msg.id, hash, config.id]);
    console.log('Saved to DB');
}

await db.end();
process.exit(0);
