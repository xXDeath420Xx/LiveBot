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

const router = express.Router();

// Apply auth to all API routes
router.use(apiCheckAuth);

// Bot context switching endpoint
router.post('/bot/switch', switchBotContext);

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
            rankCard: '/api/guilds/:guildId/rank-card'
        }
    });
});

export default router;
