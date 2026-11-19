import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import pool from './utils/db.js';
import encryption from './utils/encryption.js';
// Same builder as the automatic deploy: mounts (core/command-mounts.js) and only slash-registered
// commands (core/command-registration.js). Raw module JSON went over Discord's 100 cap.
import { buildDeployJson } from './core/command-mounts.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const commands = [];
const modules = [];
const skippedScoped = [];

/**
 * Load all command files and build command array
 */
async function loadCommands() {
    const commandsPath = join(__dirname, 'commands');

    if (!fs.existsSync(commandsPath)) {
        logger.warn('[Deploy] Commands directory does not exist');
        return;
    }

    const commandFolders = fs.readdirSync(commandsPath).filter(item => {
        return fs.statSync(join(commandsPath, item)).isDirectory();
    });

    for (const folder of commandFolders) {
        const folderPath = join(commandsPath, folder);
        const commandFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));

        for (const file of commandFiles) {
            try {
                const filePath = join(folderPath, file);
                const command = await import(`file://${filePath}`);

                // guildScoped commands are intentionally held back from both the main-bot global
                // payload and the per-guild deploys below. They're registered to opted-in guilds
                // only via scripts/deploy-guild-scoped-commands.js, which reads the opt-in list
                // from the guild_scoped_commands table. Without this filter, the bulk PUT below
                // would push them to every guild and trip Discord's 100-chat-input-per-guild cap.
                const marker = command.default?.guildScoped || command.guildScoped;
                if (marker) {
                    skippedScoped.push(command.default?.data?.name || command.data?.name || file);
                    continue;
                }

                const mod = command.default?.data ? command.default : (command.data ? command : null);
                if (mod) modules.push(mod);
            } catch (error) {
                logger.error(`[Deploy] Failed to load ${folder}/${file}`, { error: error.message });
            }
        }
    }

    commands.push(...buildDeployJson(modules));
    console.log(`Loaded ${modules.length} command modules, ${commands.length} to register`);
    if (skippedScoped.length) {
        console.log(`Held back ${skippedScoped.length} guild-scoped command(s) from the bulk payload: ${skippedScoped.join(', ')}`);
        console.log(`  (deploy those with: node scripts/deploy-guild-scoped-commands.js)`);
    }
}

/**
 * Deploy commands globally for the main bot
 */
async function deployGlobal(token, clientId, botName) {
    try {
        const rest = new REST().setToken(token);

        console.log(`\n[${botName}] Deploying ${commands.length} commands globally...`);

        const data = await rest.put(
            Routes.applicationCommands(clientId),
            { body: commands }
        );

        console.log(`[${botName}] Successfully deployed ${data.length} global commands`);
        return true;
    } catch (error) {
        console.log(`[${botName}] FAILED: ${error.message}`);
        return false;
    }
}

/**
 * Deploy commands to specific guilds for a custom bot
 */
async function deployToGuilds(token, clientId, botName, guildIds) {
    try {
        const rest = new REST().setToken(token);

        console.log(`\n[${botName}] Deploying ${commands.length} commands to ${guildIds.length} guild(s)...`);

        let successCount = 0;
        for (const guildId of guildIds) {
            try {
                const data = await rest.put(
                    Routes.applicationGuildCommands(clientId, guildId),
                    { body: commands }
                );
                console.log(`[${botName}]   Guild ${guildId}: ${data.length} commands`);
                successCount++;
            } catch (guildError) {
                console.log(`[${botName}]   Guild ${guildId}: FAILED - ${guildError.message}`);
            }
        }

        console.log(`[${botName}] Deployed to ${successCount}/${guildIds.length} guild(s)`);
        return successCount > 0;
    } catch (error) {
        console.log(`[${botName}] FAILED: ${error.message}`);
        return false;
    }
}

/**
 * Hide main bot commands in guilds that have custom bots
 */
async function hideMainBotInCustomGuilds(allCustomGuildIds) {
    if (allCustomGuildIds.length === 0) return;

    const mainToken = process.env.DISCORD_TOKEN;
    const mainClientId = process.env.DISCORD_CLIENT_ID;

    if (!mainToken || !mainClientId) return;

    const rest = new REST().setToken(mainToken);

    console.log(`\n--- HIDING MAIN BOT COMMANDS IN ${allCustomGuildIds.length} CUSTOM-BOT GUILD(S) ---`);

    for (const guildId of allCustomGuildIds) {
        try {
            await rest.put(
                Routes.applicationGuildCommands(mainClientId, guildId),
                { body: [] }
            );
            console.log(`  Guild ${guildId}: main bot commands hidden`);
        } catch (error) {
            console.log(`  Guild ${guildId}: FAILED to hide - ${error.message}`);
        }
    }
}

/**
 * Main deployment function
 */
async function deployAll() {
    console.log('='.repeat(60));
    console.log('DEPLOYING COMMANDS TO ALL BOTS');
    console.log('='.repeat(60));

    // Load commands first
    await loadCommands();

    let success = 0;
    let failed = 0;
    const allCustomGuildIds = [];

    // 1. Deploy to main bot (global)
    console.log('\n--- MAIN BOT ---');
    const mainResult = await deployGlobal(
        process.env.DISCORD_TOKEN,
        process.env.DISCORD_CLIENT_ID,
        'CertiFried Utility (Main)'
    );
    if (mainResult) success++; else failed++;

    // 2. Get all custom bots from database
    console.log('\n--- CUSTOM BOTS ---');
    try {
        const [customBots] = await pool.execute(
            'SELECT bot_id, bot_name, bot_token, client_id FROM custom_bots'
        );

        console.log(`Found ${customBots.length} custom bots`);

        for (const bot of customBots) {
            // Decrypt the bot token
            let decryptedToken = bot.bot_token;
            try {
                if (typeof bot.bot_token === 'string' && bot.bot_token.startsWith('{')) {
                    const tokenObj = JSON.parse(bot.bot_token);
                    decryptedToken = encryption.decrypt(tokenObj);
                }
            } catch (err) {
                console.log(`[${bot.bot_name}] Could not decrypt token`);
                failed++;
                continue;
            }

            // Use bot_id as the application ID (they're the same in Discord)
            const clientId = bot.client_id || bot.bot_id;

            // Get guild mappings for this bot
            const [mappings] = await pool.execute(
                'SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?',
                [bot.bot_id]
            );
            const guildIds = mappings.map(m => m.guild_id);

            let result;
            if (guildIds.length > 0) {
                // Deploy to specific guilds (matches bot-manager.js behavior)
                allCustomGuildIds.push(...guildIds);
                result = await deployToGuilds(decryptedToken, clientId, bot.bot_name, guildIds);
            } else {
                // No guild mappings - deploy globally as fallback
                result = await deployGlobal(decryptedToken, clientId, bot.bot_name);
            }

            if (result) success++; else failed++;

            // Small delay between deployments
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } catch (error) {
        console.log(`Error fetching custom bots: ${error.message}`);
    }

    // 3. Hide main bot commands in custom-bot guilds
    await hideMainBotInCustomGuilds(allCustomGuildIds);

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log(`DEPLOYMENT COMPLETE: ${success} success, ${failed} failed`);
    console.log('='.repeat(60));

    await pool.end();
    process.exit(0);
}

// Execute
deployAll().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
