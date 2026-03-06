import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const GUILD_ID = '985116833193553930';
const ROLE_ID = '1447019344281342153';
const NEW_COLOR = '#1591fd';

// Try with main bot first, then custom bots
const botTokens = [
    { name: 'Main', token: process.env.DISCORD_TOKEN },
    { name: 'FreshTok', token: process.env.FRESHTOK_BOT_TOKEN },
    { name: 'SlowmoGuard', token: process.env.SLOWMO_GUARD_BOT_TOKEN },
    { name: 'ModerationBot', token: process.env.MODERATION_BOT_TOKEN }
];

async function tryBot(name, token) {
    if (!token) return false;

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    return new Promise((resolve) => {
        client.once('ready', async () => {
            try {
                const guild = await client.guilds.fetch(GUILD_ID);
                const role = await guild.roles.fetch(ROLE_ID);

                if (!role) {
                    console.log(`${name}: Role not found`);
                    client.destroy();
                    resolve(false);
                    return;
                }

                console.log(`${name} bot has access!`);
                console.log(`Role name: ${role.name}`);
                console.log(`Current color: ${role.hexColor}`);

                await role.setColor(NEW_COLOR);
                console.log(`Role color updated to ${NEW_COLOR}`);

                client.destroy();
                resolve(true);
            } catch (err) {
                console.log(`${name}: ${err.message}`);
                client.destroy();
                resolve(false);
            }
        });

        client.login(token).catch(() => {
            console.log(`${name}: Login failed`);
            resolve(false);
        });
    });
}

async function main() {
    for (const bot of botTokens) {
        const success = await tryBot(bot.name, bot.token);
        if (success) {
            process.exit(0);
        }
    }
    console.log('No bot has access to update this role');
    process.exit(1);
}

main();
