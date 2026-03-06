import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '985116833193553930';
const BOT_APP_ID = '1438889625388060723';
const ROLE_TO_MOVE = '1447019344281342153';
const ROLE_TO_BE_ABOVE = '1347134428664827966';

async function main() {
    // Get bot token
    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE client_id = ?',
        [BOT_APP_ID]
    );

    if (!bots.length) {
        console.error('Bot not found in database');
        process.exit(1);
    }

    const encryptedToken = JSON.parse(bots[0].bot_token);
    const token = encryption.decrypt(encryptedToken);
    console.log('Token decrypted successfully');

    const client = new Client({
        intents: [GatewayIntentBits.Guilds]
    });

    client.once('ready', async () => {
        console.log(`Logged in as ${client.user.tag}`);

        try {
            const guild = await client.guilds.fetch(GUILD_ID);
            console.log(`Found guild: ${guild.name}`);

            const roleToMove = await guild.roles.fetch(ROLE_TO_MOVE);
            const roleToBeAbove = await guild.roles.fetch(ROLE_TO_BE_ABOVE);

            if (!roleToMove) {
                console.error(`Role ${ROLE_TO_MOVE} not found`);
                process.exit(1);
            }
            if (!roleToBeAbove) {
                console.error(`Role ${ROLE_TO_BE_ABOVE} not found`);
                process.exit(1);
            }

            console.log(`\nCurrent positions:`);
            console.log(`  ${roleToMove.name}: position ${roleToMove.position}`);
            console.log(`  ${roleToBeAbove.name}: position ${roleToBeAbove.position}`);

            // Move roleToMove to be above roleToBeAbove
            const newPosition = roleToBeAbove.position + 1;
            console.log(`\nMoving "${roleToMove.name}" to position ${newPosition} (above "${roleToBeAbove.name}")`);

            await roleToMove.setPosition(newPosition);

            // Fetch updated roles
            const updatedRole = await guild.roles.fetch(ROLE_TO_MOVE);
            const updatedOtherRole = await guild.roles.fetch(ROLE_TO_BE_ABOVE);

            console.log(`\n✅ Role positions updated:`);
            console.log(`  ${updatedRole.name}: position ${updatedRole.position}`);
            console.log(`  ${updatedOtherRole.name}: position ${updatedOtherRole.position}`);

        } catch (error) {
            console.error('Error:', error.message);
        }

        client.destroy();
        process.exit(0);
    });

    await client.login(token);
}

main().catch(console.error);
