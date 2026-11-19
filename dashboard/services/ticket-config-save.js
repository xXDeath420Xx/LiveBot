/**
 * The ticket_config columns a save of the Tickets page's "Default panel" form changes.
 *
 * The form posts the panel channel, ticket category, support role and log channel. The route used
 * to write all seven columns from the body, so the four it did not post (and, before the log channel
 * was on the form, the log channel that /support ticket setup sets) were cleared on every save. Only
 * columns the body names are written now; anything else in the row is left as it is.
 */
const SNOWFLAKE = /^\d{17,20}$/;

const id = (v) => (SNOWFLAKE.test(String(v ?? '').trim()) ? String(v).trim() : null);

const COLUMNS = {
    panel_channel_id: id,
    ticket_category_id: id,
    support_role_id: id,
    log_channel_id: id,
    alert_channel_id: id,   // "New Ticket Opened" posts (migration 452, H-714)
    thread_parent_channel_id: id,
    // Same range as PATCH /api/guilds/:id/tickets (dashboard/routes/features/tickets.js).
    auto_close_hours: (v) => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n >= 1 && n <= 720 ? n : null;
    },
    use_threads: (v) => (v === true || v === 1 || v === '1' || v === 'on' || v === 'true' ? 1 : 0),
};

/** { cols, values } for the columns present in `body`, in a fixed order. */
export function ticketConfigChanges(body = {}) {
    const cols = [];
    const values = [];
    for (const [col, read] of Object.entries(COLUMNS)) {
        if (!Object.prototype.hasOwnProperty.call(body, col)) continue;
        cols.push(col);
        values.push(read(body[col]));
    }
    return { cols, values };
}

export default { ticketConfigChanges };
