/**
 * Per-channel defender settings with fallback to the engine's historical
 * hardcoded defaults. An absent kbd_channel_settings row (or any DB error)
 * yields DEFAULTS, so unconfigured channels behave exactly as before.
 */
import realPool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

export const DEFAULTS = Object.freeze({
    banDurationMin: null, // null = permanent ban (current behavior)
    phishingThreshold: 2, // enforcer.js used `count >= 2`
    warningTemplate: '@{{username}} posted a known scam link and it was removed. Repeat offenses = ban.',
    safeDomains: []       // per-channel ADDITIONS to the global safe list
});

export function makeGetChannelSettings({ pool }) {
    return async function getChannelSettings(channelId) {
        try {
            const [[row]] = await pool.execute(
                'SELECT ban_duration_min, phishing_threshold, warning_template, safe_domains FROM kbd_channel_settings WHERE channel_id = ?',
                [String(channelId)]
            );
            if (!row) return { ...DEFAULTS, safeDomains: [] };
            return {
                banDurationMin: row.ban_duration_min ?? DEFAULTS.banDurationMin,
                phishingThreshold: Number.isInteger(row.phishing_threshold) ? row.phishing_threshold : DEFAULTS.phishingThreshold,
                warningTemplate: row.warning_template || DEFAULTS.warningTemplate,
                safeDomains: row.safe_domains ? String(row.safe_domains).split(',').map(s => s.trim()).filter(Boolean) : []
            };
        } catch (error) {
            logger.warn('[KBD] getChannelSettings failed; using defaults', { channelId, error: error.message });
            return { ...DEFAULTS, safeDomains: [] };
        }
    };
}

export const getChannelSettings = makeGetChannelSettings({ pool: realPool });
