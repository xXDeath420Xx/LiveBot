/*
 * Public CertiFried Studio pages and the legal hub (no login; site frame; Dark, Light and Sand).
 *
 *   GET /studio                  what Studio is, screenshots, download, requirements
 *   GET /studio/how-it-works     dashboard, engine, Studio and OBS; pairing, VOD-safe music, voice, docks, updates
 *   GET /studio/privacy          what Studio keeps on the PC, what it sends and why (checked against desktop/studio/src)
 *   GET /studio/faq              SmartScreen, antivirus, DPAPI fallback, OBS port and password, Kick VODs, clips
 *   GET /studio/eula             301 to the Studio section of the one EULA (/eula#certifried-studio)
 *   GET /legal                   every policy, with its last update
 *   GET /legal/data              "Data we collect" for the whole of CertiFried (dashboard/content/legal/data-inventory.js)
 *
 * /legal/data reads data_retention_policy (the table jobs/retention-sweeper.js enforces) so a retention shown on the
 * page is the one actually swept; when the database cannot be read it falls back to the values written in the
 * inventory (checked against the live table on 2026-11-19 and against the migrations by tests/legal-studio-pages.test.js).
 * Cached for 10 minutes.
 */
import express from 'express';
import logger from '../../utils/logger.js';
import { CATEGORIES, LEGAL_DOCS, STUDIO_FACTS, retentionText } from '../content/legal/data-inventory.js';

const router = express.Router();
const common = (req) => ({ user: req.user || null, clientId: process.env.DASHBOARD_CLIENT_ID || process.env.DISCORD_CLIENT_ID });

const policyCache = { at: 0, map: null };
/** table_name -> { days, enabled } from data_retention_policy, or null when it cannot be read. */
export async function retentionPolicies({ now = Date.now(), load } = {}) {
    if (policyCache.map && now - policyCache.at < 10 * 60_000) return policyCache.map;
    try {
        const rows = load ? await load() : await (async () => {
            const { default: pool } = await import('../../utils/db.js');
            const [r] = await pool.query('SELECT table_name, retain_days, enabled FROM data_retention_policy');
            return r;
        })();
        const map = new Map(rows.map((r) => [String(r.table_name), { days: Number(r.retain_days), enabled: !!Number(r.enabled) }]));
        policyCache.at = now;
        policyCache.map = map;
        return map;
    } catch (err) {
        logger.warn('[Legal] could not read data_retention_policy; showing the written values', { error: err?.message });
        return null;
    }
}

router.get('/studio', (req, res) => res.render('studio-overview', { ...common(req), facts: STUDIO_FACTS }));
router.get('/studio/how-it-works', (req, res) => res.render('studio-how-it-works', { ...common(req), facts: STUDIO_FACTS }));
router.get('/studio/privacy', (req, res) => res.render('studio-privacy', { ...common(req), facts: STUDIO_FACTS }));
router.get('/studio/faq', (req, res) => res.render('studio-faq', { ...common(req), facts: STUDIO_FACTS }));
router.get('/studio/eula', (req, res) => res.redirect(301, '/eula#certifried-studio'));
router.get('/legal', (req, res) => res.render('legal-hub', { ...common(req), docs: LEGAL_DOCS }));
router.get('/legal/data', async (req, res) => {
    const live = await retentionPolicies();
    res.render('legal-data', { ...common(req), categories: CATEGORIES, retention: (row) => retentionText(row, live), liveRetention: !!live });
});

export default router;
