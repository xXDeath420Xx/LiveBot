import dotenv from 'dotenv'; dotenv.config();
import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } from 'discord.js';
import pool from '../utils/db.js';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const GUILD_ID = '1500965606659194982';
// The acting bot comes from guild_bot_mapping — never pinned here.

const bot = await resolveBotForGuild(GUILD_ID, { db: pool });
const token = bot.token;
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
