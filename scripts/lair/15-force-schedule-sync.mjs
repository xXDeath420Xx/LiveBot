// Force the mamabear_xal Twitch schedule sync to run immediately (skip cooldown).
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import mysql from 'mysql2/promise';
import TwitchScheduleManager from '/home/death/CertiFriedUtility/core/twitch-schedule-manager.js';

const GUILD = '1216126780767731722';

const pool = mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
// Tiny client just for channels.fetch
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.isDefaultBot = true;
await client.login(process.env.DISCORD_TOKEN);
await new Promise(r => client.once('ready', r));
console.log('logged in as', client.user.tag);

const mgr = new TwitchScheduleManager(client);
const [rows] = await pool.execute(`
    SELECT tss.*, s.platform_user_id, s.username, s.profile_image_url
    FROM twitch_schedule_sync_config tss
    JOIN streamers s ON s.streamer_id = tss.streamer_id
    WHERE tss.guild_id = ? AND LOWER(s.username) = 'mamabear_xal'
`, [GUILD]);
if (!rows.length) { console.log('no sync config for mamabear_xal'); process.exit(1); }

console.log('running syncSchedule() with skipCooldown=true for sync', rows[0].id);
await mgr.syncSchedule(rows[0], { skipCooldown: true });
console.log('done');
await client.destroy();
await pool.end();
