import express from 'express';
import { apiCheckAuth, apiCheckGuildAdmin } from '../../middleware/auth.js';
import { botContext, switchBotContext } from '../../middleware/botContext.js';

// Feature APIs
import moderationRoutes from './features/moderation.js';
import automodRoutes from './features/automod.js';
import levelingRoutes from './features/leveling.js';
import economyRoutes from './features/economy.js';
import ticketsRoutes from './features/tickets.js';
import welcomeRoutes from './features/welcome.js';
import streamingRoutes from './features/streaming.js';
import reactionRolesRoutes from './features/reactionRoles.js';
import starboardRoutes from './features/starboard.js';
import securityRoutes from './features/security.js';
import loggingRoutes from './features/logging.js';
import giveawaysRoutes from './features/giveaways.js';
import pollsRoutes from './features/polls.js';
import suggestionsRoutes from './features/suggestions.js';
import coreRoutes from './features/core.js';
import rankcardRoutes from './features/rankcard.js';
import commandsRoutes from './features/commands.js';
import phishingRoutes from './features/phishing.js';
import freeGamesRoutes from './features/free-games.js';
import prefixCommandsRoutes from './features/prefix-commands.js';
import customBotRoutes from './features/custom-bot.js';
import emojiManagerRoutes from './features/emoji-manager.js';
import todoRoutes from './features/todo.js';
import globalBanRoutes from '../features/global-ban.js';
import autoresponderRoutes from './features/autoresponders.js';
import throneRoutes from './features/throne.js';
import serverTransferRoutes from './features/server-transfer.js';
import twitchSchedulesRoutes from './features/twitch-schedules.js';
import inviteFilterRoutes from './features/invite-filter.js';
import feedsRoutes from './features/feeds.js';
import owoRoutes from './features/owo.js';
import fourthwallRoutes from './features/fourthwall.js';

// User-scoped APIs (req.user only — NOT guild-scoped)
import meBuyMeACoffeeRoutes from './me/buymeacoffee.js';
import meStreamTeamRoutes from './me/stream-team.js';

// PUBLIC APIs (NO login required — mounted before apiCheckAuth below)
import publicStreamTeamRoutes from '../public/stream-team.js';

const router = express.Router();

// PUBLIC routes — mounted BEFORE the global apiCheckAuth so they're reachable
// without a Discord login. Optional auth via `if (req.user)` inside the router.
router.use('/public/stream-team', publicStreamTeamRoutes);

// Apply auth to all API routes
router.use(apiCheckAuth);

// Bot context switching endpoint
router.post('/bot/switch', switchBotContext);

// User-scoped routes (login-only via apiCheckAuth above; scoped to req.user.id,
// so a user can only ever touch their OWN row — NO guild-admin gate here).
router.use('/me/buymeacoffee', meBuyMeACoffeeRoutes);
router.use('/me/stream-team', meStreamTeamRoutes);

// Guild-specific API routes
// Each feature router handles its own /guilds/:guildId prefix internally
router.use('/guilds/:guildId', apiCheckGuildAdmin, botContext);

// Mount feature routes
router.use('/guilds/:guildId/moderation', moderationRoutes);
router.use('/guilds/:guildId/automod', automodRoutes);
router.use('/guilds/:guildId/leveling', levelingRoutes);
router.use('/guilds/:guildId/economy', economyRoutes);
router.use('/guilds/:guildId/tickets', ticketsRoutes);
router.use('/guilds/:guildId/welcome', welcomeRoutes);
router.use('/guilds/:guildId/streaming', streamingRoutes);
router.use('/guilds/:guildId/reaction-roles', reactionRolesRoutes);
router.use('/guilds/:guildId/starboard', starboardRoutes);
router.use('/guilds/:guildId/security', securityRoutes);
router.use('/guilds/:guildId/logging', loggingRoutes);
router.use('/guilds/:guildId/giveaways', giveawaysRoutes);
router.use('/guilds/:guildId/polls', pollsRoutes);
router.use('/guilds/:guildId/suggestions', suggestionsRoutes);
router.use('/guilds/:guildId/core', coreRoutes);
router.use('/guilds/:guildId/rank-card', rankcardRoutes);
router.use('/guilds/:guildId/commands', commandsRoutes);
router.use('/guilds/:guildId/phishing', phishingRoutes);
router.use('/guilds/:guildId/free-games', freeGamesRoutes);
router.use('/guilds/:guildId/prefix-commands', prefixCommandsRoutes);
router.use('/guilds/:guildId/custom-bot', customBotRoutes);
router.use('/guilds/:guildId/emoji-manager', emojiManagerRoutes);
router.use('/guilds/:guildId/todo', todoRoutes);
router.use('/guilds/:guildId/autoresponders', autoresponderRoutes);
router.use('/guilds/:guildId/throne', throneRoutes);
router.use('/guilds/:guildId/transfer', serverTransferRoutes);
router.use('/guilds/:guildId/twitch-schedules', twitchSchedulesRoutes);
router.use('/guilds/:guildId/invite-filter', inviteFilterRoutes);
router.use('/guilds/:guildId/feeds', feedsRoutes);
router.use('/guilds/:guildId/owo', owoRoutes);
router.use('/guilds', globalBanRoutes);
router.use('/guilds/:guildId/fourthwall', fourthwallRoutes);

// Health check
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// API documentation endpoint
router.get('/docs', (req, res) => {
    res.json({
        version: '2.0.0',
        endpoints: {
            moderation: '/api/guilds/:guildId/moderation',
            automod: '/api/guilds/:guildId/automod',
            leveling: '/api/guilds/:guildId/leveling',
            economy: '/api/guilds/:guildId/economy',
            tickets: '/api/guilds/:guildId/tickets',
            welcome: '/api/guilds/:guildId/welcome',
            streaming: '/api/guilds/:guildId/streaming',
            reactionRoles: '/api/guilds/:guildId/reaction-roles',
            starboard: '/api/guilds/:guildId/starboard',
            security: '/api/guilds/:guildId/security',
            logging: '/api/guilds/:guildId/logging',
            giveaways: '/api/guilds/:guildId/giveaways',
            polls: '/api/guilds/:guildId/polls',
            suggestions: '/api/guilds/:guildId/suggestions',
            core: '/api/guilds/:guildId/core',
            rankCard: '/api/guilds/:guildId/rank-card',
            commands: '/api/guilds/:guildId/commands',
            phishing: '/api/guilds/:guildId/phishing',
            freeGames: '/api/guilds/:guildId/free-games',
            prefixCommands: '/api/guilds/:guildId/prefix-commands',
            emojiManager: '/api/guilds/:guildId/emoji-manager'
        }
    });
});

export default router;
