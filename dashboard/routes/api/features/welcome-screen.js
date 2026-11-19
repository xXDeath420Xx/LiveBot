/**
 * Server Welcome Screen API — thin wrapper on top of Discord's
 * `/guilds/{id}/welcome-screen`, surfaced through discord.js's
 * `guild.fetchWelcomeScreen()` and `guild.editWelcomeScreen()`.
 *
 * The welcome screen is the panel non-members see when they land on a server's
 * invite link. CertiFried's own in-channel orientation message is complementary
 * and lives at `core/orientation-manager.js`.
 *
 * All routes gated by `apiCheckGuildAdmin` at the parent router. Requires the
 * guild to have the COMMUNITY feature — Discord returns a 400 otherwise, which
 * we forward as a 409 with a clear message.
 */
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;

function serialiseWelcomeScreen(ws, guild) {
    const channels = ws?.welcomeChannels ?? ws?.channels ?? [];
    const arr = typeof channels.values === 'function' ? [...channels.values()] : (Array.isArray(channels) ? channels : []);
    return {
        description: ws?.description ?? null,
        enabled: !!guild?.features?.includes?.('WELCOME_SCREEN_ENABLED'),
        channels: arr.map(c => ({
            channelId: c?.channelId ?? c?.channel_id ?? c?.id ?? null,
            description: c?.description ?? null,
            emoji: c?.emoji
                ? { id: c.emoji.id ?? c.emoji_id ?? null, name: c.emoji.name ?? c.emoji_name ?? null, animated: !!(c.emoji.animated) }
                : null,
        })),
    };
}

function requireManageGuild(req, res) {
    const me = req.guildObject?.members?.me;
    if (!me?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
        res.status(403).json({ error: 'The bot is missing Manage Server; welcome screen cannot be read or changed.' });
        return false;
    }
    return true;
}

/** GET / — current welcome screen settings. */
router.get('/', async (req, res) => {
    try {
        if (!requireManageGuild(req, res)) return;
        if (!req.guildObject.features?.includes('COMMUNITY')) {
            return res.status(409).json({ error: 'Welcome Screen requires the Community feature; enable Community in Server Settings first.' });
        }
        const ws = await req.guildObject.fetchWelcomeScreen();
        res.json({ welcomeScreen: serialiseWelcomeScreen(ws, req.guildObject) });
    } catch (err) {
        if (err?.code === 50001 || err?.code === 50013) {
            return res.status(403).json({ error: 'Discord refused — missing permission or Community not enabled.' });
        }
        logger.error('[API welcome-screen GET] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to fetch welcome screen' });
    }
});

/**
 * PATCH / — edit the welcome screen. Accepts:
 *   - enabled: boolean
 *   - description: string | null (384 chars max)
 *   - channels: Array<{ channelId, description, emoji: { id?|name?, animated? } }>
 *     up to 5 entries per Discord's limit.
 */
router.patch('/', async (req, res) => {
    try {
        if (!requireManageGuild(req, res)) return;
        if (!req.guildObject.features?.includes('COMMUNITY')) {
            return res.status(409).json({ error: 'Welcome Screen requires the Community feature.' });
        }

        const patch = {};
        if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
        if (req.body?.description !== undefined) {
            const d = req.body.description;
            if (d !== null && typeof d !== 'string') return res.status(400).json({ error: 'description must be a string or null.' });
            if (typeof d === 'string' && d.length > 384) return res.status(400).json({ error: 'description must be 384 characters or less.' });
            patch.description = d;
        }
        if (Array.isArray(req.body?.channels)) {
            if (req.body.channels.length > 5) return res.status(400).json({ error: 'A welcome screen can have at most 5 featured channels.' });
            patch.welcomeChannels = req.body.channels.map(c => {
                if (!SNOWFLAKE.test(String(c?.channelId))) return null;
                return {
                    channel: String(c.channelId),
                    description: String(c.description ?? '').slice(0, 50),
                    emoji: c.emoji ? { id: c.emoji.id ?? null, name: c.emoji.name ?? null } : undefined,
                };
            }).filter(Boolean);
        }
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to patch.' });
        if (req.body?.reason) patch.reason = String(req.body.reason).slice(0, 512);

        const edited = await req.guildObject.editWelcomeScreen(patch);
        logger.info('[API welcome-screen PATCH] updated', {
            guildId: req.params.guildId, keys: Object.keys(patch), by: req.user?.id,
        });
        res.json({ success: true, welcomeScreen: serialiseWelcomeScreen(edited, req.guildObject) });
    } catch (err) {
        if (err?.code === 50001 || err?.code === 50013) {
            return res.status(403).json({ error: 'Discord refused — missing permission.' });
        }
        logger.error('[API welcome-screen PATCH] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to update welcome screen' });
    }
});

export default router;
