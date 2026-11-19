/**
 * Super-admin command usage report (network-wide; every server and every bot).
 *
 *   GET /super-admin/command-usage              the page
 *   GET /api/super-admin/command-usage?range=    7 | 30 | 90 | 365 | all (days)
 *
 * Counts come from command_usage_daily (jobs/command-usage-rollup.js, kept forever, today included
 * within the hour), which also holds the backfilled history (source != 'live'). Distinct members come
 * from command_usage (raw, 400 days), so they cover live tracking only. Commands with no use in the
 * range are listed from the bot's loaded command collection. Super-admin only: it covers every server.
 */
import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { checkAuth, checkSuperAdmin } from '../middleware/auth.js';
import { commandType } from '../../core/command-registration.js';

const router = express.Router();
export const RANGES = { 7: 7, 30: 30, 90: 90, 365: 365, all: null };
const CACHE_MS = 60_000;
const cache = new Map();   // range -> { at, promise }

const TEXT_KINDS = new Set(['prefix', 'slash_text']);

async function loadReport(range) {
    const days = RANGES[range];
    const since = days ? `CURDATE() - INTERVAL ${days - 1} DAY` : "'1970-01-01'";
    const [byPath] = await pool.query(
        `SELECT path, kind, SUM(uses) AS uses, SUM(errors) AS errors, COUNT(DISTINCT guild_id) AS servers,
                DATE_FORMAT(MAX(day), '%Y-%m-%d') AS last, SUM(source <> 'live') AS backfilled_rows
           FROM command_usage_daily WHERE day >= ${since}
          GROUP BY path, kind`);
    const [serversByCmd] = await pool.query(
        `SELECT SUBSTRING_INDEX(path, ' ', 1) AS command, COUNT(DISTINCT guild_id) AS servers
           FROM command_usage_daily WHERE day >= ${since} GROUP BY command`);
    const [[tot]] = await pool.query(
        `SELECT COALESCE(SUM(uses), 0) AS uses, COALESCE(SUM(errors), 0) AS errors, COUNT(DISTINCT guild_id) AS servers,
                DATE_FORMAT(MIN(day), '%Y-%m-%d') AS first
           FROM command_usage_daily WHERE day >= ${since}`);
    const rawSince = days ? `CURDATE() - INTERVAL ${days - 1} DAY` : "'1970-01-01'";
    const [usersByCmd] = await pool.query(
        `SELECT command, COUNT(DISTINCT user_id) AS users FROM command_usage
          WHERE created_at >= ${rawSince} AND user_id IS NOT NULL GROUP BY command`);
    const [[uTot]] = await pool.query(
        `SELECT COUNT(DISTINCT user_id) AS users, DATE_FORMAT(MIN(created_at), '%Y-%m-%d') AS tracking_since
           FROM command_usage WHERE created_at >= ${rawSince} AND user_id IS NOT NULL`);

    // Everything the bot can run, so commands nobody used still appear.
    const client = global.botManager?.getDefaultClient?.() || global.client || null;
    const catalog = new Map();
    for (const cmd of client?.commands?.values?.() ?? []) {
        const name = cmd?.data?.name;
        if (!name) continue;
        let json = null;
        try { json = cmd.data.toJSON(); } catch { /* skip */ }
        catalog.set(name.toLowerCase(), {
            type: (json?.type ?? 1) !== 1 ? 'context' : commandType(name, cmd, json),
            category: cmd.category || 'other',
        });
    }

    const commands = new Map();
    const get = (name) => {
        if (!commands.has(name)) {
            const c = catalog.get(name);
            commands.set(name, { name, type: c?.type ?? 'unknown', category: c?.category ?? 'other', uses: 0, slash: 0, text: 0,
                context: 0, errors: 0, servers: 0, users: 0, last: null, backfilled: false, paths: [] });
        }
        return commands.get(name);
    };
    for (const name of catalog.keys()) get(name);
    const pathMap = new Map();
    for (const r of byPath) {
        const name = String(r.path).split(' ')[0];
        const c = get(name);
        const uses = Number(r.uses) || 0;
        c.uses += uses;
        c.errors += Number(r.errors) || 0;
        if (r.kind === 'slash') c.slash += uses;
        else if (TEXT_KINDS.has(r.kind)) c.text += uses;
        else if (r.kind === 'context') c.context += uses;
        if (!c.last || (r.last && r.last > c.last)) c.last = r.last;
        if (Number(r.backfilled_rows) > 0) c.backfilled = true;
        let p = pathMap.get(r.path);
        if (!p) { p = { path: r.path, uses: 0, slash: 0, text: 0, errors: 0, servers: 0, last: null }; pathMap.set(r.path, p); c.paths.push(p); }
        p.uses += uses;
        p.errors += Number(r.errors) || 0;
        if (r.kind === 'slash') p.slash += uses; else if (TEXT_KINDS.has(r.kind)) p.text += uses;
        p.servers = Math.max(p.servers, Number(r.servers) || 0);
        if (!p.last || (r.last && r.last > p.last)) p.last = r.last;
    }
    for (const r of serversByCmd) if (commands.has(r.command)) commands.get(r.command).servers = Number(r.servers) || 0;
    for (const r of usersByCmd) if (commands.has(r.command)) commands.get(r.command).users = Number(r.users) || 0;
    for (const c of commands.values()) c.paths.sort((a, b) => b.uses - a.uses || a.path.localeCompare(b.path));

    const list = [...commands.values()];
    return {
        range,
        now: Date.now(),
        totals: {
            uses: Number(tot.uses) || 0,
            errors: Number(tot.errors) || 0,
            servers: Number(tot.servers) || 0,
            users: Number(uTot.users) || 0,
            first: tot.first || null,
            trackingSince: uTot.tracking_since || null,
            slash: list.reduce((s, c) => s + c.slash, 0),
            text: list.reduce((s, c) => s + c.text, 0),
            context: list.reduce((s, c) => s + c.context, 0),
            unused: list.filter(c => c.uses === 0 && catalog.has(c.name)).length,
        },
        commands: list,
    };
}

router.get('/super-admin/command-usage', checkAuth, checkSuperAdmin, (req, res) => {
    res.render('super-admin-command-usage', { user: req.user });
});

router.get('/api/super-admin/command-usage', checkAuth, checkSuperAdmin, async (req, res) => {
    const range = Object.prototype.hasOwnProperty.call(RANGES, req.query.range) ? String(req.query.range) : '30';
    try {
        let hit = cache.get(range);
        if (!hit || Date.now() - hit.at > CACHE_MS || req.query.fresh === '1') {
            hit = { at: Date.now(), promise: loadReport(range) };
            cache.set(range, hit);
            hit.promise.catch(() => cache.delete(range));
        }
        res.set('Cache-Control', 'no-store').json(await hit.promise);
    } catch (error) {
        if (error?.code === 'ER_NO_SUCH_TABLE') {
            return res.status(503).json({ error: 'Command usage tracking is not set up yet (migration 433 has not run).' });
        }
        logger.error('[CommandUsageReport] API error', { error: error.message });
        res.status(500).json({ error: 'Could not load command usage' });
    }
});

export default router;
