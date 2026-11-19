/**
 * Join Applications API — `/api/guilds/:guildId/join-requests/*`
 *
 * The full decided history of "Apply to join" applications, with who approved or rejected
 * each one. Discord keeps that only on the join request (never the audit log), so the rows
 * come from guild_join_requests, filled by jobs/join-request-sync.js. Reading this page
 * never posts anything to Discord.
 *
 * Gated by `apiCheckGuildAdmin` on the parent router. Every query is scoped to the guild
 * in the URL.
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { requiresApplication, syncGuild, answerText } from '../../../../core/join-request-tracker.js';

const router = express.Router({ mergeParams: true });

const PAGE_SIZE = 50;
const BAN_TTL_MS = 5 * 60 * 1000;
const banCache = new Map(); // guildId -> { at, bans: Map<userId, reason> }

async function bansFor(guild) {
    if (!guild) return new Map();
    const hit = banCache.get(guild.id);
    if (hit && Date.now() - hit.at < BAN_TTL_MS) return hit.bans;
    const bans = new Map();
    try {
        let after;
        for (let i = 0; i < 20; i++) {
            const page = await guild.bans.fetch({ limit: 1000, after, cache: false });
            for (const [id, ban] of page) bans.set(id, ban.reason || null);
            if (page.size < 1000) break;
            after = [...page.keys()].sort((a, b) => (BigInt(a) > BigInt(b) ? 1 : -1)).at(-1);
        }
    } catch (err) {
        logger.debug(`[JoinRequestsAPI] ban list unavailable for ${guild.id}: ${err.message}`);
    }
    banCache.set(guild.id, { at: Date.now(), bans });
    return bans;
}

/** WHERE clause + params shared by the list and CSV endpoints. */
function buildFilter(guildId, q) {
    const where = ['guild_id = ?'];
    const params = [guildId];
    if (q.status === 'APPROVED' || q.status === 'REJECTED') {
        where.push('status = ?');
        params.push(q.status);
    }
    if (/^\d{15,25}$/.test(q.approver || '')) {
        where.push('actioned_by_id = ?');
        params.push(q.approver);
    }
    const search = String(q.q || '').trim().slice(0, 100);
    if (search) {
        if (/^\d{15,25}$/.test(search)) {
            where.push('(user_id = ? OR actioned_by_id = ? OR request_id = ?)');
            params.push(search, search, search);
        } else {
            // Names, and the answers themselves — a Twitch handle typed into the form is
            // often the only thing a moderator remembers about an applicant.
            const like = `%${search.replace(/[\\%_]/g, c => '\\' + c)}%`;
            where.push('(username LIKE ? OR actioned_by_name LIKE ? OR form_responses LIKE ?)');
            params.push(like, like, like);
        }
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) {
        where.push('reviewed_at >= ?');
        params.push(`${q.from} 00:00:00`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) {
        where.push('reviewed_at < DATE_ADD(?, INTERVAL 1 DAY)');
        params.push(`${q.to} 00:00:00`);
    }
    return { sql: where.join(' AND '), params };
}

function shape(row, bans, guild) {
    let answers = [];
    try { answers = JSON.parse(row.form_responses || '[]'); } catch { /* keep empty */ }
    return {
        requestId: row.request_id,
        userId: row.user_id,
        username: row.username,
        status: row.status,
        approverId: row.actioned_by_id,
        approverName: row.actioned_by_name,
        rejectionReason: row.rejection_reason,
        appliedAt: row.applied_at,
        reviewedAt: row.reviewed_at,
        answers: answers.map(a => ({ label: a.label, response: answerText(a) })),
        banned: bans.has(row.user_id),
        banReason: bans.get(row.user_id) || null,
        inServer: guild ? guild.members.cache.has(row.user_id) : null,
    };
}

/** GET / — one page of decisions, newest first, plus filters and totals. */
router.get('/', async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const guild = req.botClient?.guilds?.cache?.get(guildId) || null;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const { sql, params } = buildFilter(guildId, req.query);

        const [[{ total }]] = await pool.execute(
            `SELECT COUNT(*) AS total FROM guild_join_requests WHERE ${sql}`, params
        );
        const [rows] = await pool.query(
            `SELECT * FROM guild_join_requests WHERE ${sql}
              ORDER BY reviewed_at DESC, request_id DESC LIMIT ? OFFSET ?`,
            [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]
        );
        const [approvers] = await pool.execute(
            `SELECT actioned_by_id AS id, MAX(actioned_by_name) AS name,
                    SUM(status = 'APPROVED') AS approved, SUM(status = 'REJECTED') AS rejected
               FROM guild_join_requests
              WHERE guild_id = ? AND actioned_by_id IS NOT NULL
              GROUP BY actioned_by_id ORDER BY COUNT(*) DESC`,
            [guildId]
        );
        const [[totals]] = await pool.execute(
            `SELECT COUNT(*) AS total, SUM(status = 'APPROVED') AS approved,
                    SUM(status = 'REJECTED') AS rejected, MIN(reviewed_at) AS oldest
               FROM guild_join_requests WHERE guild_id = ?`,
            [guildId]
        );
        const [[sync]] = await pool.execute(
            'SELECT backfilled_at, last_poll_at, last_error FROM guild_join_request_sync WHERE guild_id = ?',
            [guildId]
        );
        const bans = await bansFor(guild);

        res.json({
            success: true,
            requiresApplication: requiresApplication(guild),
            page, pageSize: PAGE_SIZE, total: Number(total),
            rows: rows.map(r => shape(r, bans, guild)),
            approvers: approvers.map(a => ({
                id: a.id, name: a.name, approved: Number(a.approved), rejected: Number(a.rejected),
            })),
            totals: {
                total: Number(totals.total), approved: Number(totals.approved || 0),
                rejected: Number(totals.rejected || 0), oldest: totals.oldest,
            },
            sync: sync || null,
        });
    } catch (err) {
        logger.error('[JoinRequestsAPI] list failed', { error: err.message, guildId: req.params.guildId });
        res.status(500).json({ success: false, error: 'Could not load applications' });
    }
});

/** GET /export.csv — every row matching the current filters. */
router.get('/export.csv', async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const { sql, params } = buildFilter(guildId, req.query);
        const [rows] = await pool.execute(
            `SELECT * FROM guild_join_requests WHERE ${sql} ORDER BY reviewed_at DESC`, params
        );
        const cell = (v) => {
            const s = v === null || v === undefined ? '' : String(v);
            // Leading = + - @ would run as a formula in a spreadsheet.
            const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
            return `"${safe.replace(/"/g, '""')}"`;
        };
        const iso = (d) => d ? new Date(d).toISOString() : '';
        const labels = [];
        const parsed = rows.map(r => {
            let a = [];
            try { a = JSON.parse(r.form_responses || '[]'); } catch { /* none */ }
            for (const x of a) if (!labels.includes(x.label)) labels.push(x.label);
            return { r, a };
        });
        const head = ['Decided (UTC)', 'Status', 'Applicant', 'Applicant ID', 'Decided By', 'Decided By ID',
            'Applied (UTC)', 'Rejection Reason', ...labels, 'Request ID'];
        const lines = [head.map(cell).join(',')];
        for (const { r, a } of parsed) {
            const byLabel = new Map(a.map(x => [x.label, answerText(x)]));
            lines.push([
                iso(r.reviewed_at), r.status, r.username, r.user_id, r.actioned_by_name, r.actioned_by_id,
                iso(r.applied_at), r.rejection_reason, ...labels.map(l => byLabel.get(l)), r.request_id,
            ].map(cell).join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="join-applications-${guildId}.csv"`);
        res.send('﻿' + lines.join('\r\n'));
    } catch (err) {
        logger.error('[JoinRequestsAPI] export failed', { error: err.message, guildId: req.params.guildId });
        res.status(500).json({ success: false, error: 'Export failed' });
    }
});

/** POST /sync — pull from Discord now (first call backfills the full history, silently). */
router.post('/sync', async (req, res) => {
    const guild = req.botClient?.guilds?.cache?.get(req.params.guildId);
    if (!guild) return res.status(404).json({ success: false, error: 'Bot is not in this server' });
    try {
        const added = await syncGuild(guild);
        res.json({ success: true, added });
    } catch (err) {
        logger.warn(`[JoinRequestsAPI] sync failed for ${guild.id}: ${err.message}`);
        res.status(502).json({ success: false, error: `Discord refused the request: ${err.message}` });
    }
});

export default router;
