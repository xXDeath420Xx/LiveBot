/*
 * Suggestion tag management for the dashboard's Suggestions page (partials/manage/suggestions.ejs).
 *
 * Mounted at '/manage/:guildId' behind checkAuth + checkGuildAdmin (see the integration patch in
 * dashboard/server.js), so every route here is already guild-scoped and admin-only; the guild id
 * from the URL is still passed into every query so a tag or suggestion id from another guild
 * simply is not found.
 *
 * Plain form POSTs that redirect back to the page the admin was on (filters preserved).
 */
import express from 'express';
import logger from '../../../utils/logger.js';
import {
    TagError, createTag, updateTag, deleteTag, assignTag, unassignTag,
} from '../../../core/suggestion-tags.js';
import SuggestionManager from '../../../core/suggestion-manager.js';

const router = express.Router({ mergeParams: true });

/** Back to the Suggestions page — the referring URL if it is this guild's page, else the default. */
function backTo(req, flag) {
    const guildId = req.params.guildId;
    let target = `/manage/${guildId}?page=suggestions`;
    try {
        const ref = req.get('referer');
        if (ref) {
            const url = new URL(ref, 'http://local');
            if (url.pathname === `/manage/${guildId}` && url.searchParams.get('page') === 'suggestions') {
                url.searchParams.delete('success');
                url.searchParams.delete('error');
                target = `${url.pathname}?${url.searchParams.toString()}`;
            }
        }
    } catch {
        // malformed referer — fall back to the default page
    }
    return `${target}&${flag}`;
}

/** Re-render the Tags field on the affected suggestion messages, after the response is sent. */
function refreshEmbeds(guildId, suggestionIds) {
    const ids = [...new Set(suggestionIds.map(Number))].filter(Number.isFinite).slice(0, 25);
    if (!ids.length) return;
    const client = globalThis.botManager?.getClientForGuild?.(guildId);
    const guild = client?.guilds?.cache?.get(guildId);
    if (!guild) return;
    const manager = new SuggestionManager(client);
    (async () => {
        for (const id of ids) await manager.refreshTags(guild, id);
    })().catch((err) => logger.warn('[SuggestionTags] Embed refresh failed', { guildId, error: err.message }));
}

function fail(req, res, err, what) {
    if (err instanceof TagError) {
        return res.redirect(backTo(req, `error=${encodeURIComponent(err.message.replace(/[*`]/g, ''))}`));
    }
    logger.error(`[SuggestionTags] ${what} failed`, { guildId: req.params.guildId, error: err.message });
    return res.redirect(backTo(req, 'error=tags'));
}

function intParam(v) {
    return /^\d{1,10}$/.test(String(v ?? '')) ? Number(v) : null;
}

router.post('/suggestions/tags/create', async (req, res) => {
    try {
        const { tag_name, tag_color, tag_emoji } = req.body || {};
        await createTag(req.params.guildId, { name: tag_name, color: tag_color, emoji: tag_emoji }, req.user?.id || null);
        res.redirect(backTo(req, 'success=tag_created'));
    } catch (err) {
        fail(req, res, err, 'create');
    }
});

router.post('/suggestions/tags/:tagId/update', async (req, res) => {
    try {
        const tagId = intParam(req.params.tagId);
        if (!tagId) throw new TagError('Tag not found.');
        const { tag_name, tag_color, tag_emoji } = req.body || {};
        const affected = await updateTag(req.params.guildId, tagId, {
            name: tag_name, color: tag_color, emoji: tag_emoji ?? undefined,
        });
        refreshEmbeds(req.params.guildId, affected);
        res.redirect(backTo(req, 'success=tag_updated'));
    } catch (err) {
        fail(req, res, err, 'update');
    }
});

router.post('/suggestions/tags/:tagId/delete', async (req, res) => {
    try {
        const tagId = intParam(req.params.tagId);
        if (!tagId) throw new TagError('Tag not found.');
        const affected = await deleteTag(req.params.guildId, tagId);
        refreshEmbeds(req.params.guildId, affected);
        res.redirect(backTo(req, 'success=tag_deleted'));
    } catch (err) {
        fail(req, res, err, 'delete');
    }
});

router.post('/suggestions/:suggestionId/tags', async (req, res) => {
    try {
        const suggestionId = intParam(req.params.suggestionId);
        const tagId = intParam(req.body?.tag_id);
        if (!suggestionId || !tagId) throw new TagError('Pick a tag to add.');
        const changed = await assignTag(req.params.guildId, suggestionId, tagId, req.user?.id || null);
        if (changed) refreshEmbeds(req.params.guildId, [suggestionId]);
        res.redirect(backTo(req, 'success=tag_assigned'));
    } catch (err) {
        fail(req, res, err, 'assign');
    }
});

router.post('/suggestions/:suggestionId/tags/:tagId/remove', async (req, res) => {
    try {
        const suggestionId = intParam(req.params.suggestionId);
        const tagId = intParam(req.params.tagId);
        if (!suggestionId || !tagId) throw new TagError('Tag not found.');
        const changed = await unassignTag(req.params.guildId, suggestionId, tagId);
        if (changed) refreshEmbeds(req.params.guildId, [suggestionId]);
        res.redirect(backTo(req, 'success=tag_removed'));
    } catch (err) {
        fail(req, res, err, 'unassign');
    }
});

export default router;
