/**
 * Who wrote last in an open ticket channel.
 *
 * The Tickets page shows "Waiting on staff" (a KPI, a pill on each open ticket and the sort order)
 * when tickets.last_user_reply_at is later than tickets.last_staff_reply_at (migration 348). Only
 * the dashboard's inline reply ever wrote last_staff_reply_at and nothing wrote last_user_reply_at,
 * so no ticket was ever shown as waiting. events/messageCreate.js calls noteTicketMessage() for
 * every human message in a server: the ticket's opener moves last_user_reply_at, anyone else
 * (staff, a member added with /support ticket add) moves last_staff_reply_at. Bot messages never
 * reach it (the dashboard reply sets last_staff_reply_at itself).
 *
 * Open ticket channels are kept in memory and reloaded at most once a minute, so a message in any
 * other channel costs one Map lookup. interactions/buttons/ticket_create.js registers a new ticket
 * at once, so the opener's first message counts.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const REFRESH_MS = 60_000;

/** The column a message moves, or null when it moves none. */
export function replyColumn(ownerId, authorId, isBot) {
    if (isBot || !authorId) return null;
    return String(authorId) === String(ownerId) ? 'last_user_reply_at' : 'last_staff_reply_at';
}

/**
 * The tracker. `loadOpen()` resolves to [{ id, channel_id, user_id }] for every open ticket and
 * `touch(ticketId, column)` writes the timestamp; both are injectable for tests.
 */
export function createTicketActivity({
    loadOpen = async () => (await pool.execute("SELECT id, channel_id, user_id FROM tickets WHERE status = 'open'"))[0],
    touch = (ticketId, column) => pool.execute(`UPDATE tickets SET ${column} = NOW() WHERE id = ? AND status = 'open'`, [ticketId]),
    now = () => Date.now(),
} = {}) {
    let channels = new Map();   // channel id -> { id, userId }
    let loadedAt = 0;
    let loading = null;

    async function refresh() {
        if (now() - loadedAt < REFRESH_MS) return;
        if (!loading) {
            loading = (async () => {
                try {
                    const rows = await loadOpen();
                    const next = new Map();
                    for (const r of rows || []) {
                        if (r.channel_id) next.set(String(r.channel_id), { id: r.id, userId: String(r.user_id) });
                    }
                    channels = next;
                } catch (err) {
                    logger.warn('[ticket-activity] could not load open tickets: ' + err.message);
                } finally {
                    loadedAt = now();
                    loading = null;
                }
            })();
        }
        await loading;
    }

    return {
        /** A ticket opened just now, so its first messages count before the next reload. */
        remember(channelId, ticketId, userId) {
            if (channelId && ticketId) channels.set(String(channelId), { id: ticketId, userId: String(userId) });
        },
        /** Record a guild message; returns the column it moved, or null. Never throws. */
        async note(message) {
            try {
                if (!message?.guild || !message.channel?.id) return null;
                await refresh();
                const ticket = channels.get(String(message.channel.id));
                if (!ticket) return null;
                const column = replyColumn(ticket.userId, message.author?.id, !!message.author?.bot);
                if (!column) return null;
                await touch(ticket.id, column);
                return column;
            } catch (err) {
                logger.warn('[ticket-activity] ' + err.message);
                return null;
            }
        },
    };
}

const tracker = createTicketActivity();

export const noteTicketMessage = (message) => tracker.note(message);
export const rememberTicketChannel = (channelId, ticketId, userId) => tracker.remember(channelId, ticketId, userId);

export default { noteTicketMessage, rememberTicketChannel, replyColumn, createTicketActivity };
