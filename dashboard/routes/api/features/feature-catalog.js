/**
 * Feature catalog switches (dashboard ?page=catalog).
 *
 * Mounted at /api/guilds/:guildId/feature-catalog (behind apiCheckAuth + apiCheckGuildAdmin).
 *
 *   POST /:key   { enabled: true|false }  turn one feature on or off
 *
 * How each feature is switched — through its own master switch, or the guild_feature_flags flag
 * when it has none — is decided by SWITCHES in core/feature-flags.js (setFeatureState). The reply
 * carries the feature's new catalog state so the page can update in place.
 */
import express from 'express';
import logger from '../../../../utils/logger.js';
import { catalogFor, setFeatureState } from '../../../../core/feature-flags.js';

const router = express.Router({ mergeParams: true });

const KEY = /^[a-z0-9_]{1,64}$/;

router.post('/:key', async (req, res) => {
    const { guildId, key } = req.params;
    if (!KEY.test(key)) return res.status(400).json({ ok: false, error: 'Unknown feature.' });
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'enabled must be true or false.' });

    try {
        const result = await setFeatureState(guildId, key, enabled, req.user?.id || null);
        if (!result.ok) {
            return res.status(result.status || 400).json({ ok: false, error: result.error, needsSetup: Boolean(result.needsSetup) });
        }
        const catalog = await catalogFor(guildId);
        const f = catalog.find((x) => x.key === key);
        logger.info(`[FeatureCatalog] ${key} turned ${enabled ? 'on' : 'off'} in ${guildId} by ${req.user?.id || 'unknown'}`);
        return res.json({
            ok: true,
            feature: f ? {
                key: f.key,
                active: f.active,
                configured: f.configured,
                explicitFlag: f.explicitFlag,
                control: f.control,
                canEnableFromNothing: f.canEnableFromNothing,
            } : null,
            totals: { active: catalog.filter((x) => x.active).length, total: catalog.length },
        });
    } catch (err) {
        logger.error(`[FeatureCatalog] switching ${key} in ${guildId} failed: ${err.message}`);
        return res.status(500).json({ ok: false, error: 'Could not change that feature. Try again.' });
    }
});

export default router;
