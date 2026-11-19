/**
 * Twitch roles manager — dashboard endpoints for broadcaster VIP / mod add + remove.
 * All actions require Discord session + guild admin + a Tier B grant that includes the
 * relevant scope. Audit-logged via core/twitch-write.js \u2192 twitch_action_audit_log.
 */
import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { checkAuth, checkGuildAdmin } from '../middleware/auth.js';
import { addVip, removeVip, addModerator, removeModerator, resolveTwitchLogin } from '../../core/twitch-write.js';

const router = express.Router();

async function resolveBroadcasterForGuild(guildId) {
    const [[row]] = await pool.execute(
        `SELECT broadcaster_twitch_id, broadcaster_twitch_username
           FROM twitch_role_sync_config
          WHERE guild_id = ? AND enabled = 1 AND broadcaster_twitch_id IS NOT NULL
          LIMIT 1`, [guildId]);
    return row || null;
}

async function handleRoleOp(req, res, op, role) {
    const guildId = req.params.guildId;
    const directUserId = String(req.body?.user_id || '').trim();
    const login = String(req.body?.user_login || req.body?.login || '').trim();
    if (!directUserId && !login) return res.status(400).json({ ok: false, error: 'user_id or user_login required' });

    const bc = await resolveBroadcasterForGuild(guildId);
    if (!bc) return res.status(400).json({ ok: false, error: 'no broadcaster bound to this guild' });

    // Prefer direct user_id when supplied (works for platform-banned Twitch users whose
    // login no longer resolves via /users). Fall back to login lookup for the add flow.
    let targetId, targetLabel;
    if (/^\d+$/.test(directUserId)) {
        targetId = directUserId;
        targetLabel = login || directUserId;
    } else {
        const lookup = await resolveTwitchLogin(bc.broadcaster_twitch_id, login);
        if (!lookup.ok) return res.status(400).json({ ok: false, error: lookup.error });
        targetId = lookup.user.id;
        targetLabel = lookup.user.login;
    }

    const actor = {
        triggeredByDiscordId: req.user?.id || null,
        triggeredByDiscordUsername: req.user?.username || null,
        guildId,
    };

    let fn;
    if (role === 'vip' && op === 'add') fn = addVip;
    else if (role === 'vip' && op === 'remove') fn = removeVip;
    else if (role === 'mod' && op === 'add') fn = addModerator;
    else if (role === 'mod' && op === 'remove') fn = removeModerator;
    else return res.status(400).json({ ok: false, error: 'invalid role/op' });

    const result = await fn(bc.broadcaster_twitch_id, targetId, actor);
    if (!result.ok) {
        logger.warn('[TwitchRolesManage] op failed', { guildId, op, role, targetLabel, err: result.error });
        return res.status(result.status >= 400 && result.status < 600 ? result.status : 500).json({
            ok: false, error: result.error, scope_missing: result.scope || null,
        });
    }
    logger.info('[TwitchRolesManage] op ok', { guildId, op, role, targetLabel, actor: actor.triggeredByDiscordUsername });
    return res.json({ ok: true, user: { id: targetId, login: targetLabel, display_name: targetLabel } });
}

router.post('/manage/:guildId/twitch-roles/vip/add',    checkAuth, checkGuildAdmin, (req, res) => handleRoleOp(req, res, 'add',    'vip'));
router.post('/manage/:guildId/twitch-roles/vip/remove', checkAuth, checkGuildAdmin, (req, res) => handleRoleOp(req, res, 'remove', 'vip'));
router.post('/manage/:guildId/twitch-roles/mod/add',    checkAuth, checkGuildAdmin, (req, res) => handleRoleOp(req, res, 'add',    'mod'));
router.post('/manage/:guildId/twitch-roles/mod/remove', checkAuth, checkGuildAdmin, (req, res) => handleRoleOp(req, res, 'remove', 'mod'));

export default router;
