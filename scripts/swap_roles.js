import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '985116833193553930';
const BOT_APP_ID = '1438889625388060723';
const ROLE_TO_MOVE = '1447019344281342153';      // Bot Developer (currently 25)
const ROLE_TO_BE_BELOW = '1347134428664827966';  // Administration (currently 26)

async function main() {
    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE client_id = ?',
        [BOT_APP_ID]
    );

    const encryptedToken = JSON.parse(bots[0].bot_token);
    const token = encryption.decrypt(encryptedToken);

    const client = new Client({
        intents: [GatewayIntentBits.Guilds]
    });

    client.once('ready', async () => {
        console.log(`Logged in as ${client.user.tag}`);

        try {
            const guild = await client.guilds.fetch(GUILD_ID);

            const roleToMove = await guild.roles.fetch(ROLE_TO_MOVE);
            const roleToBeBelow = await guild.roles.fetch(ROLE_TO_BE_BELOW);

            console.log(`\nBefore:`);
            console.log(`  ${roleToMove.name}: position ${roleToMove.position}`);
            console.log(`  ${roleToBeBelow.name}: position ${roleToBeBelow.position}`);

            // Swap positions - Bot Developer goes to 26, Administration goes to 25
            await guild.roles.setPositions([
                { role: ROLE_TO_MOVE, position: 26 },
                { role: ROLE_TO_BE_BELOW, position: 25 }
            ]);

            // Fetch updated
            const updated1 = await guild.roles.fetch(ROLE_TO_MOVE);
            const updated2 = await guild.roles.fetch(ROLE_TO_BE_BELOW);

            console.log(`\n✅ After:`);
            console.log(`  ${updated1.name}: position ${updated1.position}`);
            console.log(`  ${updated2.name}: position ${updated2.position}`);

        } catch (error) {
            console.error('Error:', error.message);
            if (error.rawError) console.error('Raw error:', error.rawError);
        }

        client.destroy();
        process.exit(0);
    });

    await client.login(token);
}

main().catch(console.error);
