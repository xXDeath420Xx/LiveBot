/**
 * Game News API
 *
 * CRUD for game_patch_watchers — the patch-note / game-news watchers polled by
 * jobs/game-patch-scheduler.js. Before this existed there was no create path at all:
 * scripts/enable-patch-watcher.js could only prime an already-inserted row, so watchers
 * had to be added with hand-written SQL. Everything here is new surface, not a port.
 *
 * A watcher is either preset-backed (preset_key set, config copied from
 * core/game-news-presets.js) or custom (an RSS URL or Steam appid the user typed).
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { GAME_NEWS_PRESETS, getPreset } from '../../../../core/game-news-presets.js';
import { PROVIDERS } from '../../../../core/game-patch-watcher-manager.js';

const router = express.Router({ mergeParams: true });

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 1440;

/** Providers a user is allowed to pick directly when not using a preset. */
const CUSTOM_PROVIDERS = new Set(['rss', 'steam-news', 'twitter-rss']);

/**
 * Build the provider_config for a create/update.
 * Preset-backed watchers take the catalogue's config verbatim so a corrected feed URL in the
 * catalogue reaches every guild; only the keyword filters stay per-watcher.
 */
function buildConfig({ preset_key, provider, url, appid, username, feeds, include, exclude, max_items }) {
    const keywords = {};
    if (Array.isArray(include) && include.length) keywords.include = include.map(String);
    if (Array.isArray(exclude) && exclude.length) keywords.exclude = exclude.map(String);

    const preset = getPreset(preset_key);
    if (preset) return { ...preset.config, ...keywords };

    const cfg = { ...keywords };
    if (max_items) cfg.maxItems = Math.min(Math.max(parseInt(max_items, 10) || 10, 1), 25);

    if (provider === 'rss') {
        cfg.url = String(url || '').trim();
    } else if (provider === 'steam-news') {
        cfg.appid = parseInt(appid, 10);
        if (Array.isArray(feeds) && feeds.length) cfg.feeds = feeds.map(String);
    } else if (provider === 'twitter-rss') {
        cfg.username = String(username || '').replace(/^@/, '').trim();
    }
    return cfg;
}

/** Reject a config that can never fetch anything, rather than storing a watcher that silently no-ops. */
function validate({ provider, config }) {
    if (!PROVIDERS[provider]) return `Unknown provider "${provider}"`;
    if (provider === 'rss') {
        if (!config.url) return 'A feed URL is required';
        let parsed;
        try { parsed = new URL(config.url); } catch { return 'Feed URL is not a valid URL'; }
        if (!/^https?:$/.test(parsed.protocol)) return 'Feed URL must be http or https';
    }
    if (provider === 'steam-news' && !Number.isFinite(config.appid)) return 'A numeric Steam appid is required';
    if (provider === 'twitter-rss' && !config.username) return 'An account name is required';
    return null;
}

/** GET /api/guilds/:guildId/game-news — watchers + the preset catalogue. */
router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [watchers] = await pool.execute(
            `SELECT id, guild_id, channel_id, role_ping_id, provider, preset_key, game_label,
                    embed_color, provider_config, check_interval_minutes, is_enabled,
                    last_checked_at, last_posted_at, last_error, created_at,
                    JSON_LENGTH(COALESCE(last_seen_ids, JSON_ARRAY())) AS seen_count
               FROM game_patch_watchers
              WHERE guild_id = ?
              ORDER BY game_label ASC`,
            [guildId]
        );

        res.json({
            success: true,
            watchers: watchers.map(w => ({
                ...w,
                // A watcher that has never primed has posted nothing yet; make that legible
                // instead of leaving the UI to infer it from a null timestamp.
                primed: (w.seen_count ?? 0) > 0,
                provider_config: typeof w.provider_config === 'string'
                    ? JSON.parse(w.provider_config || '{}')
                    : (w.provider_config || {}),
            })),
            presets: GAME_NEWS_PRESETS.map(p => ({
                key: p.key, label: p.label, platform: p.platform, provider: p.provider, note: p.note || null,
                color: p.color ?? null, // the brand colour posts use, for the page's preview
            })),
            customProviders: [...CUSTOM_PROVIDERS],
        });
    } catch (error) {
        logger.error('[API GameNews GET] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch game news watchers' });
    }
});

/** POST /api/guilds/:guildId/game-news — create a watcher. */
router.post('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const b = req.body || {};
        if (!b.channel_id) return res.status(400).json({ error: 'A channel is required' });

        const preset = getPreset(b.preset_key);
        const provider = preset ? preset.provider : b.provider;
        if (!preset && !CUSTOM_PROVIDERS.has(provider)) {
            return res.status(400).json({ error: 'Pick a game from the catalogue, or choose a custom source type' });
        }

        const label = String(b.game_label || preset?.label || '').trim().slice(0, 80);
        if (!label) return res.status(400).json({ error: 'A name for this watcher is required' });

        const config = buildConfig({ ...b, provider });
        const problem = validate({ provider, config });
        if (problem) return res.status(400).json({ error: problem });

        const interval = Math.min(Math.max(parseInt(b.check_interval_minutes, 10) || 15, MIN_INTERVAL), MAX_INTERVAL);

        // New watchers start disabled-but-primeable: last_seen_ids stays NULL so the first
        // poll primes rather than dumping the entire current front page into the channel.
        const [result] = await pool.execute(
            `INSERT INTO game_patch_watchers
               (guild_id, channel_id, role_ping_id, provider, preset_key, game_label, embed_color,
                provider_config, check_interval_minutes, is_enabled, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                guildId,
                b.channel_id,
                b.role_ping_id || null,
                provider,
                preset?.key || null,
                label,
                b.embed_color || null,
                JSON.stringify(config),
                interval,
                b.is_enabled === false ? 0 : 1,
                req.user?.id || null,
            ]
        );

        res.json({ success: true, id: result.insertId, message: `Now watching ${label}` });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'That source is already being watched in this channel' });
        }
        logger.error('[API GameNews POST] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to create watcher' });
    }
});

/** PATCH /api/guilds/:guildId/game-news/:id — update a watcher. */
router.patch('/:id', async (req, res) => {
    try {
        const { guildId, id } = req.params;
        const b = req.body || {};

        const [[row]] = await pool.execute(
            'SELECT * FROM game_patch_watchers WHERE id = ? AND guild_id = ?',
            [id, guildId]
        );
        if (!row) return res.status(404).json({ error: 'Watcher not found' });

        const sets = [];
        const args = [];
        const push = (col, val) => { sets.push(`${col} = ?`); args.push(val); };

        if (b.channel_id !== undefined) push('channel_id', b.channel_id);
        if (b.role_ping_id !== undefined) push('role_ping_id', b.role_ping_id || null);
        if (b.embed_color !== undefined) push('embed_color', b.embed_color || null);
        if (b.game_label !== undefined) push('game_label', String(b.game_label).trim().slice(0, 80));
        if (b.is_enabled !== undefined) push('is_enabled', b.is_enabled ? 1 : 0);
        if (b.check_interval_minutes !== undefined) {
            push('check_interval_minutes',
                Math.min(Math.max(parseInt(b.check_interval_minutes, 10) || 15, MIN_INTERVAL), MAX_INTERVAL));
        }

        // Only rebuild the config when the caller actually sent source fields — a PATCH that
        // just flips is_enabled must not wipe a hand-tuned config back to defaults.
        const touchesSource = ['url', 'appid', 'username', 'feeds', 'include', 'exclude', 'max_items']
            .some(k => b[k] !== undefined);
        if (touchesSource) {
            const existing = typeof row.provider_config === 'string'
                ? JSON.parse(row.provider_config || '{}')
                : (row.provider_config || {});
            const config = buildConfig({
                preset_key: row.preset_key,
                provider: row.provider,
                url: b.url ?? existing.url,
                appid: b.appid ?? existing.appid,
                username: b.username ?? existing.username,
                feeds: b.feeds ?? existing.feeds,
                include: b.include ?? existing.include,
                exclude: b.exclude ?? existing.exclude,
                max_items: b.max_items ?? existing.maxItems,
            });
            const problem = validate({ provider: row.provider, config });
            if (problem) return res.status(400).json({ error: problem });
            push('provider_config', JSON.stringify(config));
            // The source changed, so previously-seen ids no longer mean anything. Clearing
            // them re-primes on the next poll instead of back-posting the new feed's history.
            sets.push('last_seen_ids = NULL');
        }

        if (!sets.length) return res.json({ success: true, message: 'Nothing to change' });

        args.push(id, guildId);
        await pool.execute(
            `UPDATE game_patch_watchers SET ${sets.join(', ')} WHERE id = ? AND guild_id = ?`,
            args
        );
        res.json({ success: true, message: 'Watcher updated' });
    } catch (error) {
        logger.error('[API GameNews PATCH] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to update watcher' });
    }
});

/** DELETE /api/guilds/:guildId/game-news/:id */
router.delete('/:id', async (req, res) => {
    try {
        const { guildId, id } = req.params;
        const [r] = await pool.execute(
            'DELETE FROM game_patch_watchers WHERE id = ? AND guild_id = ?',
            [id, guildId]
        );
        if (!r.affectedRows) return res.status(404).json({ error: 'Watcher not found' });
        res.json({ success: true, message: 'Watcher removed' });
    } catch (error) {
        logger.error('[API GameNews DELETE] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to remove watcher' });
    }
});

/**
 * POST /api/guilds/:guildId/game-news/:id/test
 * Fetch the source now and return what it currently sees, without posting to Discord.
 * This is the only way to tell a misconfigured feed from a quiet one.
 */
router.post('/:id/test', async (req, res) => {
    try {
        const { guildId, id } = req.params;
        const [[row]] = await pool.execute(
            'SELECT * FROM game_patch_watchers WHERE id = ? AND guild_id = ?',
            [id, guildId]
        );
        if (!row) return res.status(404).json({ error: 'Watcher not found' });

        const provider = PROVIDERS[row.provider];
        if (!provider) return res.status(400).json({ error: `Unknown provider "${row.provider}"` });

        const cfg = typeof row.provider_config === 'string'
            ? JSON.parse(row.provider_config || '{}')
            : (row.provider_config || {});

        const started = Date.now();
        const items = await provider(cfg, row);
        const elapsed = Date.now() - started;

        // A successful manual test clears a stale error banner.
        await pool.execute('UPDATE game_patch_watchers SET last_error = NULL WHERE id = ?', [id]);

        res.json({
            success: true,
            elapsed_ms: elapsed,
            count: items.length,
            items: items.slice(0, 5).map(i => ({
                title: i.title, url: i.url, posted_at: i.posted_at,
                description: (i.description || '').slice(0, 200),
            })),
        });
    } catch (error) {
        logger.error('[API GameNews TEST] Error:', { error: error.message });
        // Persist it so the row's health badge matches what the test just showed.
        await pool.execute(
            'UPDATE game_patch_watchers SET last_error = ? WHERE id = ? AND guild_id = ?',
            [String(error.message).slice(0, 500), req.params.id, req.params.guildId]
        ).catch(() => {});
        res.status(502).json({ error: `Source fetch failed: ${error.message}` });
    }
});

export default router;
