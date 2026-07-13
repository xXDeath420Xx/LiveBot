import 'dotenv/config';
import mysql from 'mysql2/promise';
import enc from '/home/death/CertiFriedUtility/utils/encryption.js';
import { resolveStreamerIdentity, upsertStreamerByIdentity } from '/home/death/CertiFriedUtility/utils/platforms/resolve-identity.js';

const GUILD = '1099732505243959407';
const ANNOUNCE_CH = '1496351043372716053';  // #live-streams
const NEW_BOT_ID = '1496352090950467595';   // Twatwaffle Patrol (for Discord user lookup)

const STREAMERS = [
    { twitchName: 'xbatmangoddessx', discordName: 'xbatmangoddessx' },
    { twitchName: 'Naberius_Lamb',   discordName: 'Naberius_Lamb' },
    { twitchName: 'forsakenpnay',    discordName: 'WickedPnay' },
];

const pool = mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });

// Fetch guild members via Twatwaffle's token for Discord user lookup (CertiFried isn't in this guild anymore)
const [r] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [NEW_BOT_ID]);
const token = enc.decrypt(JSON.parse(r[0].bot_token));
const H = { Authorization: 'Bot ' + token };

let members = [], after = '0';
while (true) {
    const res = await fetch(`https://discord.com/api/v10/guilds/${GUILD}/members?limit=1000&after=${after}`, { headers: H });
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    members.push(...batch);
    after = batch[batch.length - 1].user.id;
    if (batch.length < 1000) break;
}
console.log(`fetched ${members.length} guild members`);

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const resolveDiscordUser = (needle) => {
    const n = norm(needle);
    return members.find(m =>
        norm(m.user.username) === n ||
        norm(m.user.global_name) === n ||
        norm(m.nick) === n
    ) || members.find(m =>
        norm(m.user.username).includes(n) ||
        norm(m.user.global_name || '').includes(n)
    );
};

for (const target of STREAMERS) {
    console.log(`\n--- ${target.twitchName} (twitch) / ${target.discordName} (discord) ---`);

    // 1) Resolve real Twitch user identity
    const identity = await resolveStreamerIdentity('twitch', target.twitchName);
    if (!identity) {
        console.log(`  ✗ Twitch user "${target.twitchName}" not found on Twitch Helix. SKIP`);
        continue;
    }
    console.log(`  Twitch: ${identity.canonicalUsername} (id ${identity.platformUserId})`);

    // 2) Resolve Discord user
    const dUser = resolveDiscordUser(target.discordName);
    if (!dUser) {
        console.log(`  ✗ Discord user "${target.discordName}" not found in guild — inserting without Discord link`);
    } else {
        console.log(`  Discord: ${dUser.user.username} (${dUser.user.id})`);
    }
    const discordUserId = dUser?.user?.id || null;

    // 3) Upsert streamer with real platform_user_id
    const streamerId = await upsertStreamerByIdentity(pool, 'twitch', identity, discordUserId);
    console.log(`  streamer_id: ${streamerId}`);

    // 4) Upsert subscription for this guild → #live-streams, unpaused, level-gate bypassed (admin add)
    const [existingSub] = await pool.execute(
        'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
        [GUILD, streamerId]
    );
    if (existingSub.length) {
        await pool.execute(
            'UPDATE subscriptions SET announcement_channel_id = ?, paused = 0 WHERE subscription_id = ?',
            [ANNOUNCE_CH, existingSub[0].subscription_id]
        );
        console.log(`  subscription updated (id ${existingSub[0].subscription_id}) → ${ANNOUNCE_CH}, unpaused`);
    } else {
        const [ins] = await pool.execute(
            'INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, paused) VALUES (?, ?, ?, 0)',
            [GUILD, streamerId, ANNOUNCE_CH]
        );
        console.log(`  subscription created (id ${ins.insertId}) → ${ANNOUNCE_CH}`);
    }
}

// Final snapshot for this guild
const [subs] = await pool.execute(`
    SELECT sub.subscription_id, sub.streamer_id, sub.paused, sub.announcement_channel_id,
           s.platform, s.username, s.platform_user_id, s.discord_user_id
    FROM subscriptions sub
    JOIN streamers s ON s.streamer_id = sub.streamer_id
    WHERE sub.guild_id = ?
    ORDER BY sub.subscription_id DESC`, [GUILD]);
console.log('\n== subscriptions for guild ==');
for (const row of subs) console.log(`  ${row.platform}:${row.username} (id ${row.platform_user_id}) → <#${row.announcement_channel_id}> paused=${row.paused} discord=${row.discord_user_id || '(none)'}`);

await pool.end();
