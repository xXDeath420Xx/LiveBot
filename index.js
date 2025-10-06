const { Client, GatewayIntentBits, Collection, Events, Partials } = require('discord.js');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const logger = require('./utils/logger');
const db = require('./utils/db');
const apiChecks = require('./utils/api_checks.js');
const dashboard = require(path.join(__dirname, 'dashboard', 'server.js'));
const { handleInteraction } = require('./core/interaction-handler');
const { handleMessageXP } = require('./core/xp-manager');
const { handleReactionAdd: handleReactionRole, handleReactionRemove } = require('./core/reaction-role-manager');
const { handleReactionAdd: handleStarboard } = require('./core/starboard-manager');
const automod = require('./core/automod');
const antiNuke = require('./core/anti-nuke');
const joinGate = require('./core/join-gate');
const inviteManager = require('./core/invite-manager');
const { handleGuildMemberAdd, handleGuildMemberRemove } = require('./core/greeting-manager'); // Changed import
const { handleNewMessage: handleAutoPublish } = require('./core/auto-publisher');
const { handleNewMember: handleAutorole } = require('./core/autorole-manager');
const logManager = require('./core/log-manager');
const { checkRedditFeeds } = require('./core/reddit-feed');
const { checkTwitterFeeds } = require('./core/twitter-feed');
const { handleMemberJoin: handleAntiRaid } = require('./core/anti-raid');
const { incrementMessageCount } = require('./core/stats-manager'); // Add this
const { checkGiveaways } = require('./core/giveaway-manager');
const { checkPolls } = require('./core/poll-manager');
const { saveUserRoles, restoreUserRoles } = require('./core/sticky-roles-manager');
const { handleVoiceStateUpdate } = require('./core/temp-channel-manager');
const { checkAfkStatus } = require('./core/afk-manager');

const { DisTube } = require('distube');
const { SoundCloudPlugin } = require('@distube/soundcloud');
const { SpotifyPlugin } = require('@distube/spotify');
const { YtDlpPlugin } = require('@distube/yt-dlp');

async function main() {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildModeration,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.GuildInvites,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.GuildVoiceStates, // This should already be present from the music player
        ],
        partials: [Partials.User, Partials.GuildMember, Partials.Channel, Partials.Message, Partials.Reaction]
    });

    client.commands = new Collection();
    const commandsPath = path.join(__dirname, 'commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
    for (const file of commandFiles) {
        try {
            const command = require(path.join(commandsPath, file));
            if (command.data && command.execute) {
                client.commands.set(command.data.name, command);
            }
        } catch (e) {
            logger.error(`[CMD Load Error] ${file}:`, e);
        }
    }
    logger.info(`[Startup] ${client.commands.size} commands loaded.`);

    client.buttons = new Collection();
    client.modals = new Collection();
    client.selects = new Collection();
    const interactionsPath = path.join(__dirname, 'interactions');
    for (const folder of fs.readdirSync(interactionsPath)) {
        const fullPath = path.join(interactionsPath, folder);
        if (fs.statSync(fullPath).isDirectory()) {
            const componentFiles = fs.readdirSync(fullPath).filter(f => f.endsWith('.js'));
            for (const file of componentFiles) {
                try {
                    const component = require(path.join(fullPath, file));
                    if (component.customId && component.execute) {
                        if (folder === 'buttons') client.buttons.set(component.customId, component);
                        else if (folder === 'modals') client.modals.set(component.customId, component);
                        else if (folder === 'selects') client.selects.set(component.customId, component);
                    }
                } catch (e) {
                     logger.error(`[Component Load Error] ${file}:`, e);
                }
            }
        }
    }
    logger.info(`[Startup] ${client.buttons.size} buttons, ${client.modals.size} modals, and ${client.selects.size} select menus loaded.`);

    client.on(Events.InteractionCreate, handleInteraction);
    client.on(Events.MessageCreate, async (message) => {
        if (message.author.bot || !message.guild) return;
        
        // The AFK check should run for every message
        await checkAfkStatus(message);

        await incrementMessageCount(message.guild.id); // ADD THIS LINE
        await handleMessageXP(message);
        await automod.processMessage(message);
        await handleAutoPublish(message);
    });
    client.on(Events.MessageReactionAdd, async (reaction, user) => {
        if (user.bot) return;
        await handleReactionRole(reaction, user);
        await handleStarboard(reaction, user);
    });
    client.on(Events.MessageReactionRemove, handleReactionRemove);
    client.on(Events.GuildAuditLogEntryCreate, antiNuke.processAuditLog);
    client.on(Events.GuildMemberAdd, async (member) => {
        await handleAntiRaid(member); // Add this. It should run BEFORE other join handlers.
        await joinGate.processNewMember(member);
        await inviteManager.handleGuildMemberAdd(member);
        await handleGuildMemberAdd(member); // Changed function name
        await restoreUserRoles(member); // ADD THIS LINE
        await handleAutorole(member); // ADD THIS LINE
    });
    client.on(Events.GuildMemberRemove, async (member) => { // Modified to async
        await inviteManager.handleGuildMemberRemove(member);
        await handleGuildMemberRemove(member); // ADD THIS LINE
        await saveUserRoles(member); // ADD THIS LINE
    });
    client.on(Events.InviteCreate, async (invite) => await inviteManager.cacheInvites(invite.guild));
    client.on(Events.InviteDelete, (invite) => inviteManager.guildInvites.get(invite.guild.id)?.delete(invite.code));
    client.on(Events.MessageDelete, logManager.logMessageDelete);
    client.on(Events.MessageUpdate, logManager.logMessageUpdate);
    client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
        logManager.logMemberRoleUpdate(oldMember, newMember);
        logManager.logMemberNicknameUpdate(oldMember, newMember);
    });
    client.on(Events.ChannelCreate, logManager.logChannelCreate);
    client.on(Events.ChannelDelete, logManager.logChannelDelete);
    client.on(Events.RoleCreate, logManager.logRoleCreate);
    client.on(Events.RoleDelete, logManager.logRoleDelete);
    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
        handleVoiceStateUpdate(oldState, newState); // from temp-channel-manager
        logManager.logVoiceStateUpdate(oldState, newState); // Add this line
    });

    client.distube = new DisTube(client, {
      leaveOnStop: false,
      emitNewSongOnly: true,
      emitAddSongWhenCreatingQueue: false,
      emitAddListWhenCreatingQueue: false,
      plugins: [
        new SoundCloudPlugin(),
        new SpotifyPlugin({
          parallel: true,
          emitEventsAfterFetching: true,
          api: {
            clientId: 'f38eed1a1d50412c9a8acf3fcc15793f',
            clientSecret: 'ae269626c4ba4f038c230273e0ac3fc5',
          },
        }),
        new YtDlpPlugin()
      ]
    });

    client.once(Events.ClientReady, async c => {
        global.client = c;
        logger.info(`[READY] Logged in as ${c.user.tag}`);
        
        // ... (existing ready event code)

        // Start the Reddit feed checker
        setInterval(checkRedditFeeds, 5 * 60 * 1000); // Check every 5 minutes
        logger.info('[Startup] Reddit feed checker started.');

        // Start the Twitter checker
        setInterval(checkTwitterFeeds, 10 * 60 * 1000); // Check every 10 minutes
        logger.info('[Startup] Feed checkers (Reddit, YouTube, Twitter) started.');

        // Start the Giveaway checker
        setInterval(checkGiveaways, 15 * 1000); // Check every 15 seconds
        logger.info('[Startup] Giveaway checker started.');

        // Start the Poll checker
        setInterval(checkPolls, 30 * 1000); // Check every 30 seconds
        logger.info('[Startup] Poll checker started.');

        try {
            await apiChecks.getCycleTLSInstance();
            dashboard.start(client);
            logger.info('[Startup] Background jobs are managed by BullMQ workers.');
        }
        catch (e) {
            logger.error('[ClientReady Error]', e);
        }
    });

    await client.login(process.env.DISCORD_TOKEN);
}

const cleanup = async () => {
    logger.warn('[Shutdown] Received shutdown signal. Shutting down gracefully...');
    await apiChecks.exitCycleTLSInstance();
    await db.end();
    process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

main().catch(e => logger.error('[CRITICAL] Unhandled error in main function:', e));