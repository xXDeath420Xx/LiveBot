/*
 * Where member bug reports go (dashboard Bug reports page, feature 'bugs').
 *
 *   enabled            "Accept bug reports" — off: /engage report bug and the forum "Report a bug"
 *                      button refuse before the form opens.
 *   report_channel_id  "Post new reports to" — falls back to the older suggestion-page setting
 *                      (suggestion_config.bug_report_channel_id), so servers set up there keep working.
 *   triage_role_id     "Role to ping for a new report" — pinged on the posted report.
 *
 * Used by commands/community/engage-report-handler.js and interactions/modals/forum_submit_handlers.js
 * (+ interactions/buttons/forum_submit.js).
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getConfig as getFeatureConfig } from './feature-config.js';

export const BUG_REPORTS_OFF = 'Bug reports are turned off in this server.';

function isOn(v) {
    return !(v === 0 || v === false || v === '0');
}

/** @returns {Promise<{accepting:boolean, channelId:string|null, triageRoleId:string|null}>} */
export async function getBugReportSettings(guildId) {
    const cfg = await getFeatureConfig('bugs', guildId);
    let channelId = cfg.report_channel_id ? String(cfg.report_channel_id) : null;
    if (!channelId) {
        try {
            const [rows] = await pool.execute('SELECT bug_report_channel_id FROM suggestion_config WHERE guild_id = ?', [guildId]);
            channelId = rows[0]?.bug_report_channel_id ? String(rows[0].bug_report_channel_id) : null;
        } catch (err) {
            logger.warn(`[BugReports] Could not read the suggestion-page bug channel for ${guildId}: ${err.message}`);
        }
    }
    return {
        accepting: isOn(cfg.enabled),
        channelId,
        triageRoleId: cfg.triage_role_id ? String(cfg.triage_role_id) : null,
    };
}

/**
 * Message fields that ping the triage role (only a role that still exists in the guild), to merge
 * into a send / thread starter payload. Mentions nothing else.
 */
export function triagePing(guild, triageRoleId) {
    if (!triageRoleId || !guild?.roles?.cache?.has?.(triageRoleId)) return { allowedMentions: { parse: [] } };
    return { content: `<@&${triageRoleId}>`, allowedMentions: { parse: [], roles: [triageRoleId] } };
}

export default { getBugReportSettings, triagePing, BUG_REPORTS_OFF };
