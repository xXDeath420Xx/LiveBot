/**
 * Ticket channel names from a panel's ticket_name_format.
 *
 * Placeholders: {username} (or {user}, the spelling every other feature uses), {number}, {id}.
 * The result is made safe for a Discord channel name: lower case, only a-z 0-9 - _, no repeated
 * or edge dashes, at most 100 characters. Any placeholder we don't know is dropped instead of
 * reaching Discord as literal text (Discord strips the braces, which is how "ticket-user"
 * channels were made from "ticket-{user}").
 */
const DEFAULT_FORMAT = 'ticket-{username}';

function slug(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '');
}

export function buildTicketChannelName(format, { username, userId, number } = {}) {
    const name = slug(username) || String(userId || 'member');
    const filled = String(format || DEFAULT_FORMAT)
        .replace(/\{(username|user)\}/gi, name)
        .replace(/\{number\}/gi, number != null ? String(number) : '')
        .replace(/\{id\}/gi, userId ? String(userId) : '')
        .replace(/\{[^{}]*\}/g, '');

    const result = slug(filled).slice(0, 100).replace(/-+$/, '');
    return result || slug(`ticket-${name}`).slice(0, 100);
}

export default buildTicketChannelName;
