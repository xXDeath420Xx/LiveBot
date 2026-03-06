import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '985116833193553930';
const BOT_APP_ID = '1438889625388060723';

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
            const botMember = await guild.members.fetch(client.user.id);
            const botHighestRole = botMember.roles.highest;

            console.log(`\nBot's highest role: "${botHighestRole.name}" (position: ${botHighestRole.position})`);
            console.log(`Bot has ADMINISTRATOR: ${botMember.permissions.has('Administrator')}`);
            console.log(`Bot has MANAGE_ROLES: ${botMember.permissions.has('ManageRoles')}`);

            console.log(`\n--- All roles (sorted by position, highest first) ---`);
            const roles = guild.roles.cache.sort((a, b) => b.position - a.position);
            roles.forEach(role => {
                const marker = role.id === '1447019344281342153' ? ' <-- ROLE TO MOVE' :
                              role.id === '1347134428664827966' ? ' <-- ROLE TO BE ABOVE' :
                              role.id === botHighestRole.id ? ' <-- BOT\'S HIGHEST ROLE' : '';
                console.log(`  [${role.position}] ${role.name} (${role.id})${marker}`);
            });

        } catch (error) {
            console.error('Error:', error);
        }

        client.destroy();
        process.exit(0);
    });

    await client.login(token);
}

main().catch(console.error);
