/**
 * Ticket numbers (register H-661): one sequence per server, stored on the ticket (tickets.ticket_number,
 * migration 444) and shown everywhere a person sees "Ticket #N": the welcome message, `{number}` in the
 * channel name, the close log and DM, the transcript, the server log and the dashboard.
 *
 * Before, an opened ticket showed the server's ticket COUNT + 1 while the close log and transcript showed
 * the global database id, so one ticket had two numbers, and a count repeats once rows are deleted. The
 * counter (ticket_counters) only goes up, so a number is never given out twice, even after deletions.
 * Database ids stay internal: button custom ids, transcript file names and the dashboard API key by them.
 */
import pool from '../utils/db.js';

/**
 * The next number for a server, taken atomically (LAST_INSERT_ID(expr) makes the new value this
 * statement's insertId, so two tickets opened at once never get the same number).
 * @param {string} guildId
 * @param {{ execute: Function }} [db]
 * @returns {Promise<number>}
 */
export async function nextTicketNumber(guildId, db = pool) {
    const [res] = await db.execute(
        `INSERT INTO ticket_counters (guild_id, last_number) VALUES (?, LAST_INSERT_ID(1))
         ON DUPLICATE KEY UPDATE last_number = LAST_INSERT_ID(last_number + 1)`,
        [String(guildId)]);
    return Number(res.insertId);
}

/** A ticket's number as people see it. Tickets opened before migration 444 was applied fall back to the id. */
export const ticketNumber = (ticket) => {
    const n = Number(ticket?.ticket_number);
    return Number.isInteger(n) && n > 0 ? n : ticket?.id;
};

/** '#N' for a tickets row. */
export const ticketLabel = (ticket) => `#${ticketNumber(ticket)}`;
