import express from 'express';
import { apiCheckAuth, apiCheckGuildAdmin } from '../../middleware/auth.js';
import { botContext, switchBotContext } from '../../middleware/botContext.js';

// Feature APIs
import automodRoutes from './features/automod.js';
import onboardingRoutes from './features/onboarding.js';
import welcomeScreenRoutes from './features/welcome-screen.js';
import discordSoundboardRoutes from './features/discord-soundboard.js';
import scheduledEventsRoutes from './features/scheduled-events.js';
import applicationEmojisRoutes from './application-emojis.js';
import memberSearchRoutes from './features/member-search.js';
import streamingRoutes from './features/streaming.js';
import reactionRolesRoutes from './features/reactionRoles.js';
import loggingRoutes from './features/logging.js';
import moderationMessagesRoutes from './features/moderation-messages.js';
import giveawaysRoutes from './features/giveaways.js';
import channelPostRulesRoutes from './features/channel-post-rules.js';
import vcSoundsRoutes from './features/vc-sounds.js';
import coreRoutes from './features/core.js';
import rankcardRoutes from './features/rankcard.js';
import commandsRoutes from './features/commands.js';
import phishingRoutes from './features/phishing.js';
import freeGamesRoutes from './features/free-games.js';
import gameNewsRoutes from './features/game-news.js';
import twitchClipsRoutes from './features/twitch-clips.js';
import featureConfigRoutes from './features/feature-config.js';
import featureCatalogRoutes from './features/feature-catalog.js';
import modmailRoutes from './features/modmail.js';
import prefixCommandsRoutes from './features/prefix-commands.js';
import customCommandsRoutes from './features/custom-commands.js';
import { backupApiRouter } from '../features/backups.js';
import kofiRoutes from './features/kofi.js';
import countingRoutes from './features/counting.js';
import announceRoutes from './features/announce.js';
import minigamesRoutes from './features/minigames.js';
import initializeRoutes from './features/initialize.js';
import takeoverRoutes from './features/takeover.js';
import customBotRoutes from './features/custom-bot.js';
import emojiManagerRoutes from './features/emoji-manager.js';
import soundboardRoutes from './features/soundboard.js';
import todoRoutes from './features/todo.js';
import globalBanRoutes from '../features/global-ban.js';
import autoresponderRoutes from './features/autoresponders.js';
import throneRoutes from './features/throne.js';
import serverTransferRoutes from './features/server-transfer.js';
import twitchSchedulesRoutes from './features/twitch-schedules.js';
import inviteFilterRoutes from './features/invite-filter.js';
import feedsRoutes from './features/feeds.js';
import owoRoutes from './features/critters.js';
import fourthwallRoutes from './features/fourthwall.js';
import channelAccessRoutes from './features/channel-access.js';
import liveStyleRoutes from './features/live-style.js';
import bulkRolesRoutes from './features/bulk-roles.js';
import roleManagerRoutes from './features/role-manager.js';
import protectionSettingsRoutes from './features/protection-settings.js';
import spammerScanRoutes from './features/spammer-scan.js';
import insightRoutes from './features/insight.js';
import nameFilterRoutes from './features/name-filters.js';
import avatarProtectionRoutes from './features/avatar-protection.js';
import verificationRoutes from './features/verification.js';
import messageThreatRoutes from './features/message-threats.js';
import aiModerationRoutes from './features/ai-moderation.js';
import nsfwProtectionRoutes from './features/nsfw-protection.js';
import domainReportRoutes from './features/domain-reports.js';
import raidLockdownRoutes from './features/raid-lockdown.js';
import activityAuditRoutes from './features/activity-audit.js';
import joinRequestRoutes from './features/join-requests.js';
import steamLibraryRoutes from './features/steam-library.js';
import digimonRoutes from './features/digimon.js';
import greenhouseRoutes from './features/greenhouse.js';
import userResolveRoutes from './features/user-resolve.js';
import qotdRoutes from './features/qotd.js';
import holidaysRoutes from './features/holidays.js';
import scheduledMessagesRoutes from './features/scheduled-messages.js';
import autorolesRoutes from './features/autoroles.js';
import levelingAdminRoutes from './features/leveling-admin.js';
import ticketsRoutes from './features/tickets.js';

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

// Server backups: "what changed" (GET /backup-diff/:backupId); create/restore/delete are page forms under /manage.
router.use('/guilds/:guildId', backupApiRouter);

// Mount feature routes
router.use('/guilds/:guildId/automod', automodRoutes);
router.use('/guilds/:guildId/onboarding', onboardingRoutes);
router.use('/guilds/:guildId/welcome-screen', welcomeScreenRoutes);
// Discord's native soundboard (via guild.soundboardSounds). The existing
// '/soundboard' route (above) is CertiFried's own disk-backed VC-sound library
// and is unrelated — the two paths are kept separate on purpose.
router.use('/guilds/:guildId/discord-soundboard', discordSoundboardRoutes);
router.use('/guilds/:guildId/scheduled-events', scheduledEventsRoutes);
router.use('/guilds/:guildId/member-search', memberSearchRoutes);
router.use('/app-emojis', applicationEmojisRoutes);
router.use('/guilds/:guildId/streaming', streamingRoutes);
router.use('/guilds/:guildId/reaction-roles', reactionRolesRoutes);
router.use('/guilds/:guildId/logging', loggingRoutes);
router.use('/guilds/:guildId/moderation', moderationMessagesRoutes);
router.use('/guilds/:guildId/giveaways', giveawaysRoutes);
router.use('/guilds/:guildId/channel-post-rules', channelPostRulesRoutes);
router.use('/guilds/:guildId/vc-sounds', vcSoundsRoutes);
router.use('/guilds/:guildId/core', coreRoutes);
router.use('/guilds/:guildId/rank-card', rankcardRoutes);
router.use('/guilds/:guildId/commands', commandsRoutes);
router.use('/guilds/:guildId/phishing', phishingRoutes);
router.use('/guilds/:guildId/free-games', freeGamesRoutes);
router.use('/guilds/:guildId/game-news', gameNewsRoutes);
router.use('/guilds/:guildId/twitch-clips', twitchClipsRoutes);
// Generic settings API covering every feature in core/feature-config-spec.js.
router.use('/guilds/:guildId/feature-config', featureConfigRoutes);
router.use('/guilds/:guildId/feature-catalog', featureCatalogRoutes);
// Modmail page: settings, conversations, transcripts, block list.
router.use('/guilds/:guildId/modmail', modmailRoutes);
router.use('/guilds/:guildId/prefix-commands', prefixCommandsRoutes);
router.use('/guilds/:guildId/custom-commands', customCommandsRoutes);
router.use('/guilds/:guildId/kofi', kofiRoutes);
router.use('/guilds/:guildId/counting', countingRoutes);
router.use('/guilds/:guildId/announce', announceRoutes);
router.use('/guilds/:guildId/minigames', minigamesRoutes);
router.use('/guilds/:guildId/initialize', initializeRoutes);
router.use('/guilds/:guildId/takeover', takeoverRoutes);
router.use('/guilds/:guildId/custom-bot', customBotRoutes);
router.use('/guilds/:guildId/emoji-manager', emojiManagerRoutes);
router.use('/guilds/:guildId/soundboard', soundboardRoutes);
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
router.use('/guilds/:guildId/channel-access', channelAccessRoutes);
router.use('/guilds/:guildId/live-style', liveStyleRoutes);
router.use('/guilds/:guildId/bulk-roles', bulkRolesRoutes);
router.use('/guilds/:guildId/role-manager', roleManagerRoutes);
router.use('/guilds/:guildId/protection-settings', protectionSettingsRoutes);
router.use('/guilds/:guildId/spammer-scan', spammerScanRoutes);
router.use('/guilds/:guildId/insight', insightRoutes);
router.use('/guilds/:guildId/name-filters', nameFilterRoutes);
router.use('/guilds/:guildId/avatar-protection', avatarProtectionRoutes);
router.use('/guilds/:guildId/verification', verificationRoutes);
router.use('/guilds/:guildId/message-threats', messageThreatRoutes);
router.use('/guilds/:guildId/ai-moderation', aiModerationRoutes);
router.use('/guilds/:guildId/nsfw-protection', nsfwProtectionRoutes);
router.use('/guilds/:guildId/domain-reports', domainReportRoutes);
router.use('/guilds/:guildId/raid-lockdown', raidLockdownRoutes);
router.use('/guilds/:guildId/activity-audit', activityAuditRoutes);
router.use('/guilds/:guildId/join-requests', joinRequestRoutes);
router.use('/guilds/:guildId/steam-library', steamLibraryRoutes);
router.use('/guilds/:guildId/digimon', digimonRoutes);
// Greenhouse Tycoon (v2) server page: members who play, the season, the game link (partials/manage/greenhouse.ejs).
router.use('/guilds/:guildId/greenhouse', greenhouseRoutes);
router.use('/guilds/:guildId/users', userResolveRoutes);
// QOTD suggestion review + post queue (the qotd page, partials/manage/_qotd-review.ejs).
router.use('/guilds/:guildId/qotd', qotdRoutes);
// Holiday countdowns: per-holiday on/off, name, emoji and post-on-the-day (partials/manage/holidays.ejs).
router.use('/guilds/:guildId/holidays', holidaysRoutes);
// Scheduled messages: recurring channel posts (partials/manage/scheduled-messages.ejs, rows in scheduled_announcements).
router.use('/guilds/:guildId/scheduled-messages', scheduledMessagesRoutes);
// Autoroles: the "give to existing members" background run (partials/manage/utilities.ejs).
router.use('/guilds/:guildId/autoroles', autorolesRoutes);
// Leveling page: member XP edits and XP events (partials/manage/leveling.ejs).
router.use('/guilds/:guildId/leveling-admin', levelingAdminRoutes);
// Tickets page: ticket details dialog (view, staff notes, assign, close) (partials/manage/tickets.ejs).
router.use('/guilds/:guildId/tickets', ticketsRoutes);

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
            onboarding: '/api/guilds/:guildId/onboarding',
            welcomeScreen: '/api/guilds/:guildId/welcome-screen',
            discordSoundboard: '/api/guilds/:guildId/discord-soundboard',
            scheduledEvents: '/api/guilds/:guildId/scheduled-events',
            appEmojis: '/api/app-emojis',
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
            gameNews: '/api/guilds/:guildId/game-news',
            twitchClips: '/api/guilds/:guildId/twitch-clips',
            prefixCommands: '/api/guilds/:guildId/prefix-commands',
            emojiManager: '/api/guilds/:guildId/emoji-manager'
        }
    });
});

export default router;
