/**
 * Quick script to grant invite permission to Verified Growmie role
 */
import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';
const VERIFIED_GROWMIE_ROLE = '1452977925451153542';

const [bots] = await pool.execute(
    'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
    [BOT_ID]
);

const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

client.once('ready', async () => {
    console.log('Logged in as', client.user.tag);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
        console.log('Guild not found');
        client.destroy();
        await pool.end();
        process.exit(1);
    }

    const role = guild.roles.cache.get(VERIFIED_GROWMIE_ROLE);
    if (role && !role.permissions.has(PermissionFlagsBits.CreateInstantInvite)) {
        const newPerms = role.permissions.add(PermissionFlagsBits.CreateInstantInvite);
        await role.setPermissions(newPerms, 'Allowing verified users to create single-use invites');
        console.log('✅ Added invite permission to', role.name);
    } else if (role) {
        console.log('✅', role.name, 'already has invite permission');
    }

    client.destroy();
    await pool.end();
    process.exit(0);
});

await client.login(decryptedToken);
