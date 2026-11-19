/**
 * QOTD review and queue API (the dashboard's Question of the Day page, partials/manage/_qotd-review.ejs).
 *
 *   GET    /api/guilds/:guildId/qotd/suggestions                 pending /qotd suggest entries + the server's decks
 *   POST   /api/guilds/:guildId/qotd/suggestions/:id/approve     { deck_id? } adds it as a card, marks it approved
 *   POST   /api/guilds/:guildId/qotd/suggestions/:id/deny        { note? } marks it denied
 *   GET    /api/guilds/:guildId/qotd/queue                       queued cards, the QOTD channels, the cards that can be queued
 *   POST   /api/guilds/:guildId/qotd/queue                       { channel_id, card_id } or { channel_id, content }
 *   DELETE /api/guilds/:guildId/qotd/queue/:queueId              take one entry off the queue
 *
 * Until 2026-11-18 both tables were dead ends: /qotd suggest wrote qotd_suggestions and nothing read
 * it, and core/qotd-poster.js drained qotd_queue (a queued card beats every other source) while
 * nothing could fill it. qotd_queue has no guild_id, so every queue query is scoped through
 * qotd_channels.guild_id. Cards come from the server's own decks or community decks (guild_id NULL).
 * Gated by apiCheckGuildAdmin at the parent router, like every /guilds/:guildId route.
 */
import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { userBits } from '../../../../core/user-display.js';

const router = express.Router({ mergeParams: true });
const ID = /^\d{17,20}$/;
const MAX_TEXT = 2000;
const CARD_TYPES = new Set(['question', 'fact', 'quote', 'poll', 'custom']);
const SUGGESTION_DECK = 'Member suggestions';
const DASHBOARD_DECK = 'Dashboard questions';

const posInt = (v) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const guildOf = (req) => req.guildObject || global.botManager?.getClientForGuild?.(req.params.guildId)?.guilds.cache.get(req.params.guildId) || null;

/** Decks this server can pick from: its own, then community decks. */
async function decksFor(guildId) {
    const [rows] = await pool.execute(
        `SELECT deck_id, deck_name, deck_type, card_count, guild_id IS NULL AS community
           FROM qotd_decks
          WHERE guild_id = ? OR (guild_id IS NULL AND is_community = 1)
          ORDER BY guild_id IS NULL, deck_name, deck_id`,
        [guildId]);
    return rows.map((d) => ({ deck_id: d.deck_id, deck_name: d.deck_name, deck_type: d.deck_type, card_count: d.card_count, community: !!d.community }));
}

/** The server's deck with this name, created if it does not exist yet. Runs on `conn` (inside a transaction). */
async function ensureDeck(conn, guildId, name, description, userId) {
    const [[found]] = await conn.execute('SELECT deck_id FROM qotd_decks WHERE guild_id = ? AND deck_name = ? ORDER BY deck_id LIMIT 1', [guildId, name]);
    if (found) return found.deck_id;
    const [res] = await conn.execute(
        'INSERT INTO qotd_decks (guild_id, deck_name, description, deck_type, created_by) VALUES (?, ?, ?, ?, ?)',
        [guildId, name, description, 'question', userId]);
    return res.insertId;
}

/** Same insert /qotd card add does: next position in the deck, then the deck's card_count. */
async function addCard(conn, deckId, content, cardType, userId) {
    const [[{ maxPos }]] = await conn.execute('SELECT COALESCE(MAX(position), 0) AS maxPos FROM qotd_cards WHERE deck_id = ?', [deckId]);
    const [res] = await conn.execute(
        'INSERT INTO qotd_cards (deck_id, content, card_type, position, created_by) VALUES (?, ?, ?, ?, ?)',
        [deckId, content, cardType, Number(maxPos) + 1, userId]);
    await conn.execute('UPDATE qotd_decks SET card_count = card_count + 1 WHERE deck_id = ?', [deckId]);
    return res.insertId;
}

/** A deck the server may use, or null. */
async function usableDeck(conn, guildId, deckId) {
    const [[deck]] = await conn.execute(
        'SELECT deck_id, guild_id FROM qotd_decks WHERE deck_id = ? AND (guild_id = ? OR (guild_id IS NULL AND is_community = 1))',
        [deckId, guildId]);
    return deck || null;
}

/* ------------------------------------------------------------------ suggestions */

router.get('/suggestions', async (req, res) => {
    const { guildId } = req.params;
    try {
        const [rows] = await pool.execute(
            `SELECT suggestion_id, user_id, content, suggestion_type, created_at
               FROM qotd_suggestions WHERE guild_id = ? AND status = 'pending'
              ORDER BY created_at ASC, suggestion_id ASC LIMIT 200`,
            [guildId]);
        const guild = guildOf(req);
        const [[{ reviewed }]] = await pool.execute(
            "SELECT COUNT(*) AS reviewed FROM qotd_suggestions WHERE guild_id = ? AND status <> 'pending'", [guildId]);
        res.json({
            suggestions: rows.map((r) => ({
                suggestion_id: r.suggestion_id, content: r.content, suggestion_type: r.suggestion_type || 'question',
                created_at: r.created_at, user: userBits(guild, r.user_id),
            })),
            reviewed: Number(reviewed) || 0,
            // Only the server's own decks: a suggestion must not land in a deck every server shares.
            decks: (await decksFor(guildId)).filter((d) => !d.community),
        });
    } catch (error) {
        logger.error('[QOTD API] suggestions load failed', { guildId, error: error.message });
        res.status(500).json({ error: 'Could not load the suggestions.' });
    }
});

router.post('/suggestions/:id/approve', async (req, res) => {
    const { guildId } = req.params;
    const id = posInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad suggestion.' });
    const wantDeck = req.body?.deck_id ? posInt(req.body.deck_id) : null;
    if (req.body?.deck_id && !wantDeck) return res.status(400).json({ error: 'Bad deck.' });
    const userId = req.user?.id || null;

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[s]] = await conn.execute(
            'SELECT * FROM qotd_suggestions WHERE suggestion_id = ? AND guild_id = ? FOR UPDATE', [id, guildId]);
        if (!s) { await conn.rollback(); return res.status(404).json({ error: 'That suggestion is gone.' }); }
        if (s.status !== 'pending') { await conn.rollback(); return res.status(409).json({ error: `Already ${s.status}.` }); }

        let deckId;
        if (wantDeck) {
            const [[own]] = await conn.execute('SELECT deck_id FROM qotd_decks WHERE deck_id = ? AND guild_id = ?', [wantDeck, guildId]);
            if (!own) { await conn.rollback(); return res.status(400).json({ error: 'That deck is not one of this server\'s decks.' }); }
            deckId = own.deck_id;
        } else {
            deckId = await ensureDeck(conn, guildId, SUGGESTION_DECK, 'Questions members sent with /qotd suggest and staff approved.', userId);
        }

        const content = String(s.content || '').trim().slice(0, MAX_TEXT);
        if (!content) { await conn.rollback(); return res.status(400).json({ error: 'The suggestion is empty.' }); }
        const cardType = CARD_TYPES.has(s.suggestion_type) ? s.suggestion_type : 'custom';
        const cardId = await addCard(conn, deckId, content, cardType, s.user_id);

        await conn.execute(
            `UPDATE qotd_suggestions SET status = 'approved', reviewed_by = ?, reviewed_at = NOW(), deck_id = ?, card_id = ?
              WHERE suggestion_id = ?`,
            [userId, deckId, cardId, id]);
        await conn.commit();
        logger.info('[QOTD API] suggestion approved', { guildId, suggestionId: id, deckId, cardId, by: userId });
        res.json({ ok: true, deck_id: deckId, card_id: cardId });
    } catch (error) {
        await conn.rollback().catch(() => {});
        logger.error('[QOTD API] approve failed', { guildId, suggestionId: id, error: error.message });
        res.status(500).json({ error: 'Could not approve it. Nothing was changed.' });
    } finally {
        conn.release();
    }
});

router.post('/suggestions/:id/deny', async (req, res) => {
    const { guildId } = req.params;
    const id = posInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad suggestion.' });
    const note = text(req.body?.note).slice(0, 500) || null;
    try {
        const [result] = await pool.execute(
            `UPDATE qotd_suggestions SET status = 'denied', reviewed_by = ?, reviewed_at = NOW(), review_note = ?
              WHERE suggestion_id = ? AND guild_id = ? AND status = 'pending'`,
            [req.user?.id || null, note, id, guildId]);
        if (!result.affectedRows) return res.status(409).json({ error: 'That suggestion was already reviewed or is gone.' });
        logger.info('[QOTD API] suggestion denied', { guildId, suggestionId: id, by: req.user?.id });
        res.json({ ok: true });
    } catch (error) {
        logger.error('[QOTD API] deny failed', { guildId, suggestionId: id, error: error.message });
        res.status(500).json({ error: 'Could not deny it. Nothing was changed.' });
    }
});

/* ------------------------------------------------------------------ queue */

/* qotd_queue.card_id and .channel_id cascade on delete, so a deleted card or channel takes its queue
   rows with it; that can leave gaps in position, which is why the page numbers entries itself. */
async function queueFor(guildId) {
    const [rows] = await pool.execute(
        `SELECT q.queue_id, q.channel_id, q.card_id, q.position, q.added_by, q.created_at,
                c.content, d.deck_name
           FROM qotd_queue q
           JOIN qotd_channels ch ON ch.channel_id = q.channel_id AND ch.guild_id = ?
           JOIN qotd_cards c ON c.card_id = q.card_id
           LEFT JOIN qotd_decks d ON d.deck_id = c.deck_id
          ORDER BY q.channel_id, q.position, q.queue_id`,
        [guildId]);
    return rows;
}

/** Take a row off a channel's queue and close the gap, the way core/qotd-poster.js does after posting. */
async function removeQueued(conn, row) {
    await conn.execute('DELETE FROM qotd_queue WHERE queue_id = ?', [row.queue_id]);
    await conn.execute('UPDATE qotd_queue SET position = position - 1 WHERE channel_id = ? AND position > ?', [row.channel_id, row.position]);
}

router.get('/queue', async (req, res) => {
    const { guildId } = req.params;
    try {
        const rows = await queueFor(guildId);
        const [channels] = await pool.execute(
            'SELECT channel_id, enabled FROM qotd_channels WHERE guild_id = ? ORDER BY created_at, channel_id', [guildId]);
        const decks = await decksFor(guildId);
        const deckIds = decks.map((d) => d.deck_id);
        let cards = [];
        if (deckIds.length) {
            const [c] = await pool.query(
                `SELECT card_id, deck_id, content FROM qotd_cards WHERE deck_id IN (?)
                  ORDER BY deck_id, position, card_id LIMIT 1000`, [deckIds]);
            cards = c.map((r) => ({ card_id: r.card_id, deck_id: r.deck_id, content: String(r.content || '').slice(0, 300) }));
        }
        const guild = guildOf(req);
        res.json({
            queue: rows.map((r) => ({
                queue_id: r.queue_id, channel_id: r.channel_id, card_id: r.card_id, position: r.position,
                content: r.content, deck_name: r.deck_name, created_at: r.created_at,
                added_by: r.added_by ? userBits(guild, r.added_by) : null,
            })),
            channels: channels.map((c) => ({ channel_id: c.channel_id, enabled: !!c.enabled })),
            decks,
            cards,
        });
    } catch (error) {
        logger.error('[QOTD API] queue load failed', { guildId, error: error.message });
        res.status(500).json({ error: 'Could not load the queue.' });
    }
});

router.post('/queue', async (req, res) => {
    const { guildId } = req.params;
    const channelId = String(req.body?.channel_id || '');
    const cardIdIn = req.body?.card_id ? posInt(req.body.card_id) : null;
    const content = text(req.body?.content);
    const userId = req.user?.id || null;
    if (!ID.test(channelId)) return res.status(400).json({ error: 'Pick a channel.' });
    if (!cardIdIn && !content) return res.status(400).json({ error: 'Pick a card or write a question.' });
    if (content.length > MAX_TEXT) return res.status(400).json({ error: `Keep it under ${MAX_TEXT} characters.` });

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[ch]] = await conn.execute('SELECT channel_id FROM qotd_channels WHERE channel_id = ? AND guild_id = ? FOR UPDATE', [channelId, guildId]);
        if (!ch) { await conn.rollback(); return res.status(400).json({ error: 'That channel does not post questions. Add it under Channels first.' }); }

        let cardId = cardIdIn;
        if (cardId) {
            const [[card]] = await conn.execute('SELECT card_id, deck_id FROM qotd_cards WHERE card_id = ?', [cardId]);
            if (!card || !(await usableDeck(conn, guildId, card.deck_id))) {
                await conn.rollback();
                return res.status(400).json({ error: 'That card is not in one of this server\'s decks.' });
            }
        } else {
            const deckId = await ensureDeck(conn, guildId, DASHBOARD_DECK, 'Questions written on the dashboard to queue.', userId);
            cardId = await addCard(conn, deckId, content, 'question', userId);
        }

        // The channel row is locked above, so two adds to the same channel cannot take the same position.
        const [[{ maxPos }]] = await conn.execute('SELECT COALESCE(MAX(position), 0) AS maxPos FROM qotd_queue WHERE channel_id = ?', [channelId]);
        const [result] = await conn.execute(
            'INSERT INTO qotd_queue (channel_id, card_id, position, added_by) VALUES (?, ?, ?, ?)',
            [channelId, cardId, Number(maxPos) + 1, userId]);
        await conn.commit();
        logger.info('[QOTD API] card queued', { guildId, channelId, cardId, queueId: result.insertId, by: userId });
        res.json({ ok: true, queue_id: result.insertId, card_id: cardId, position: Number(maxPos) + 1 });
    } catch (error) {
        await conn.rollback().catch(() => {});
        logger.error('[QOTD API] queue add failed', { guildId, channelId, error: error.message });
        res.status(500).json({ error: 'Could not queue it. Nothing was changed.' });
    } finally {
        conn.release();
    }
});

router.delete('/queue/:queueId', async (req, res) => {
    const { guildId } = req.params;
    const queueId = posInt(req.params.queueId);
    if (!queueId) return res.status(400).json({ error: 'Bad queue entry.' });
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[row]] = await conn.execute(
            `SELECT q.queue_id, q.channel_id, q.position FROM qotd_queue q
               JOIN qotd_channels ch ON ch.channel_id = q.channel_id AND ch.guild_id = ?
              WHERE q.queue_id = ? FOR UPDATE`,
            [guildId, queueId]);
        if (!row) { await conn.rollback(); return res.status(404).json({ error: 'That entry is no longer queued.' }); }
        await removeQueued(conn, row);
        await conn.commit();
        logger.info('[QOTD API] queue entry removed', { guildId, queueId, by: req.user?.id });
        res.json({ ok: true });
    } catch (error) {
        await conn.rollback().catch(() => {});
        logger.error('[QOTD API] queue remove failed', { guildId, queueId, error: error.message });
        res.status(500).json({ error: 'Could not remove it. Nothing was changed.' });
    } finally {
        conn.release();
    }
});

export default router;
