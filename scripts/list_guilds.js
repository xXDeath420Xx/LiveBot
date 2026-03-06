import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const GUILD_ID = '985116833193553930';

const botTokens = [
    { name: 'Main', token: process.env.DISCORD_TOKEN },
    { name: 'FreshTok', token: process.env.FRESHTOK_BOT_TOKEN },
    { name: 'SlowmoGuard', token: process.env.SLOWMO_GUARD_BOT_TOKEN },
    { name: 'ModerationBot', token: process.env.MODERATION_BOT_TOKEN }
];

async function checkBot(name, token) {
    if (!token) {
        console.log(`${name}: No token`);
        return;
    }

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    return new Promise((resolve) => {
        client.once('ready', async () => {
            console.log(`\n${name} bot guilds:`);
            for (const [id, guild] of client.guilds.cache) {
                console.log(`  ${id} - ${guild.name}`);
                if (id === GUILD_ID) {
                    console.log(`  ^^^ TARGET GUILD FOUND!`);
                }
            }
            client.destroy();
            resolve();
        });

        client.login(token).catch((e) => {
            console.log(`${name}: Login failed - ${e.message}`);
            resolve();
        });
    });
}

async function main() {
    console.log(`Looking for guild: ${GUILD_ID}`);
    for (const bot of botTokens) {
        await checkBot(bot.name, bot.token);
    }
    process.exit(0);
}

main();
