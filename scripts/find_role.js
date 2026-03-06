import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const ROLE_ID = '1447019344281342153';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
    console.log(`Searching for role ID: ${ROLE_ID} across all guilds...`);

    for (const [guildId, guild] of client.guilds.cache) {
        try {
            // Fetch all roles
            const roles = await guild.roles.fetch();
            const role = roles.get(ROLE_ID);

            if (role) {
                console.log(`\nFOUND in guild: ${guild.name} (${guildId})`);
                console.log(`  Role name: ${role.name}`);
                console.log(`  Current color: ${role.hexColor}`);
            }
        } catch (e) {
            console.log(`Could not check ${guild.name}: ${e.message}`);
        }
    }

    console.log('\nSearch complete.');
    client.destroy();
    process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
