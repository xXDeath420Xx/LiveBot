/*
 * One-off deploy of the "Report DM spam" USER context menu.
 *
 * Uses POST /applications/{id}/commands which adds (or updates by name) a single command without
 * touching the rest of the registry. We cannot use the normal PUT-based bulk deploy because the
 * chat-input registry is currently over Discord's 100-slot cap and PUT would reject the whole
 * batch. USER context menus live in their own 5-slot quota (0/5 used), so this slots in cleanly.
 *
 * Deploys globally to the main bot and to every custom bot. Custom bots are a separate Discord
 * application each with their own 5-slot context-menu quota, so each gets its own POST.
 */
import { REST, Routes, ApplicationCommandType } from 'discord.js';
import dotenv from 'dotenv';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

dotenv.config();

const commandBody = {
    name: 'Report DM spam',
    type: ApplicationCommandType.User,
    dm_permission: false,
};

async function deployOne(token, clientId, label) {
    try {
        const rest = new REST().setToken(token);
        const result = await rest.post(
            Routes.applicationCommands(clientId),
            { body: commandBody }
        );
        console.log(`[${label}] OK — command id=${result.id} name="${result.name}" type=${result.type}`);
        return true;
    } catch (e) {
        console.log(`[${label}] FAILED: ${e.message}`);
        return false;
    }
}

async function main() {
    let okCount = 0, failCount = 0;

    // Main bot (global).
    const mainToken = process.env.DISCORD_TOKEN;
    const mainClientId = process.env.DISCORD_CLIENT_ID;
    if (!mainToken || !mainClientId) {
        console.log('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in env — skipping main bot');
    } else {
        if (await deployOne(mainToken, mainClientId, 'MAIN BOT')) okCount++; else failCount++;
    }

    // Each custom bot (global for that bot).
    try {
        const [customBots] = await pool.query(
            'SELECT bot_id, bot_name, bot_token, client_id FROM custom_bots'
        );
        console.log(`\nFound ${customBots.length} custom bot(s).\n`);

        for (const bot of customBots) {
            let token = bot.bot_token;
            try {
                if (typeof bot.bot_token === 'string' && bot.bot_token.startsWith('{')) {
                    token = encryption.decrypt(JSON.parse(bot.bot_token));
                }
            } catch (err) {
                console.log(`[${bot.bot_name}] FAILED: could not decrypt token`);
                failCount++;
                continue;
            }
            const clientId = bot.client_id || bot.bot_id;
            if (await deployOne(token, clientId, bot.bot_name)) okCount++; else failCount++;
            await new Promise(r => setTimeout(r, 500));
        }
    } catch (e) {
        console.log('custom-bot sweep error:', e.message);
    }

    console.log(`\nDONE: ${okCount} ok, ${failCount} failed`);
    await pool.end();
    process.exit(failCount && !okCount ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
