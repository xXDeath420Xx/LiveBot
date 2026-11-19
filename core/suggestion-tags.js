/*
 * Suggestion tags: per-guild labels (suggestion_tags) attached to suggestions
 * (suggestion_tag_assignments). Admins manage the tag list; staff tag suggestions; the tags show
 * on the suggestion's embed (and as forum tags of the same name when the suggestion is a forum
 * post), and both /engage suggest list and the dashboard can filter by tag.
 *
 * Used by commands/community/engage-suggest-handler.js, dashboard/routes/features/suggestion-tags.js
 * and the dashboard 'suggestions' page loader.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import {
    MAX_TAGS_PER_GUILD, MAX_TAGS_PER_SUGGESTION, DEFAULT_TAG_COLOR,
    normaliseTagName, normaliseTagColor, normaliseTagEmoji, normaliseFilters,
} from './suggestion-tag-helpers.js';

/** Error whose message is safe to show to the person who caused it. */
export class TagError extends Error {}

export async function listTags(guildId) {
    const [rows] = await pool.execute(
        `SELECT t.id, t.tag_name, t.tag_color, t.tag_emoji,
                (SELECT COUNT(*) FROM suggestion_tag_assignments a WHERE a.tag_id = t.id) AS usage_count
           FROM suggestion_tags t
          WHERE t.guild_id = ?
          ORDER BY t.tag_name`,
        [guildId]
    );
    return rows.map((r) => ({ ...r, tag_id: r.id, tag_emoji: r.tag_emoji === '?️' ? '' : (r.tag_emoji || '') }));
}

/** Tag by id or (case-insensitive) name, scoped to the guild. */
export async function findTag(guildId, nameOrId) {
    if (nameOrId == null || nameOrId === '') return null;
    const raw = String(nameOrId).trim();
    const [rows] = /^\d+$/.test(raw)
        ? await pool.execute('SELECT * FROM suggestion_tags WHERE guild_id = ? AND (id = ? OR tag_name = ?) ORDER BY id = ? DESC LIMIT 1', [guildId, Number(raw), raw, Number(raw)])
        : await pool.execute('SELECT * FROM suggestion_tags WHERE guild_id = ? AND tag_name = ? LIMIT 1', [guildId, normaliseTagName(raw) || raw]);
    return rows[0] || null;
}

export async function createTag(guildId, { name, color, emoji }, userId = null) {
    const tagName = normaliseTagName(name);
    if (!tagName) throw new TagError('Tag names must be 1-50 characters.');
    const tagColor = color ? normaliseTagColor(color) : DEFAULT_TAG_COLOR;
    if (!tagColor) throw new TagError('Colour must be a hex code like `#3498db`.');
    const tagEmoji = normaliseTagEmoji(emoji);
    if (tagEmoji === null) throw new TagError('Emoji must be a single emoji (or a custom server emoji).');

    const [[{ n }]] = await pool.execute('SELECT COUNT(*) AS n FROM suggestion_tags WHERE guild_id = ?', [guildId]);
    if (Number(n) >= MAX_TAGS_PER_GUILD) throw new TagError(`A server can have at most ${MAX_TAGS_PER_GUILD} suggestion tags.`);

    try {
        const [result] = await pool.execute(
            'INSERT INTO suggestion_tags (guild_id, tag_name, tag_color, tag_emoji, created_by) VALUES (?, ?, ?, ?, ?)',
            [guildId, tagName, tagColor, tagEmoji || null, userId]
        );
        logger.info('[SuggestionTags] Tag created', { guildId, tagId: result.insertId, tagName });
        return { id: result.insertId, tag_name: tagName, tag_color: tagColor, tag_emoji: tagEmoji };
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') throw new TagError(`A tag called **${tagName}** already exists.`);
        throw err;
    }
}

export async function updateTag(guildId, tagId, { name, color, emoji }) {
    const sets = [];
    const params = [];
    if (name !== undefined && name !== null && name !== '') {
        const tagName = normaliseTagName(name);
        if (!tagName) throw new TagError('Tag names must be 1-50 characters.');
        sets.push('tag_name = ?'); params.push(tagName);
    }
    if (color !== undefined && color !== null && color !== '') {
        const tagColor = normaliseTagColor(color);
        if (!tagColor) throw new TagError('Colour must be a hex code like `#3498db`.');
        sets.push('tag_color = ?'); params.push(tagColor);
    }
    if (emoji !== undefined && emoji !== null) {
        const tagEmoji = normaliseTagEmoji(emoji);
        if (tagEmoji === null) throw new TagError('Emoji must be a single emoji (or a custom server emoji).');
        sets.push('tag_emoji = ?'); params.push(tagEmoji || null);
    }
    if (!sets.length) throw new TagError('Nothing to change — give a new name, colour or emoji.');
    try {
        const [result] = await pool.execute(
            `UPDATE suggestion_tags SET ${sets.join(', ')} WHERE id = ? AND guild_id = ?`,
            [...params, tagId, guildId]
        );
        if (!result.affectedRows) throw new TagError('Tag not found.');
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') throw new TagError('Another tag already has that name.');
        throw err;
    }
    return suggestionIdsForTag(tagId);
}

/** Delete a tag (assignments cascade). Returns the suggestion ids that carried it, for embed refresh. */
export async function deleteTag(guildId, tagId) {
    const affected = await suggestionIdsForTag(tagId);
    const [result] = await pool.execute('DELETE FROM suggestion_tags WHERE id = ? AND guild_id = ?', [tagId, guildId]);
    if (!result.affectedRows) throw new TagError('Tag not found.');
    logger.info('[SuggestionTags] Tag deleted', { guildId, tagId, suggestions: affected.length });
    return affected;
}

async function suggestionIdsForTag(tagId) {
    const [rows] = await pool.execute('SELECT suggestion_id FROM suggestion_tag_assignments WHERE tag_id = ?', [tagId]);
    return rows.map((r) => r.suggestion_id);
}

async function assertSuggestion(guildId, suggestionId) {
    const [rows] = await pool.execute('SELECT id FROM suggestions WHERE id = ? AND guild_id = ?', [suggestionId, guildId]);
    if (!rows.length) throw new TagError(`Suggestion #${suggestionId} not found.`);
}

/** Returns true if the tag was added, false if it was already there. */
export async function assignTag(guildId, suggestionId, tagId, userId = null) {
    await assertSuggestion(guildId, suggestionId);
    const [tagRows] = await pool.execute('SELECT id FROM suggestion_tags WHERE id = ? AND guild_id = ?', [tagId, guildId]);
    if (!tagRows.length) throw new TagError('Tag not found.');

    const [[{ n }]] = await pool.execute('SELECT COUNT(*) AS n FROM suggestion_tag_assignments WHERE suggestion_id = ?', [suggestionId]);
    if (Number(n) >= MAX_TAGS_PER_SUGGESTION) {
        const [existing] = await pool.execute('SELECT 1 FROM suggestion_tag_assignments WHERE suggestion_id = ? AND tag_id = ?', [suggestionId, tagId]);
        if (existing.length) return false;
        throw new TagError(`A suggestion can carry at most ${MAX_TAGS_PER_SUGGESTION} tags.`);
    }
    const [result] = await pool.execute(
        'INSERT IGNORE INTO suggestion_tag_assignments (suggestion_id, tag_id, assigned_by) VALUES (?, ?, ?)',
        [suggestionId, tagId, userId]
    );
    return result.affectedRows > 0;
}

/** Returns true if the tag was removed, false if it was not on the suggestion. */
export async function unassignTag(guildId, suggestionId, tagId) {
    await assertSuggestion(guildId, suggestionId);
    const [result] = await pool.execute(
        `DELETE a FROM suggestion_tag_assignments a
           JOIN suggestion_tags t ON t.id = a.tag_id AND t.guild_id = ?
          WHERE a.suggestion_id = ? AND a.tag_id = ?`,
        [guildId, suggestionId, tagId]
    );
    return result.affectedRows > 0;
}

export async function getTagsForSuggestion(suggestionId) {
    return (await getTagsForSuggestions([suggestionId])).get(Number(suggestionId)) || [];
}

/** Map suggestionId -> [{ id, tag_name, tag_color, tag_emoji }]. */
export async function getTagsForSuggestions(ids) {
    const map = new Map();
    const list = [...new Set(ids.map(Number).filter(Number.isFinite))];
    if (!list.length) return map;
    const [rows] = await pool.query(
        `SELECT a.suggestion_id, t.id, t.tag_name, t.tag_color, t.tag_emoji
           FROM suggestion_tag_assignments a
           JOIN suggestion_tags t ON t.id = a.tag_id
          WHERE a.suggestion_id IN (?)
          ORDER BY t.tag_name`,
        [list]
    );
    for (const r of rows) {
        const key = Number(r.suggestion_id);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({
            id: r.id, tag_name: r.tag_name, tag_color: r.tag_color || DEFAULT_TAG_COLOR,
            tag_emoji: r.tag_emoji === '?️' ? '' : (r.tag_emoji || ''),
        });
    }
    return map;
}

/**
 * Suggestions for the dashboard list, filtered by status / tag and sorted, each with its tags.
 * `query` is the raw request query; anything unrecognised is ignored rather than trusted.
 */
export async function listSuggestionsForDashboard(guildId, query = {}, { guild = null, limit = 50 } = {}) {
    const { status, tagId, sort } = normaliseFilters(query);
    const where = ['s.guild_id = ?'];
    const params = [guildId];
    if (status) {
        where.push('s.status = ?');
        params.push(status);
    }
    if (tagId) {
        where.push(`EXISTS (SELECT 1 FROM suggestion_tag_assignments a JOIN suggestion_tags t ON t.id = a.tag_id
                            WHERE a.suggestion_id = s.id AND t.id = ? AND t.guild_id = ?)`);
        params.push(tagId, guildId);
    }
    const order = sort === 'oldest'
        ? 's.created_at ASC'
        : sort === 'most_voted'
            ? '(COALESCE(s.upvotes, 0) - COALESCE(s.downvotes, 0)) DESC, s.created_at DESC'
            : 's.created_at DESC';
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);

    const [rows] = await pool.execute(
        `SELECT s.id, s.suggestion_text, s.user_id, s.is_anonymous, s.status, s.upvotes, s.downvotes,
                s.staff_response, s.created_at
           FROM suggestions s
          WHERE ${where.join(' AND ')}
          ORDER BY ${order}
          LIMIT ${cap}`,
        params
    );
    const tags = await getTagsForSuggestions(rows.map((r) => r.id));
    return rows.map((r) => {
        const member = guild?.members?.cache?.get(String(r.user_id));
        const user = member?.user || guild?.client?.users?.cache?.get(String(r.user_id));
        return {
            ...r,
            upvotes: Number(r.upvotes) || 0,
            downvotes: Number(r.downvotes) || 0,
            author_name: member?.displayName || user?.globalName || user?.username || null,
            tags: tags.get(Number(r.id)) || [],
        };
    });
}

export { normaliseFilters };

export default {
    TagError, listTags, findTag, createTag, updateTag, deleteTag, assignTag, unassignTag,
    getTagsForSuggestion, getTagsForSuggestions, listSuggestionsForDashboard, normaliseFilters,
};
