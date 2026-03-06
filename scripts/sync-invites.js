/**
 * Sync existing invites to database for tracking
 */
import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

const [bots] = await pool.execute(
    'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
    [BOT_ID]
);

const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildInvites]
});

client.once('ready', async () => {
    console.log('Syncing invites to database...');

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
        console.log('Guild not found');
        client.destroy();
        await pool.end();
        process.exit(1);
    }

    const invites = await guild.invites.fetch();
    console.log('Found', invites.size, 'invites');

    for (const [code, invite] of invites) {
        await pool.execute(
            `INSERT INTO invite_tracking (guild_id, invite_code, inviter_id, uses, created_at)
             VALUES (?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE uses = ?, inviter_id = ?`,
            [GUILD_ID, code, invite.inviter?.id || 'unknown', invite.uses || 0, invite.uses || 0, invite.inviter?.id || 'unknown']
        );
        console.log('  Synced:', code, '- uses:', invite.uses, '- by:', invite.inviter?.tag || 'unknown');
    }

    console.log('Done!');
    client.destroy();
    await pool.end();
    process.exit(0);
});

await client.login(decryptedToken);
