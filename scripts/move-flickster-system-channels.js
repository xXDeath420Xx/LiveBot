import dotenv from 'dotenv'; dotenv.config();
import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1500965606659194982';
const BOT_ID = '1502798840124670133';
const VERIFIED = '1502814371502624858';

const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const token = encryption.decrypt(JSON.parse(bots[0].bot_token));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(token);
await new Promise(r => client.once('ready', r));
const guild = await client.guilds.fetch(GUILD_ID);
await guild.channels.fetch();

console.log('Before:');
console.log('  systemChannelId:        ', guild.systemChannelId);
console.log('  rulesChannelId:         ', guild.rulesChannelId);
console.log('  publicUpdatesChannelId: ', guild.publicUpdatesChannelId);

const rulesCh    = guild.channels.cache.find(c => c.name === 'rules');
const modLogsCh  = guild.channels.cache.find(c => c.name === 'mod-logs');
const announceCh = guild.channels.cache.find(c => c.name === 'announcements');

await guild.edit({
    systemChannel:        announceCh?.id || null, // boost/join system messages → #announcements (Verified-only)
    publicUpdatesChannel: modLogsCh?.id || null,  // community update notices → #mod-logs (staff-only)
    rulesChannel:         rulesCh?.id || null,    // rules-screening feature → #rules
}, 'Move system channels off public slots so #general/#mod-chat can be gated');

console.log('Reassigned. Now locking the previously-pinned channels...');

const general = guild.channels.cache.find(c => c.name === 'general');
const modChat = guild.channels.cache.find(c => c.name === 'mod-chat');
for (const ch of [general, modChat]) {
    if (!ch) continue;
    await ch.permissionOverwrites.edit(guild.id, { ViewChannel: false }, { reason: 'Pre-verify lockdown' });
    await ch.permissionOverwrites.edit(VERIFIED, { ViewChannel: true }, { reason: 'Pre-verify lockdown: Verified unlocks' });
    console.log(`  + locked #${ch.name} (${ch.id})`);
}

const refreshed = await client.guilds.fetch(GUILD_ID);
console.log('After:');
console.log('  systemChannelId:        ', refreshed.systemChannelId);
console.log('  rulesChannelId:         ', refreshed.rulesChannelId);
console.log('  publicUpdatesChannelId: ', refreshed.publicUpdatesChannelId);

client.destroy();
await pool.end();
