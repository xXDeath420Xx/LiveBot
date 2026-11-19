/**
 * Server Onboarding API — thin wrapper on top of Discord's
 * `/guilds/{id}/onboarding` endpoint via discord.js's `guild.fetchOnboarding()`
 * and `guild.editOnboarding()`.
 *
 * The dashboard reads the current configuration (prompts, default channels,
 * enabled state) and can toggle the enabled flag + default channel list from
 * the UI. Prompt authoring remains in Discord's native UI — rebuilding that
 * whole surface would duplicate hundreds of lines of their logic without a
 * clear win over "click the Discord-provided panel".
 *
 * All routes gated by `apiCheckGuildAdmin` at the parent router.
 */
import express from 'express';
import { PermissionFlagsBits, GuildOnboardingMode } from 'discord.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;

const MODE_LABEL = {
    [GuildOnboardingMode.OnboardingDefault]: 'DEFAULT',
    [GuildOnboardingMode.OnboardingAdvanced]: 'ADVANCED',
};

const PROMPT_TYPE_LABEL = { 0: 'MULTIPLE_CHOICE', 1: 'DROPDOWN' };

/** Normalize anything (Collection, Map, Array, iterable, nullish) to a plain Array. */
function toArray(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v.values === 'function') return [...v.values()];
    if (typeof v[Symbol.iterator] === 'function') return [...v];
    return [];
}

function serialiseOnboarding(ob) {
    const prompts = toArray(ob.prompts);
    const defaultChannels = toArray(ob.defaultChannels);
    return {
        guildId: ob.guildId ?? ob.guild?.id ?? null,
        enabled: ob.enabled,
        mode: ob.mode,
        modeName: MODE_LABEL[ob.mode] ?? String(ob.mode),
        defaultChannelIds: defaultChannels.map(c => c?.id ?? c),
        prompts: prompts.map(p => ({
            id: p.id,
            type: p.type,
            typeName: PROMPT_TYPE_LABEL[p.type] ?? String(p.type),
            title: p.title,
            inOnboarding: p.inOnboarding,
            singleSelect: p.singleSelect,
            required: p.required,
            options: toArray(p.options).map(o => ({
                id: o.id,
                title: o.title,
                description: o.description,
                emoji: o.emoji ? { name: o.emoji.name, id: o.emoji.id, animated: !!o.emoji.animated } : null,
                roleIds: toArray(o.roles).map(r => r?.id ?? r),
                channelIds: toArray(o.channels).map(c => c?.id ?? c),
            })),
        })),
    };
}

function requireManageGuild(req, res) {
    const me = req.guildObject?.members?.me;
    if (!me?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
        res.status(403).json({ error: 'The bot is missing Manage Server; onboarding cannot be read or changed.' });
        return false;
    }
    return true;
}

/** GET / — read current onboarding configuration. */
router.get('/', async (req, res) => {
    try {
        if (!requireManageGuild(req, res)) return;
        const ob = await req.guildObject.fetchOnboarding();
        res.json({
            onboarding: serialiseOnboarding(ob),
            modes: MODE_LABEL,
            promptTypes: PROMPT_TYPE_LABEL,
        });
    } catch (err) {
        logger.error('[API onboarding GET] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to fetch onboarding' });
    }
});

/**
 * PATCH / — toggle enabled flag, mode, or default channels. Prompt editing is
 * deferred to Discord's native UI; this only edits the three top-level knobs.
 */
router.patch('/', async (req, res) => {
    try {
        if (!requireManageGuild(req, res)) return;
        const patch = {};
        if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
        if (req.body?.mode !== undefined) {
            const m = Number(req.body.mode);
            if (![GuildOnboardingMode.OnboardingDefault, GuildOnboardingMode.OnboardingAdvanced].includes(m)) {
                return res.status(400).json({ error: 'mode must be 0 (DEFAULT) or 1 (ADVANCED).' });
            }
            patch.mode = m;
        }
        if (Array.isArray(req.body?.defaultChannelIds)) {
            const ids = req.body.defaultChannelIds.filter(id => SNOWFLAKE.test(String(id)));
            if (ids.length > 50) return res.status(400).json({ error: 'A guild can have at most 50 default channels.' });
            // discord.js wants Snowflake[]; the manager resolves them.
            patch.defaultChannels = ids;
        }
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to patch.' });
        if (req.body?.reason) patch.reason = String(req.body.reason).slice(0, 512);

        const edited = await req.guildObject.editOnboarding(patch);
        logger.info('[API onboarding PATCH] updated', {
            guildId: req.params.guildId, keys: Object.keys(patch), by: req.user?.id,
        });
        res.json({ success: true, onboarding: serialiseOnboarding(edited) });
    } catch (err) {
        if (err?.code === 50013) return res.status(403).json({ error: 'Discord refused — the bot lacks Manage Server here.' });
        logger.error('[API onboarding PATCH] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to update onboarding' });
    }
});

export default router;
