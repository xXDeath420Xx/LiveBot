import dotenv from 'dotenv';
dotenv.config();
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import mysql from 'mysql2/promise';
const { default: encryption } = await import('../utils/encryption.js');

const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', ['1486807000854823155']);
const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
await client.login(token);
await new Promise(r => client.once('ready', r));

const ch = await client.channels.fetch('1485705052260663446');

// Delete the wrong plain text message
const msgs = await ch.messages.fetch({ limit: 10 });
for (const [, m] of msgs) {
    if (m.author.id === client.user.id) {
        await m.unpin().catch(() => {});
        await m.delete().catch(() => {});
        console.log('Deleted: ' + m.id);
    }
}

// Post the EXACT embed matching the Kateooo_ original
// Color 6118749 = #5D5CDD
const embed = new EmbedBuilder()
    .setTitle('\u{1D41D}\u{1D42B}\u{1D428}\u{1D426}\u{1D428}') // 𝐩𝐫𝐨𝐦𝐨
    .setColor(6118749)
    .setDescription(
        "The self promo channel is a dedicated space for sharing your Twitch stream link while you\u2019re live, giving everyone in the community a fair chance to be seen and supported.\n\n" +
        "Posts are purged at <t:1774569600:t> daily to keep things current, and keeping it to live links only ensures the focus stays on what\u2019s happening right now.\n\n" +
        "A space like this matters because every voice deserves room to be heard, and it will never be placed behind a subscription paywall."
    );

const msg = await ch.send({ embeds: [embed] });
await msg.pin();
console.log('Posted and pinned: ' + msg.id);

// Clean pin system message
const sysMsgs = await ch.messages.fetch({ limit: 5 });
for (const [, m] of sysMsgs) {
    if (m.type === 6) await m.delete().catch(() => {});
}

const pins = await ch.messages.fetchPinned();
console.log('Pinned: ' + pins.has(msg.id));

client.destroy();
await pool.end();
