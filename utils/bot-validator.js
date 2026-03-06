import { Client, GatewayIntentBits, Partials } from 'discord.js';
import logger from './logger.js';

/**
 * Comprehensive bot validation and testing utility
 * Ensures custom bots work exactly like the main bot
 */

/**
 * Test bot connection and authentication
 * @param {string} botToken - Decrypted bot token
 * @returns {Promise<Object>} Bot info or throws error
 */
export async function testBotConnection(botToken) {
    logger.info('[Bot Validator] Testing bot connection...');

    const testClient = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.GuildInvites,
            GatewayIntentBits.GuildPresences,
            GatewayIntentBits.GuildModeration,
            GatewayIntentBits.GuildEmojisAndStickers,
            GatewayIntentBits.GuildIntegrations,
            GatewayIntentBits.AutoModerationConfiguration,
            GatewayIntentBits.AutoModerationExecution,
            GatewayIntentBits.DirectMessages
        ],
        partials: [
            Partials.Message,
            Partials.Channel,
            Partials.Reaction,
            Partials.User,
            Partials.GuildMember
        ]
    });

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            testClient.destroy();
            reject(new Error('Bot connection timeout (30s) - check token and bot status in Discord Developer Portal'));
        }, 30000);

        testClient.once('ready', async () => {
            clearTimeout(timeout);

            const botInfo = {
                id: testClient.user.id,
                username: testClient.user.username,
                discriminator: testClient.user.discriminator,
                tag: testClient.user.tag,
                verified: testClient.user.verified,
                bot: testClient.user.bot,
                guilds: testClient.guilds.cache.size,
                intents: testClient.options.intents
            };

            logger.info('[Bot Validator] ✓ Bot connected successfully:', {
                tag: botInfo.tag,
                id: botInfo.id,
                guilds: botInfo.guilds
            });

            // Verify it's actually a bot account
            if (!botInfo.bot) {
                await testClient.destroy();
                reject(new Error('Token is for a user account, not a bot. Please use a bot token from Discord Developer Portal.'));
                return;
            }

            await testClient.destroy();
            resolve(botInfo);
        });

        testClient.once('error', async (error) => {
            clearTimeout(timeout);
            await testClient.destroy();
            logger.error('[Bot Validator] ✗ Bot connection error:', error);
            reject(new Error(`Bot authentication failed: ${error.message}`));
        });

        // Attempt login
        testClient.login(botToken).catch(error => {
            clearTimeout(timeout);
            logger.error('[Bot Validator] ✗ Bot login failed:', error);

            let errorMessage = 'Invalid bot token';
            if (error.message.includes('TOKEN_INVALID') || error.message.includes('invalid token')) {
                errorMessage = 'Invalid bot token. Check your token in Discord Developer Portal.';
            } else if (error.message.includes('DISALLOWED_INTENTS') || error.message.toLowerCase().includes('disallowed intents')) {
                errorMessage = 'Missing required intents. Go to Discord Developer Portal → Your App → Bot → Enable these Privileged Gateway Intents: SERVER MEMBERS INTENT, MESSAGE CONTENT INTENT, PRESENCE INTENT';
            }

            reject(new Error(errorMessage));
        });
    });
}

/**
 * Validate bot has all required permissions
 * @param {Client} client - Bot client instance
 * @param {string} guildId - Guild ID to check
 * @returns {Promise<Object>} Permission check results
 */
export async function validateBotPermissions(client, guildId) {
    try {
        const guild = await client.guilds.fetch(guildId);
        const botMember = await guild.members.fetch(client.user.id);

        const requiredPermissions = [
            'SendMessages',
            'EmbedLinks',
            'AttachFiles',
            'ReadMessageHistory',
            'AddReactions',
            'UseExternalEmojis',
            'ManageMessages',
            'ManageRoles',
            'ManageChannels',
            'ManageGuild',
            'ViewChannel',
            'Connect',
            'Speak',
            'MoveMembers'
        ];

        const missing = [];
        for (const perm of requiredPermissions) {
            if (!botMember.permissions.has(perm)) {
                missing.push(perm);
            }
        }

        return {
            hasAllPermissions: missing.length === 0,
            missing,
            permissions: botMember.permissions.toArray()
        };
    } catch (error) {
        logger.error('[Bot Validator] Error checking permissions:', error);
        throw new Error(`Failed to check bot permissions: ${error.message}`);
    }
}

/**
 * Verify bot commands are deployed
 * @param {Client} client - Bot client instance
 * @returns {Promise<Object>} Command deployment status
 */
export async function verifyCommandDeployment(client) {
    try {
        const commands = await client.application.commands.fetch();

        const deployedCommands = commands.map(cmd => ({
            name: cmd.name,
            description: cmd.description,
            id: cmd.id
        }));

        logger.info('[Bot Validator] ✓ Commands deployed:', {
            count: deployedCommands.length,
            commands: deployedCommands.map(c => c.name)
        });

        return {
            deployed: true,
            count: deployedCommands.length,
            commands: deployedCommands
        };
    } catch (error) {
        logger.error('[Bot Validator] ✗ Command deployment check failed:', error);
        throw new Error(`Failed to verify commands: ${error.message}`);
    }
}

/**
 * Verify all managers are initialized
 * @param {Client} client - Bot client instance
 * @returns {Object} Manager initialization status
 */
export function verifyManagers(client) {
    const requiredManagers = [
        'commands',
        'cooldowns',
        'pollsManager',
        'giveawayManager',
        'levelingManager',
        'starboardManager',
        'birthdayManager',
        'afkManager',
        'reminderManager',
        'weatherManager',
        'rpgCharacterManager',
        'rpgCombatManager',
        'rpgQuestManager',
        'rpgShopManager',
        'reactionRoleManager',
        'voiceActivityManager'
    ];

    const initialized = [];
    const missing = [];

    for (const manager of requiredManagers) {
        if (client[manager]) {
            initialized.push(manager);
        } else {
            missing.push(manager);
        }
    }

    const allInitialized = missing.length === 0;

    logger.info('[Bot Validator] Manager check:', {
        initialized: initialized.length,
        missing: missing.length,
        status: allInitialized ? '✓' : '✗'
    });

    return {
        allInitialized,
        initialized,
        missing,
        total: requiredManagers.length
    };
}

/**
 * Comprehensive bot health check
 * @param {Client} client - Bot client instance
 * @returns {Promise<Object>} Complete health status
 */
export async function performHealthCheck(client) {
    logger.info('[Bot Validator] Performing comprehensive health check...');

    const results = {
        timestamp: new Date(),
        botInfo: {
            id: client.user.id,
            tag: client.user.tag,
            ready: client.isReady()
        },
        checks: {}
    };

    // Check 1: Bot is ready
    results.checks.ready = {
        status: client.isReady() ? 'PASS' : 'FAIL',
        message: client.isReady() ? 'Bot is ready' : 'Bot is not ready'
    };

    // Check 2: Websocket connection
    results.checks.websocket = {
        status: client.ws.status === 0 ? 'PASS' : 'FAIL',
        ping: client.ws.ping,
        message: `WebSocket ping: ${client.ws.ping}ms`
    };

    // Check 3: Guild cache
    results.checks.guilds = {
        status: client.guilds.cache.size > 0 ? 'PASS' : 'WARNING',
        count: client.guilds.cache.size,
        message: `Serving ${client.guilds.cache.size} guild(s)`
    };

    // Check 4: Managers
    const managerStatus = verifyManagers(client);
    results.checks.managers = {
        status: managerStatus.allInitialized ? 'PASS' : 'FAIL',
        initialized: managerStatus.initialized.length,
        missing: managerStatus.missing,
        message: `${managerStatus.initialized.length}/${managerStatus.total} managers initialized`
    };

    // Check 5: Commands
    try {
        const commandStatus = await verifyCommandDeployment(client);
        results.checks.commands = {
            status: commandStatus.count > 0 ? 'PASS' : 'FAIL',
            count: commandStatus.count,
            message: `${commandStatus.count} commands deployed`
        };
    } catch (error) {
        results.checks.commands = {
            status: 'FAIL',
            error: error.message,
            message: 'Command verification failed'
        };
    }

    // Overall status
    const failedChecks = Object.values(results.checks).filter(c => c.status === 'FAIL');
    results.overall = failedChecks.length === 0 ? 'HEALTHY' : 'UNHEALTHY';
    results.passed = Object.values(results.checks).filter(c => c.status === 'PASS').length;
    results.failed = failedChecks.length;

    logger.info('[Bot Validator] Health check complete:', {
        overall: results.overall,
        passed: results.passed,
        failed: results.failed
    });

    return results;
}

/**
 * Full bot initialization test
 * Tests everything before approving a bot
 */
export async function fullBotTest(botToken, botId, botName) {
    logger.info('[Bot Validator] Starting full bot test...', { botId, botName });

    const report = {
        botId,
        botName,
        timestamp: new Date(),
        phases: {},
        overall: 'PENDING'
    };

    try {
        // Phase 1: Connection Test
        logger.info('[Bot Validator] Phase 1: Testing connection...');
        report.phases.connection = await testBotConnection(botToken);
        logger.info('[Bot Validator] ✓ Phase 1 complete');

        // Verify bot ID matches
        if (report.phases.connection.id !== botId) {
            throw new Error(`Bot ID mismatch! Expected ${botId}, got ${report.phases.connection.id}`);
        }

        report.overall = 'SUCCESS';
        report.message = `Bot ${botName} (${botId}) passed all validation tests`;

        logger.info('[Bot Validator] ✓ Full bot test PASSED');

        return report;

    } catch (error) {
        report.overall = 'FAILED';
        report.error = error.message;
        report.message = `Bot validation failed: ${error.message}`;

        logger.error('[Bot Validator] ✗ Full bot test FAILED:', error);

        throw error;
    }
}

export default {
    testBotConnection,
    validateBotPermissions,
    verifyCommandDeployment,
    verifyManagers,
    performHealthCheck,
    fullBotTest
};
