import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import { ticketLabel } from './ticket-number.js';
import logger from '../utils/logger.js';
import { generateTranscript } from '../utils/transcript-generator.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { themeColor } from './guild-theme.js';
import { updateChallengeProgress } from './daily-challenges-manager.js';
import { logFeatureEvent, userLabel } from './feature-log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Close a ticket and generate transcript
 * @param {Client} client - Discord client
 * @param {Guild} guild - Guild object
 * @param {TextChannel} channel - Ticket channel
 * @param {Object} ticket - Ticket database row
 * @param {User} closer - User who closed the ticket
 * @param {Object|null} panelConfig - Panel configuration (null for default behavior)
 * @param {string|null} [reason=null] - Why it was closed (/ticket close reason), for the server log
 * @returns {Promise<Object>} Result object with success status
 */
async function closeTicket(client, guild, channel, ticket, closer, panelConfig = null, reason = null) {
    try {
        // No panel log channel (a ticket without a panel): fall back to the log channel set with
        // /support ticket setup, which used to be saved but never used.
        if (!panelConfig?.log_channel_id) {
            const [[legacy]] = await pool.execute('SELECT log_channel_id FROM ticket_config WHERE guild_id = ?', [guild.id]).catch(() => [[null]]);
            if (legacy?.log_channel_id) panelConfig = { ...(panelConfig || {}), log_channel_id: legacy.log_channel_id };
        }
        // On unless the panel turned it off. The column comes back from MySQL as 0/1, so 0 is "off"
        // (comparing with false alone let a switched-off panel keep saving transcripts, H-119).
        const transcriptSetting = panelConfig?.save_transcripts;
        const saveTranscript = !(transcriptSetting === false || transcriptSetting === 0 || transcriptSetting === '0');
        let transcriptUrl = null;

        if (saveTranscript) {
            // 1. Fetch all messages
            let allMessages = [];
            let lastId = undefined;
            while (true) {
                const options = { limit: 100 };
                if (lastId) {
                    options.before = lastId;
                }
                const messages = await channel.messages.fetch(options);
                if (messages.size === 0) break;
                allMessages.push(...messages.values());
                lastId = messages.last()?.id;
            }
            allMessages.reverse(); // Sort from oldest to newest

            // 2. Generate HTML
            const transcriptHtml = generateTranscript(allMessages);

            // 3. Save transcript
            const transcriptDir = path.join(__dirname, '..', 'transcripts');
            if (!fs.existsSync(transcriptDir)) {
                fs.mkdirSync(transcriptDir, { recursive: true });
            }
            const fileName = `transcript-${ticket.id}-${guild.id}.html`;
            const filePath = path.join(transcriptDir, fileName);
            fs.writeFileSync(filePath, transcriptHtml);

            transcriptUrl = `https://certifriedmultitool.com/transcripts/${fileName}`;
            logger.info(`Ticket #${ticket.id} transcript saved`, { guildId: guild.id, category: 'tickets' });

            // Also save an encrypted JSON blob to ticket_transcripts for the dashboard viewer
            // (/transcripts/:guildId/ticket/:id). Fire-and-forget so a save failure doesn't
            // block ticket close.
            try {
                const { saveTranscript: saveEnc } = await import('./ticket-transcripts.js');
                const jsonMessages = allMessages.map(m => ({
                    author_id: m.author?.id, author_tag: m.author?.tag,
                    author_type: m.author?.id === client.user?.id ? 'system'
                                 : (m.member?.permissions?.has?.('ManageMessages') ? 'staff' : 'user'),
                    content: m.content, timestamp: m.createdAt?.toISOString() ?? null,
                    attachments: [...(m.attachments?.values?.() || [])].map(a => a.url),
                }));
                saveEnc({
                    guildId: guild.id, kind: 'ticket', sourceId: ticket.id,
                    channelId: channel.id, userId: ticket.user_id,
                    transcript: { title: `Ticket ${ticketLabel(ticket)} — ${ticket.subject || 'Support'}`, messages: jsonMessages },
                }).catch(() => {});
            } catch (encErr) {
                logger.warn(`[ticket] encrypted transcript save failed: ${encErr.message}`);
            }
        } else {
            logger.info(`Ticket #${ticket.id} closed without transcript (save_transcripts disabled)`, { guildId: guild.id, category: 'tickets' });
        }

        // 4. Update database
        await pool.execute(
            'UPDATE tickets SET status = ?, closed_at = NOW(), closed_by_id = ?, transcript_url = ? WHERE id = ?',
            ['closed', closer.id, transcriptUrl, ticket.id]
        );

        // Daily challenge "Helpful — help users via ticket/support" (type 'social'): credit whoever
        // handled the ticket (its claimer, else the closer) — never the member who opened it.
        // Fire-and-forget: a challenge hiccup must not affect closing the ticket.
        const staffUserId = ticket.claimed_by_id || closer.id;
        if (staffUserId && staffUserId !== ticket.user_id) {
            updateChallengeProgress(guild.id, staffUserId, 'social', 1)
                .catch(err => logger.warn('[DailyChallenges] social progress failed', { error: err.message, guildId: guild.id, ticketId: ticket.id }));
        }

        // 5. DM the user
        const ticketOwner = await client.users.fetch(ticket.user_id).catch(() => null);
        if (ticketOwner) {
            const dmEmbed = new EmbedBuilder()
                .setColor(themeColor(guild?.id, 'primary'))
                .setTitle('Ticket Closed')
                .setTimestamp();

            if (saveTranscript && transcriptUrl) {
                dmEmbed.setDescription(`Your ticket in **${guild.name}** has been closed. A transcript has been saved for your records.\n\nPlease rate the support you received:`);
                dmEmbed.addFields({ name: 'View Transcript', value: `[Click here](${transcriptUrl})` });
            } else {
                dmEmbed.setDescription(`Your ticket in **${guild.name}** has been closed.\n\nPlease rate the support you received:`);
            }

            const feedbackRow = new ActionRowBuilder();
            for (let i = 1; i <= 5; i++) {
                feedbackRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`ticket_feedback_${ticket.id}_${i}`)
                        .setLabel('⭐'.repeat(i))
                        .setStyle(ButtonStyle.Primary)
                );
            }
            await ticketOwner.send({ embeds: [dmEmbed], components: [feedbackRow] }).catch(() => {});
        }

        // 6. Send close log to ticket-logs channel
        if (panelConfig?.log_channel_id) {
            try {
                const logChannel = await client.channels.fetch(panelConfig.log_channel_id).catch(() => null);
                if (logChannel) {
                    const logEmbed = new EmbedBuilder()
                        .setColor(themeColor(guild?.id, 'danger'))
                        .setTitle('🔒 Ticket Closed')
                        .setDescription(`Ticket **${ticketLabel(ticket)}** has been closed.`)
                        .addFields(
                            { name: '👤 Opened By', value: ticketOwner ? `${ticketOwner}` : `<@${ticket.user_id}>`, inline: true },
                            { name: '🔒 Closed By', value: `${closer}`, inline: true },
                            { name: '📋 Panel', value: panelConfig.panel_name || 'Default', inline: true }
                        )
                        .setFooter({ text: `Ticket ${ticketLabel(ticket)}` })
                        .setTimestamp();

                    if (saveTranscript && transcriptUrl) {
                        logEmbed.addFields({ name: '📄 Transcript', value: `[View Transcript](${transcriptUrl})` });
                    }

                    await logChannel.send({ embeds: [logEmbed] });
                }
            } catch (logErr) {
                logger.warn('[Ticket Close Log] Failed to send log', { error: logErr.message, guildId: guild.id });
            }
        }

        // 7. Log and delete channel
        logger.info(`Ticket #${ticket.id} closed by ${closer.tag}`, { guildId: guild.id, category: 'tickets' });

        // Website Stream Team applications have user_id '0' (no Discord account)
        const hasOwner = ticket.user_id && ticket.user_id !== '0';
        void logFeatureEvent(() => (guild), 'tickets.closed', () => ({
            title: '🔒 Ticket Closed',
            fields: [
                ['Ticket', `#${channel.name} (${ticketLabel(ticket)})`], ['Opened By', hasOwner ? userLabel(ticketOwner ?? ticket.user_id) : 'Website applicant'],
                ['Closed By', userLabel(closer)], ['Claimed By', ticket.claimed_by_id ? userLabel(ticket.claimed_by_id) : null],
                ['Panel', panelConfig?.panel_name || null], ['Reason', reason],
                ['Transcript', transcriptUrl ? `[View Transcript](${transcriptUrl})` : null],
            ],
            avoidChannelIds: [panelConfig?.log_channel_id],
        }));

        setTimeout(async () => {
            await channel.delete('Ticket closed and archived.');
        }, 5000);

        return { success: true };

    } catch (error) {
        logger.error(`Failed to close and archive ticket ${channel.id}:`, error);
        return { success: false, error: error };
    }
}

/**
 * Assign an open ticket to a staff member, or clear the assignment (staffMember = null).
 * Used by the dashboard's ticket details dialog; the slash commands (/ticket claim, unclaim,
 * transfer) do the same thing from inside the ticket channel. Only claimed_by_id changes:
 * tickets.status is enum('open','closed').
 * @param {Object} opts
 * @param {Guild} opts.guild
 * @param {Object} opts.ticket              tickets row (must be open)
 * @param {GuildMember|null} opts.staffMember  new assignee, or null to unassign
 * @param {User} opts.actor                 who made the change
 * @param {TextChannel|null} opts.channel   the ticket channel, for the notice (skipped if gone)
 * @returns {Promise<{ ok: boolean, error?: string, changed?: boolean }>}
 */
async function setTicketAssignee({ guild, ticket, staffMember, actor, channel = null }) {
    const newId = staffMember ? staffMember.id : null;
    const prevId = ticket.claimed_by_id || null;
    if (newId === prevId) return { ok: true, changed: false };
    const [res] = await pool.execute(
        "UPDATE tickets SET claimed_by_id = ? WHERE id = ? AND guild_id = ? AND status = 'open'",
        [newId, ticket.id, guild.id]);
    if (!res.affectedRows) return { ok: false, error: 'This ticket is already closed.' };

    let text;
    if (!newId) text = `This ticket was unassigned by ${actor} from the dashboard and is open for anyone to handle.`;
    else if (prevId) text = `This ticket was moved from <@${prevId}> to ${staffMember} by ${actor} from the dashboard.`;
    else text = `This ticket was assigned to ${staffMember} by ${actor} from the dashboard.`;
    if (channel) {
        await channel.send({
            content: newId ? `<@${newId}>` : undefined,
            embeds: [new EmbedBuilder().setColor(themeColor(guild.id, newId ? 'warning' : 'primary')).setDescription(text)],
            allowedMentions: { users: newId ? [newId] : [], roles: [], parse: [] },
        }).catch(err => logger.warn(`[ticket assign] notice failed: ${err.message}`, { guildId: guild.id, ticketId: ticket.id }));
    }
    logger.info(`Ticket #${ticket.id} ${newId ? `assigned to ${newId}` : 'unassigned'} by ${actor.id} (dashboard)`, { guildId: guild.id, category: 'tickets' });
    const where = channel ? `<#${channel.id}> (${ticketLabel(ticket)})` : ticketLabel(ticket);
    const owner = ticket.user_id && ticket.user_id !== '0' ? userLabel(ticket.user_id) : 'Website applicant';
    if (!newId) {
        void logFeatureEvent(() => guild, 'tickets.unclaimed', () => ({
            title: 'Ticket Unclaimed',
            fields: [['Ticket', where], ['Unclaimed By', `${userLabel(actor)} (dashboard)`], ['Was Claimed By', userLabel(prevId)]],
        }));
    } else if (prevId) {
        void logFeatureEvent(() => guild, 'tickets.transferred', () => ({
            title: 'Ticket Transferred',
            fields: [['Ticket', where], ['To', userLabel(staffMember)], ['Previously Claimed By', userLabel(prevId)],
                ['Transferred By', `${userLabel(actor)} (dashboard)`]],
        }));
    } else {
        void logFeatureEvent(() => guild, 'tickets.claimed', () => ({
            title: 'Ticket Claimed',
            fields: [['Ticket', where], ['Claimed By', userLabel(staffMember)], ['Opened By', owner],
                ['Assigned By', `${userLabel(actor)} (dashboard)`]],
        }));
    }
    return { ok: true, changed: true };
}

export { closeTicket, setTicketAssignee };
