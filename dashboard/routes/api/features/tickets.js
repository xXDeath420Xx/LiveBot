/**
 * Tickets dashboard API — mounted at /api/guilds/:guildId/tickets (routes/api/index.js), behind
 * apiCheckGuildAdmin + botContext like every other guild feature router. Backs the ticket
 * details dialog on the Tickets page (partials/manage/tickets.ejs).
 *
 *   GET    /?status=open|closed&limit=      tickets for the lists (newest first)
 *   GET    /:ticketId                       one ticket: opener, assignee, status, dates, intake
 *                                           answers, messages (live from the channel while open,
 *                                           the saved transcript once closed), staff notes, and
 *                                           the support-role members it can be assigned to
 *   POST   /:ticketId/notes                 { note } — staff note, never shown to the member
 *   POST   /:ticketId/assign                { staff_id } — assign / move; '' or null unassigns
 *   POST   /:ticketId/close                 { reason } — closes through core/ticket-manager.js
 *                                           closeTicket(), the same path as the Close button and
 *                                           /ticket close (transcript, member DM, log channel,
 *                                           server log, channel deleted)
 *
 * Every route checks the ticket belongs to :guildId, so one server's admin cannot read or act on
 * another server's tickets by guessing ids. Notes need migration 427 (ticket_notes); until it
 * runs, reads return no notes and writes answer 503.
 */
import express from 'express';
import { PermissionsBitField, EmbedBuilder } from 'discord.js';
import pool from '../../../../utils/db.js';
import { ticketNumber, ticketLabel } from '../../../../core/ticket-number.js';
import logger from '../../../../utils/logger.js';
import { closeTicket, setTicketAssignee } from '../../../../core/ticket-manager.js';
import { loadTranscript } from '../../../../core/ticket-transcripts.js';
import { themeColor } from '../../../../core/guild-theme.js';
import { logFeatureEvent, userLabel } from '../../../../core/feature-log.js';

const router = express.Router({ mergeParams: true });

const SNOWFLAKE = /^\d{17,20}$/;
const NOTE_MAX = 2000;
const REASON_MAX = 500;
const closing = new Set();   // ticket ids being closed right now (double-click guard)

function clientFor(req) {
    const { guildId } = req.params;
    if (req.botClient?.guilds?.cache?.has(guildId)) return req.botClient;
    return global.botManager?.getClientForGuild?.(guildId) || req.botClient || null;
}

function guildFor(req) {
    return clientFor(req)?.guilds?.cache?.get(req.params.guildId) || null;
}

async function ticketInGuild(req, res) {
    const id = Number(req.params.ticketId);
    if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid ticket id' });
        return null;
    }
    const [[ticket]] = await pool.execute('SELECT * FROM tickets WHERE id = ? AND guild_id = ?', [id, req.params.guildId]);
    if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' });
        return null;
    }
    return ticket;
}

const isMissingTable = (err) => err?.code === 'ER_NO_SUCH_TABLE';

function iso(d) {
    if (!d) return null;
    const t = new Date(d);
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** { id, name, avatar, in_server } for a user id, from the guild/user cache, fetching the user if needed. */
async function person(client, guild, id, { fetch = false } = {}) {
    if (!id || id === '0') return null;
    const member = guild?.members?.cache?.get(String(id)) || null;
    let user = member?.user || client?.users?.cache?.get(String(id)) || null;
    if (!user && fetch && client) user = await client.users.fetch(String(id)).catch(() => null);
    return {
        id: String(id),
        name: member?.displayName || user?.globalName || user?.username || null,
        username: user?.username || null,
        avatar: (member || user)?.displayAvatarURL?.({ size: 64 }) || null,
        in_server: !!member,
    };
}

/** The ticket's panel row, or null (old one-panel setup / panel deleted). */
async function panelFor(ticket) {
    if (!ticket.panel_id) return null;
    const [[panel]] = await pool.execute('SELECT * FROM ticket_panels WHERE panel_id = ? AND guild_id = ?', [ticket.panel_id, ticket.guild_id])
        .catch(() => [[null]]);
    return panel || null;
}

/** Support role for this ticket: its panel's, else the one-panel setup's (ticket_config). */
async function supportRoleIdFor(ticket, panel) {
    if (panel?.support_role_id) return String(panel.support_role_id);
    const [[cfg]] = await pool.execute('SELECT support_role_id FROM ticket_config WHERE guild_id = ?', [ticket.guild_id]).catch(() => [[null]]);
    return cfg?.support_role_id ? String(cfg.support_role_id) : null;
}

function canHandleTickets(member, supportRoleId) {
    if (!member || member.user?.bot) return false;
    if (supportRoleId && member.roles?.cache?.has(supportRoleId)) return true;
    return member.permissions?.has?.(PermissionsBitField.Flags.Administrator)
        || member.permissions?.has?.(PermissionsBitField.Flags.ManageGuild) || false;
}

function parseForm(raw) {
    if (!raw) return [];
    try {
        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!obj || typeof obj !== 'object') return [];
        return Object.entries(obj).slice(0, 25).map(([q, a]) => ({
            question: String(q).slice(0, 300),
            answer: String(a ?? '').replace(/\\n/g, '\n').slice(0, 2000),
        }));
    } catch { return []; }
}

function shapeLiveMessage(m, botId) {
    const embeds = (m.embeds || []).slice(0, 3).map(e => ({
        title: e.title ? String(e.title).slice(0, 256) : null,
        description: e.description ? String(e.description).slice(0, 1000) : null,
    })).filter(e => e.title || e.description);
    return {
        id: m.id,
        author_id: m.author?.id || null,
        author_name: m.member?.displayName || m.author?.globalName || m.author?.username || 'Unknown',
        author_avatar: (m.member || m.author)?.displayAvatarURL?.({ size: 64 }) || null,
        kind: m.author?.id === botId ? 'bot' : (m.author?.bot ? 'bot' : 'member'),
        content: String(m.content || '').slice(0, 4000),
        embeds,
        attachments: [...(m.attachments?.values?.() || [])].slice(0, 10).map(a => ({ name: a.name || 'file', url: a.url })),
        timestamp: m.createdAt ? m.createdAt.toISOString() : null,
    };
}

function shapeSavedMessage(m) {
    return {
        id: null,
        author_id: m.author_id || null,
        author_name: m.author_tag || m.author_id || 'Unknown',
        author_avatar: null,
        kind: m.author_type === 'system' ? 'bot' : (m.author_type === 'staff' ? 'staff' : 'member'),
        content: String(m.content || m.message_content || '').slice(0, 4000),
        embeds: [],
        attachments: (m.attachments || []).slice(0, 10).map(u => ({ name: String(u).split('/').pop().split('?')[0] || 'file', url: String(u) })),
        timestamp: m.timestamp || null,
    };
}

async function loadNotes(client, guild, ticketId) {
    try {
        const [rows] = await pool.execute(
            'SELECT id, author_id, note, created_at FROM ticket_notes WHERE ticket_id = ? ORDER BY created_at, id LIMIT 200', [ticketId]);
        return Promise.all(rows.map(async r => ({
            id: r.id,
            note: r.note,
            created_at: iso(r.created_at),
            author: await person(client, guild, r.author_id),
        })));
    } catch (err) {
        if (!isMissingTable(err)) logger.warn(`[API Tickets] notes load failed: ${err.message}`);
        return [];
    }
}

// ── List ──
router.get('/', async (req, res) => {
    const { guildId } = req.params;
    const status = req.query.status === 'closed' ? 'closed' : 'open';
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    try {
        const client = clientFor(req);
        const guild = guildFor(req);
        const [rows] = await pool.execute(
            `SELECT id, ticket_number, channel_id, user_id, subject, status, claimed_by_id, created_at, closed_at, closed_by_id, panel_id
               FROM tickets WHERE guild_id = ? AND status = ?
              ORDER BY ${status === 'closed' ? 'closed_at DESC,' : ''} id DESC LIMIT ${limit}`,
            [guildId, status]);
        const tickets = await Promise.all(rows.map(async t => ({
            id: t.id,
            number: ticketNumber(t),
            subject: t.subject || 'Support ticket',
            status: t.status,
            created_at: iso(t.created_at),
            closed_at: iso(t.closed_at),
            opener: t.user_id === '0' ? { id: '0', name: 'Website applicant', in_server: false } : await person(client, guild, t.user_id),
            assignee: await person(client, guild, t.claimed_by_id),
            closed_by: await person(client, guild, t.closed_by_id),
        })));
        res.json({ success: true, status, tickets });
    } catch (error) {
        logger.error('[API Tickets] list failed', { guildId, error: error.message });
        res.status(500).json({ error: 'Failed to load tickets' });
    }
});

// ── Details ──
router.get('/:ticketId', async (req, res) => {
    try {
        const ticket = await ticketInGuild(req, res);
        if (!ticket) return;
        const client = clientFor(req);
        const guild = guildFor(req);
        const panel = await panelFor(ticket);
        const supportRoleId = await supportRoleIdFor(ticket, panel);

        let channel = null;
        if (ticket.status === 'open' && client) channel = await client.channels.fetch(ticket.channel_id).catch(() => null);

        let messages = [];
        let source = 'none';
        let truncatedNotice = null;
        let transcriptViewer = null;
        if (channel?.messages) {
            const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
            if (fetched) {
                messages = [...fetched.values()].reverse().map(m => shapeLiveMessage(m, client.user?.id));
                source = 'live';
            }
        } else if (ticket.status === 'closed') {
            const saved = await loadTranscript(ticket.guild_id, 'ticket', ticket.id).catch(() => null);
            if (saved) {
                messages = (saved.messages || []).slice(-500).map(shapeSavedMessage);
                source = 'transcript';
                truncatedNotice = saved.truncated_notice || null;
                transcriptViewer = `/transcripts/${encodeURIComponent(ticket.guild_id)}/ticket/${ticket.id}`;
            }
        }

        // Members who can take the ticket: the support role's members (no bots), plus the
        // current assignee if they are not in it any more.
        const staff = [];
        const role = supportRoleId ? guild?.roles?.cache?.get(supportRoleId) : null;
        if (role) {
            for (const m of role.members.values()) {
                if (m.user.bot || m.id === ticket.user_id) continue;
                staff.push({ id: m.id, name: m.displayName, username: m.user.username });
                if (staff.length >= 200) break;
            }
        }
        if (ticket.claimed_by_id && !staff.some(s => s.id === ticket.claimed_by_id)) {
            const p = await person(client, guild, ticket.claimed_by_id);
            if (p) staff.push({ id: p.id, name: p.name || p.id, username: p.username });
        }
        staff.sort((a, b) => String(a.name).localeCompare(String(b.name)));

        res.json({
            success: true,
            ticket: {
                id: ticket.id,
                number: ticketNumber(ticket),
                subject: ticket.subject || 'Support ticket',
                status: ticket.status,
                created_at: iso(ticket.created_at),
                closed_at: iso(ticket.closed_at),
                last_user_reply_at: iso(ticket.last_user_reply_at),
                last_staff_reply_at: iso(ticket.last_staff_reply_at),
                channel: { id: ticket.channel_id, exists: !!channel, name: channel?.name || null },
                panel: panel ? { id: panel.panel_id, name: panel.panel_name } : null,
                support_role: role ? { id: role.id, name: role.name } : (supportRoleId ? { id: supportRoleId, name: null } : null),
                form: parseForm(ticket.form_responses),
            },
            opener: ticket.user_id === '0'
                ? { id: '0', name: 'Website applicant', username: null, avatar: null, in_server: false }
                : await person(client, guild, ticket.user_id, { fetch: true }),
            assignee: await person(client, guild, ticket.claimed_by_id, { fetch: true }),
            closed_by: await person(client, guild, ticket.closed_by_id, { fetch: true }),
            messages,
            messages_source: source,
            truncated_notice: truncatedNotice,
            transcript_viewer: transcriptViewer,
            notes: await loadNotes(client, guild, ticket.id),
            staff,
        });
    } catch (error) {
        logger.error('[API Tickets] details failed', { guildId: req.params.guildId, ticketId: req.params.ticketId, error: error.message });
        res.status(500).json({ error: 'Failed to load the ticket' });
    }
});

// ── Staff note ──
router.post('/:ticketId/notes', async (req, res) => {
    try {
        const ticket = await ticketInGuild(req, res);
        if (!ticket) return;
        const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
        if (!note) return res.status(400).json({ error: 'Write a note first.' });
        if (note.length > NOTE_MAX) return res.status(400).json({ error: `Notes can be up to ${NOTE_MAX} characters.` });
        let result;
        try {
            [result] = await pool.execute(
                'INSERT INTO ticket_notes (ticket_id, guild_id, author_id, note) VALUES (?, ?, ?, ?)',
                [ticket.id, ticket.guild_id, String(req.user.id), note]);
        } catch (err) {
            if (isMissingTable(err)) return res.status(503).json({ error: 'Notes are not available yet (database update pending).' });
            throw err;
        }
        const client = clientFor(req);
        res.json({
            success: true,
            note: { id: result.insertId, note, created_at: new Date().toISOString(), author: await person(client, guildFor(req), req.user.id) },
        });
    } catch (error) {
        logger.error('[API Tickets] note failed', { guildId: req.params.guildId, ticketId: req.params.ticketId, error: error.message });
        res.status(500).json({ error: 'Failed to save the note' });
    }
});

// ── Assign / move / unassign ──
router.post('/:ticketId/assign', async (req, res) => {
    try {
        const ticket = await ticketInGuild(req, res);
        if (!ticket) return;
        if (ticket.status !== 'open') return res.status(409).json({ error: 'This ticket is already closed.' });
        const client = clientFor(req);
        const guild = guildFor(req);
        if (!client || !guild) return res.status(503).json({ error: 'The bot is not connected to this server right now.' });

        const raw = req.body?.staff_id;
        const staffId = raw === null || raw === undefined || raw === '' ? null : String(raw).trim();
        let staffMember = null;
        if (staffId) {
            if (!SNOWFLAKE.test(staffId)) return res.status(400).json({ error: 'Choose a staff member.' });
            if (staffId === ticket.user_id) return res.status(400).json({ error: 'A ticket cannot be assigned to the member who opened it.' });
            staffMember = await guild.members.fetch(staffId).catch(() => null);
            if (!staffMember) return res.status(400).json({ error: 'That member is not in this server.' });
            const panel = await panelFor(ticket);
            const supportRoleId = await supportRoleIdFor(ticket, panel);
            if (!canHandleTickets(staffMember, supportRoleId)) {
                return res.status(400).json({ error: 'That member does not have the support role (or Manage Server).' });
            }
        }
        const actor = await client.users.fetch(String(req.user.id)).catch(() => null);
        if (!actor) return res.status(500).json({ error: 'Could not look up your Discord account.' });
        const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
        const result = await setTicketAssignee({ guild, ticket, staffMember, actor, channel });
        if (!result.ok) return res.status(409).json({ error: result.error });
        res.json({ success: true, changed: result.changed, assignee: staffMember ? await person(client, guild, staffMember.id) : null });
    } catch (error) {
        logger.error('[API Tickets] assign failed', { guildId: req.params.guildId, ticketId: req.params.ticketId, error: error.message });
        res.status(500).json({ error: 'Failed to assign the ticket' });
    }
});

// ── Close ──
router.post('/:ticketId/close', async (req, res) => {
    let ticket = null;
    try {
        ticket = await ticketInGuild(req, res);
        if (!ticket) return;
        if (ticket.status !== 'open') return res.status(409).json({ error: 'This ticket is already closed.' });
        if (closing.has(ticket.id)) return res.status(409).json({ error: 'This ticket is already being closed.' });
        const client = clientFor(req);
        const guild = guildFor(req);
        if (!client || !guild) return res.status(503).json({ error: 'The bot is not connected to this server right now.' });
        const reasonRaw = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
        if (reasonRaw.length > REASON_MAX) return res.status(400).json({ error: `The reason can be up to ${REASON_MAX} characters.` });
        const reason = reasonRaw || null;
        const closer = await client.users.fetch(String(req.user.id)).catch(() => null);
        if (!closer) return res.status(500).json({ error: 'Could not look up your Discord account.' });

        closing.add(ticket.id);
        const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
        if (!channel) {
            // The channel was deleted by hand: nothing to archive or delete, so record the close.
            const [r] = await pool.execute(
                "UPDATE tickets SET status = 'closed', closed_at = NOW(), closed_by_id = ? WHERE id = ? AND status = 'open'",
                [closer.id, ticket.id]);
            if (!r.affectedRows) return res.status(409).json({ error: 'This ticket is already closed.' });
            void logFeatureEvent(() => guild, 'tickets.closed', () => ({
                title: 'Ticket Closed',
                fields: [['Ticket', ticketLabel(ticket)], ['Opened By', ticket.user_id && ticket.user_id !== '0' ? userLabel(ticket.user_id) : 'Website applicant'],
                    ['Closed By', `${userLabel(closer)} (dashboard)`], ['Reason', reason], ['Note', 'The ticket channel had already been deleted, so no transcript was saved.']],
            }));
            return res.json({ success: true, transcript: false, message: 'Closed. The channel was already gone, so no transcript was saved.' });
        }

        const panelConfig = await panelFor(ticket);
        // Same notice the Close button posts before archiving.
        await channel.send({
            embeds: [new EmbedBuilder().setColor(themeColor(guild.id, 'danger'))
                .setDescription(`Ticket closed by ${closer} from the dashboard${reason ? `\n**Reason:** ${reason}` : ''}. Generating transcript and archiving...`)],
            allowedMentions: { parse: [] },
        }).catch(() => {});
        const result = await closeTicket(client, guild, channel, ticket, closer, panelConfig, reason ? `${reason} (dashboard)` : 'Closed from the dashboard');
        if (!result?.success) {
            logger.error('[API Tickets] closeTicket failed', { guildId: guild.id, ticketId: ticket.id, error: result?.error?.message });
            return res.status(500).json({ error: 'Closing failed part-way. Check the ticket channel in Discord.' });
        }
        res.json({ success: true, transcript: panelConfig?.save_transcripts !== 0, message: 'Closed. The channel is deleted in a few seconds.' });
    } catch (error) {
        logger.error('[API Tickets] close failed', { guildId: req.params.guildId, ticketId: req.params.ticketId, error: error.message });
        if (!res.headersSent) res.status(500).json({ error: 'Failed to close the ticket' });
    } finally {
        if (ticket) setTimeout(() => closing.delete(ticket.id), 10_000).unref?.();
    }
});

export default router;
