/**
 * Monthly integrity snapshots. Every 30 days after a channel was connected (twitch_role_sync_config.created_at)
 * the bot renders that channel's 30-day integrity report and DMs the PDF + PNG to the bot owner.
 *
 * twitch_integrity_snapshots_sent is the ledger: one row per (broadcaster, period), so a restart or an
 * overlapping scan can never send the same period twice. A mark missed by more than a day (bot down,
 * or a channel connected long before this feature existed) is skipped and the next mark is used.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { SUPER_ADMIN_ID } from '../utils/constants.js';
import { getGuildTimezone, isIanaTimezone } from '../utils/guild-timezone.js';
import { buildIntegrityReport, renderIntegrityFiles } from './twitch-integrity-report.js';

const LOG = '[IntegritySnapshots]';
const DAY_MS = 24 * 60 * 60 * 1000;
export const PERIOD_DAYS = 30;
const PERIOD_MS = PERIOD_DAYS * DAY_MS;
const GRACE_MS = DAY_MS;
const MAX_ATTEMPTS = 3;
const DISCORD_FILE_LIMIT = 9.5 * 1024 * 1024;

const fmtDate = (ms, tz = 'UTC') => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz });

/** Which 30-day mark (if any) is due for a channel right now. */
export function duePeriod(connectedAt, now = Date.now()) {
    const anchor = new Date(connectedAt).getTime();
    if (!Number.isFinite(anchor)) return null;
    const n = Math.floor((now - anchor) / PERIOD_MS);
    if (n < 1) return null;
    const dueAt = anchor + n * PERIOD_MS;
    if (now - dueAt > GRACE_MS) return null;
    return { n, dueAt, anchor };
}

// The report's chat indicators need the chatter list and chat feed. A VIP-sync-only grant has neither.
const REQUIRED_SCOPES = ['moderator:read:chatters', 'user:read:chat'];

/**
 * Only channels that granted the analytics scopes and that we actually captured live in this period.
 * An empty report (dead token, never streamed, VIP-sync-only connection) is not worth a DM.
 */
async function isEligible(cfg, { dueAt }) {
    const scopes = new Set(String(cfg.token_scopes || '').split(/\s+/));
    if (!REQUIRED_SCOPES.every(s => scopes.has(s))) return false;
    const since = new Date(dueAt - PERIOD_MS);
    const [[s]] = await pool.query(
        'SELECT COUNT(*) AS n FROM twitch_stream_sessions WHERE broadcaster_id = ? AND started_at >= ?',
        [String(cfg.broadcaster_twitch_id), since]);
    const [[c]] = await pool.query(
        'SELECT COUNT(*) AS n FROM twitch_chatters_snapshots WHERE broadcaster_id = ? AND recorded_at >= ?',
        [String(cfg.broadcaster_twitch_id), since]);
    return s.n > 0 && c.n > 0;
}

/** Render one channel's snapshot and DM it to the owner. Throws on failure. */
export async function sendIntegritySnapshot(cfg, { n, dueAt, anchor }, { label = null } = {}) {
    const client = globalThis.botManager?.getDefaultClient?.();
    if (!client) throw new Error('no Discord client');
    if (!SUPER_ADMIN_ID) throw new Error('BOT_OWNER_ID not set');
    const owner = await client.users.fetch(SUPER_ADMIN_ID);

    const bid = String(cfg.broadcaster_twitch_id);
    const login = cfg.broadcaster_twitch_username || bid;
    const report = await buildIntegrityReport(bid, { days: PERIOD_DAYS });
    const rawTz = await getGuildTimezone(cfg.guild_id);
    const tz = isIanaTimezone(rawTz) ? rawTz : 'UTC';
    const files = await renderIntegrityFiles(report, { login, guildId: cfg.guild_id, tz });

    const attachments = [{ attachment: files.pdf, name: `${files.baseName}.pdf` }];
    if (files.png.length <= DISCORD_FILE_LIMIT) attachments.push({ attachment: files.png, name: `${files.baseName}.png` });
    const site = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '');
    const lines = [
        `**Integrity snapshot: ${login}**${label ? ` (${label})` : ''}`,
        `Period ${n}: ${fmtDate(dueAt - PERIOD_MS, tz)} to ${fmtDate(dueAt, tz)} · connected ${fmtDate(anchor, tz)}`,
        `Viewer count: ${report.verdicts.viewers.label}`,
        `Accounts in chat: ${report.verdicts.chat.label}`,
        `Full report: ${site}/manage/${cfg.guild_id}/twitch-analytics/integrity?days=${PERIOD_DAYS}`,
    ];
    if (attachments.length < 2) lines.push('Image was over the Discord upload limit, open the link for it.');
    await owner.send({ content: lines.join('\n'), files: attachments });
}

let running = false;
export async function runIntegritySnapshots(now = Date.now()) {
    if (running) return;
    // Early boot: the default bot logs in after the first scheduler scan. Wait for the next scan
    // rather than spending one of a period's attempts.
    if (!globalThis.botManager?.getDefaultClient?.()?.isReady?.()) return;
    running = true;
    try {
        const [channels] = await pool.query(
            `SELECT guild_id, broadcaster_twitch_id, broadcaster_twitch_username, created_at, token_scopes
               FROM twitch_role_sync_config
              WHERE broadcaster_twitch_id IS NOT NULL AND broadcaster_token IS NOT NULL AND enabled = 1`);
        for (const cfg of channels) {
            const due = duePeriod(cfg.created_at, now);
            if (!due) continue;
            const bid = String(cfg.broadcaster_twitch_id);
            if (!(await isEligible(cfg, due))) continue;
            await pool.query(
                `INSERT IGNORE INTO twitch_integrity_snapshots_sent (broadcaster_id, period_n, guild_id, due_at)
                 VALUES (?, ?, ?, ?)`, [bid, due.n, cfg.guild_id, new Date(due.dueAt)]);
            const [[row]] = await pool.query(
                'SELECT sent_at, attempts FROM twitch_integrity_snapshots_sent WHERE broadcaster_id = ? AND period_n = ?', [bid, due.n]);
            if (row.sent_at || row.attempts >= MAX_ATTEMPTS) continue;
            await pool.query(
                'UPDATE twitch_integrity_snapshots_sent SET attempts = attempts + 1 WHERE broadcaster_id = ? AND period_n = ?', [bid, due.n]);
            try {
                await sendIntegritySnapshot(cfg, due);
                await pool.query(
                    'UPDATE twitch_integrity_snapshots_sent SET sent_at = NOW(), last_error = NULL WHERE broadcaster_id = ? AND period_n = ?', [bid, due.n]);
                logger.info(`${LOG} sent period ${due.n} for ${cfg.broadcaster_twitch_username}`);
            } catch (err) {
                await pool.query(
                    'UPDATE twitch_integrity_snapshots_sent SET last_error = ? WHERE broadcaster_id = ? AND period_n = ?',
                    [String(err.message).slice(0, 500), bid, due.n]);
                logger.error(`${LOG} period ${due.n} for ${cfg.broadcaster_twitch_username} failed: ${err.message}`);
            }
        }
    } finally {
        running = false;
    }
}
