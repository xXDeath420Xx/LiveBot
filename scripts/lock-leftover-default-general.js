import dotenv from 'dotenv'; dotenv.config();
import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1500965606659194982';
const BOT_ID = '1502798840124670133';
const VERIFIED = '1502814371502624858';
const TARGET_CH = '1500965607770816666'; // the default-Discord #general

const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const token = encryption.decrypt(JSON.parse(bots[0].bot_token));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(token);
await new Promise(r => client.once('ready', r));
const guild = await client.guilds.fetch(GUILD_ID);
await guild.channels.fetch();

let ch = guild.channels.cache.get(TARGET_CH);
if (!ch) {
    try { ch = await guild.channels.fetch(TARGET_CH, { force: true }); } catch (e) { console.error('Direct fetch failed:', e.message); }
}
if (!ch) {
    console.log('Channels matching "general":');
    for (const [, c] of guild.channels.cache) if (/general/i.test(c.name)) console.log(`  ${c.id} #${c.name} parent=${c.parentId}`);
    process.exit(1);
}
console.log(`Locking down: #${ch.name} (${ch.id})`);

await ch.permissionOverwrites.edit(guild.id, { ViewChannel: false }, { reason: 'Pre-verify lockdown — leftover default channel' });
await ch.permissionOverwrites.edit(VERIFIED, { ViewChannel: true }, { reason: 'Pre-verify lockdown — Verified unlocks' });
console.log('Locked.');

client.destroy();
await pool.end();
