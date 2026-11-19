/**
 * Super-admin API overview — a single page listing every mounted feature API
 * route, its HTTP methods, who's allowed, and a brief description. Hit at
 * `/manage/:guildId/api-overview`.
 *
 * The list is static — the alternative is reflecting over Express's internal
 * `router.stack`, which pulls in private discord.js internals and breaks when
 * middleware wraps a sub-router. A hand-curated catalogue keeps the page
 * accurate and reviewable in one place.
 */
import express from 'express';
import { checkAuth, checkGuildAdmin } from '../middleware/auth.js';

const router = express.Router();

const CATALOG = [
    // ─── 2026 Discord-native surfaces (built this session) ─────────────────
    { group: 'Discord 2026', path: '/api/guilds/:id/automod',           methods: ['GET whitelist', 'POST whitelist', 'DELETE whitelist/:userId', 'GET rules', 'POST rules', 'PATCH rules/:id', 'DELETE rules/:id'],
      auth: 'guild admin', desc: 'AutoMod whitelist + Discord-native rule CRUD. Trigger types KEYWORD / SPAM / PRESET / MENTION_SPAM / MEMBER_PROFILE.' },
    { group: 'Discord 2026', path: '/api/guilds/:id/onboarding',        methods: ['GET', 'PATCH'],
      auth: 'guild admin + bot ManageGuild', desc: 'Server Onboarding config (enabled, mode, defaultChannelIds). Prompts read-only.' },
    { group: 'Discord 2026', path: '/api/guilds/:id/welcome-screen',    methods: ['GET', 'PATCH'],
      auth: 'guild admin + bot ManageGuild + COMMUNITY feature', desc: 'Server welcome screen description + up to 5 featured channels.' },
    { group: 'Discord 2026', path: '/api/guilds/:id/discord-soundboard', methods: ['GET', 'POST', 'PATCH :id', 'DELETE :id'],
      auth: 'guild admin + bot CreateGuildExpressions', desc: 'Native Discord soundboard sounds (MP3/OGG ≤512 KB).' },
    { group: 'Discord 2026', path: '/api/guilds/:id/scheduled-events',  methods: ['GET', 'POST', 'PATCH :id', 'DELETE :id'],
      auth: 'guild admin + bot ManageEvents', desc: 'Guild scheduled events incl. recurrence rules.' },
    { group: 'Discord 2026', path: '/api/guilds/:id/member-search',     methods: ['POST'],
      auth: 'guild admin + bot ViewAuditLog', desc: 'Advanced member filter (roles, join window, DidRejoin, invite source).' },
    { group: 'Discord 2026', path: '/api/app-emojis',                   methods: ['GET', 'POST', 'DELETE :nameOrId'],
      auth: 'super-admin', desc: 'Application-scope emoji CRUD. Global to CertiFried, usable in every guild.' },
    { group: 'Discord 2026', path: '/webhooks/discord/events',          methods: ['POST (Ed25519)'],
      auth: 'Discord-signed only', desc: 'Outgoing webhook events: APPLICATION_AUTHORIZED, ENTITLEMENT_CREATE, QUEST_USER_ENROLLMENT.' },

    // ─── Twitch analytics v2 ──────────────────────────────────────────────
    { group: 'Twitch', path: '/manage/:id/twitch-analytics',            methods: ['GET'],
      auth: 'guild admin (super-admin override)', desc: 'Dedicated full-page analytics for a tracked broadcaster. ?range=24h|7d|30d|90d.' },

    // ─── Discord Native dashboard page ────────────────────────────────────
    { group: 'Dashboard pages', path: '/manage/:id/discord-native',     methods: ['GET'],
      auth: 'guild admin', desc: 'Tabbed UI for welcome screen / onboarding / soundboard / events / app emojis.' },
    { group: 'Dashboard pages', path: '/manage/:id/api-overview',       methods: ['GET'],
      auth: 'super-admin', desc: 'This page.' },
];

const GROUPS = ['Discord 2026', 'Twitch', 'Dashboard pages'];

router.get('/manage/:guildId/api-overview', checkAuth, checkGuildAdmin, async (req, res) => {
    // Super-admin only; non-super-admin guild admins get a 403.
    const { isSuperAdmin } = await import('../../utils/constants.js');
    if (!isSuperAdmin(req.user?.id)) {
        return res.status(403).send('Super-admin only.');
    }
    res.render('api-overview', {
        user: req.user,
        guildId: req.params.guildId,
        guildName: req.guildObject?.name || req.params.guildId,
        catalog: CATALOG,
        groups: GROUPS,
    });
});

export default router;
