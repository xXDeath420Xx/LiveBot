import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
import fs from 'fs';

const TARGET_BOT_ID = '1438889625388060723';

const envFiles = [
    '/root/discord_bots/CertiFriedUtility/.env',
    '/root/discord_bots/CannaDiscord/.env',
    '/root/discord_bots/Cannafriend/.env',
    '/root/discord_bots/ParkControl/.env',
    '/root/discord_bots/Canna/.env'
];

async function checkToken(token, source) {
    if (!token || token.length < 50) return false;

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            client.destroy();
            resolve(false);
        }, 10000);

        client.once('ready', () => {
            clearTimeout(timeout);
            console.log(`Token from ${source}: Bot ID = ${client.user.id}`);
            if (client.user.id === TARGET_BOT_ID) {
                console.log(`\n*** FOUND TARGET BOT! Token is from: ${source} ***`);
                console.log(`Bot name: ${client.user.tag}`);
            }
            client.destroy();
            resolve(client.user.id === TARGET_BOT_ID);
        });

        client.login(token).catch(() => {
            clearTimeout(timeout);
            resolve(false);
        });
    });
}

async function main() {
    console.log(`Searching for bot ID: ${TARGET_BOT_ID}\n`);

    for (const envFile of envFiles) {
        if (!fs.existsSync(envFile)) continue;

        const config = dotenv.parse(fs.readFileSync(envFile));

        for (const [key, value] of Object.entries(config)) {
            if (key.toLowerCase().includes('token') && key.toLowerCase().includes('discord') || key === 'DISCORD_TOKEN' || key === 'BOT_TOKEN') {
                const found = await checkToken(value, `${envFile} -> ${key}`);
                if (found) process.exit(0);
            }
        }
    }

    console.log('\nTarget bot not found in any checked env files.');
    process.exit(1);
}

main();
