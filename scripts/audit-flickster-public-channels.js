import dotenv from 'dotenv'; dotenv.config();
import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1500965606659194982';
const BOT_ID = '1502798840124670133';

const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const token = encryption.decrypt(JSON.parse(bots[0].bot_token));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(token);
await new Promise(r => client.once('ready', r));
const guild = await client.guilds.fetch(GUILD_ID);
await guild.channels.fetch();

const everyone = guild.roles.everyone;
const visibleToEveryone = [];
const hiddenFromEveryone = [];
for (const [, ch] of guild.channels.cache) {
    const perms = ch.permissionsFor(everyone);
    const canView = perms?.has(PermissionFlagsBits.ViewChannel);
    if (canView) visibleToEveryone.push(`  ${ch.type === ChannelType.GuildCategory ? '📁' : (ch.type === ChannelType.GuildVoice ? '🔊' : '#')} ${ch.name} (${ch.id})`);
    else hiddenFromEveryone.push(`  ${ch.type === ChannelType.GuildCategory ? '📁' : (ch.type === ChannelType.GuildVoice ? '🔊' : '#')} ${ch.name}`);
}
console.log(`UNVERIFIED user (no Verified role) can SEE ${visibleToEveryone.length} channel(s):`);
visibleToEveryone.forEach(l => console.log(l));
console.log(`\nGated from unverified: ${hiddenFromEveryone.length} channels`);

client.destroy();
await pool.end();
