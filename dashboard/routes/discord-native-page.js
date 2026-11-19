/**
 * Consolidated "Discord Native Features" dashboard page.
 *
 * One page, five tabs. Every tab is a thin JS shell that calls the matching
 * `/api/guilds/:id/...` endpoint and renders the response — no server-side
 * data loading, which keeps this file small and future tabs cheap to add.
 *
 * Tabs:
 *   - welcome-screen   /api/guilds/:id/welcome-screen         GET + PATCH
 *   - onboarding       /api/guilds/:id/onboarding             GET + PATCH
 *   - soundboard       /api/guilds/:id/discord-soundboard     GET + POST + PATCH + DELETE
 *   - events           /api/guilds/:id/scheduled-events       GET + POST + PATCH + DELETE
 *   - app-emojis       /api/app-emojis                        super-admin only
 *
 * Route: GET /manage/:guildId/discord-native?tab=<name>
 * Guarded by checkAuth + checkGuildAdmin (super-admin bypass included).
 */
import express from 'express';
import { checkAuth, checkGuildAdmin } from '../middleware/auth.js';

const router = express.Router();

const TABS = [
    { key: 'welcome-screen', label: 'Welcome Screen', icon: 'fa-hand-sparkles' },
    { key: 'onboarding',     label: 'Onboarding',     icon: 'fa-door-open' },
    { key: 'soundboard',     label: 'Soundboard',     icon: 'fa-volume-high' },
    { key: 'events',         label: 'Scheduled Events', icon: 'fa-calendar-check' },
    { key: 'app-emojis',     label: 'App Emojis',     icon: 'fa-icons' },
];

router.get('/manage/:guildId/discord-native', checkAuth, checkGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const tabKey = TABS.find(t => t.key === req.query.tab) ? req.query.tab : 'welcome-screen';
    // Channel pickers (welcome screen, onboarding, event channel) instead of typing channel IDs.
    const KIND = { 0: 'text', 5: 'text', 15: 'forum', 2: 'voice', 13: 'stage' };
    const channels = req.guildObject
        ? [...req.guildObject.channels.cache.values()]
            .filter(c => KIND[c.type] !== undefined)
            .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition)
            .map(c => ({ id: c.id, name: c.name, kind: KIND[c.type], parent: c.parent?.name || null }))
        : [];
    res.render('discord-native', {
        user: req.user,
        channels,
        guildId,
        guildName: req.guildObject?.name || guildId,
        tabs: TABS,
        activeTab: tabKey,
        isSuperAdmin: !!req.isSuperAdmin,
    });
});

export default router;
