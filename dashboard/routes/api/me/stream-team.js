import express from 'express';
import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionsBitField
} from 'discord.js';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';

/**
 * User-scoped Stream Team Signup API.
 *
 * A logged-in user fills a 3-field form on the dashboard and it creates the
 * SAME private Discord ticket the in-Discord "Stream Team Signup" panel
 * creates — a channel visible to ONLY the applicant + the server owner
 * (panel.extra_viewer_id), with support_role_id empty.
 *
 * Mirrors `interactions/buttons/ticket_create.js` createTicket(), but since
 * there's no discord.js `interaction` here we drive the bot client directly
 * via global.botManager.getClientForGuild().
 *
 * Gated by the global `apiCheckAuth` (login required) applied in
 * routes/api/index.js — NO guild-admin gate (per-USER action).
 */
const router = express.Router();

const GUILD_ID = '1342779579168981065';
const PANEL_NAME = 'Stream Team Signup';

/**
 * Resolve the active Stream Team Signup panel + its form questions.
 * Returns { panel, questions } or null if the panel doesn't exist / inactive.
 */
async function resolvePanel() {
    const [panels] = await pool.execute(
        "SELECT * FROM ticket_panels WHERE guild_id = ? AND panel_name = ? AND is_active = 1",
        [GUILD_ID, PANEL_NAME]
    );
    if (panels.length === 0) return null;
    const panel = panels[0];

    const [questions] = await pool.execute(
        "SELECT question_id, question_text, question_type FROM ticket_form_questions WHERE form_id = ? ORDER BY question_id",
        [panel.form_id]
    );
    return { panel, questions };
}

// GET /panel → does the panel exist + its questions + caller's open-ticket state.
router.get('/panel', async (req, res) => {
    try {
        const resolved = await resolvePanel();
        if (!resolved) {
            return res.json({ exists: false });
        }
        const { panel, questions } = resolved;

        // Does the caller already have an open ticket in this guild?
        const [openTickets] = await pool.execute(
            "SELECT channel_id FROM tickets WHERE guild_id = ? AND user_id = ? AND status != 'closed'",
            [GUILD_ID, req.user.id]
        );

        res.json({
            exists: true,
            questions: questions.map(q => ({
                question_id: q.question_id,
                question_text: q.question_text,
                question_type: q.question_type
            })),
            hasOpenTicket: openTickets.length > 0,
            openChannelId: openTickets.length > 0 ? openTickets[0].channel_id : null
        });
    } catch (error) {
        logger.error('[API /me/stream-team GET /panel] Error', { userId: req.user.id, error: error.message });
        res.status(500).json({ error: 'Failed to load the stream team signup form.' });
    }
});

// POST /signup { answers: { [question_id]: text } } → create the private ticket.
router.post('/signup', async (req, res) => {
    try {
        // a. Resolve panel.
        const resolved = await resolvePanel();
        if (!resolved) {
            return res.status(400).json({ error: 'The Stream Team Signup form is not available right now.' });
        }
        const { panel, questions } = resolved;
        const guildId = GUILD_ID;
        const userId = req.user.id;

        // b. Get the client for this guild + fetch the guild + member.
        const client = global.botManager?.getClientForGuild(guildId);
        if (!client) {
            return res.status(503).json({ error: 'The bot is not available right now. Try again shortly.' });
        }
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) {
            return res.status(503).json({ error: 'The bot is not available right now. Try again shortly.' });
        }
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) {
            return res.status(403).json({ error: 'Join the Discord server first.' });
        }

        // c. One-open-ticket guard.
        const [existingTickets] = await pool.execute(
            "SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND status != 'closed'",
            [guildId, userId]
        );
        if (existingTickets.length > 0) {
            return res.status(409).json({
                error: 'You already have an open ticket',
                channelId: existingTickets[0].channel_id
            });
        }

        // d. Build form_responses JSON keyed by QUESTION TEXT (mirror ticket_create.js).
        const answers = (req.body && typeof req.body.answers === 'object' && req.body.answers) || {};
        const responses = {};
        for (const q of questions) {
            const raw = answers[q.question_id];
            const text = typeof raw === 'string' ? raw.trim() : '';
            if (!text) {
                return res.status(400).json({ error: `Please answer: ${q.question_text}` });
            }
            responses[q.question_text] = text;
        }
        const formResponses = JSON.stringify(responses);

        // e. Channel name from panel.ticket_name_format, {username} sanitized like ticket_create.js.
        let channelName = panel.ticket_name_format || 'ticket-{username}';
        channelName = channelName
            .replace(/{username}/g, member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-'))
            .replace(/{id}/g, userId);
        channelName = channelName.substring(0, 100).toLowerCase();

        // Permission overwrites — EXACTLY mirror ticket_create.js (support_role_id empty):
        // deny @everyone, allow applicant, allow extra_viewer (owner).
        const permissionOverwrites = [
            {
                id: guild.id,
                deny: [PermissionsBitField.Flags.ViewChannel]
            },
            {
                id: userId,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory
                ]
            }
        ];
        // support_role_id is the empty string for this panel → falsy → skipped (mirror).
        if (panel.support_role_id) {
            permissionOverwrites.push({
                id: panel.support_role_id,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory
                ]
            });
        }
        if (panel.extra_viewer_id) {
            permissionOverwrites.push({
                id: panel.extra_viewer_id,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory
                ]
            });
        }

        const channel = await guild.channels.create({
            name: channelName,
            type: 0,
            parent: panel.ticket_category_id,
            permissionOverwrites
        });

        // f. INSERT into tickets — same columns as ticket_create.js.
        const [result] = await pool.execute(
            "INSERT INTO tickets (guild_id, panel_id, user_id, channel_id, status, form_id, form_responses) VALUES (?, ?, ?, ?, 'open', ?, ?)",
            [guildId, panel.panel_id, userId, channel.id, panel.form_id, formResponses]
        );
        const ticketId = result.insertId;

        // Ticket number for the embed title (mirror ticket_create.js count-based numbering).
        const [ticketCount] = await pool.execute(
            "SELECT COUNT(*) as count FROM tickets WHERE guild_id = ?",
            [guildId]
        );
        const ticketNumber = ticketCount[0].count;

        // g. Welcome embed + form responses + close button, pinging applicant + owner.
        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`Ticket #${ticketNumber}`)
            .setDescription(`Welcome <@${userId}>! A staff member will be with you shortly.\n\nPlease describe your issue in detail.`)
            .setTimestamp();

        let responseText = '';
        for (const [question, answer] of Object.entries(responses)) {
            responseText += `**${question}**\n${answer}\n\n`;
        }
        embed.addFields({ name: 'Form Responses', value: responseText });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`ticket_close_${ticketId}`)
                .setLabel('Close Ticket')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🔒')
        );

        let messageContent = `<@${userId}>`;
        if (panel.support_role_id) {
            messageContent += ` - <@&${panel.support_role_id}>`;
        } else if (panel.extra_viewer_id) {
            messageContent += ` - <@${panel.extra_viewer_id}>`;
        }

        await channel.send({
            content: messageContent,
            embeds: [embed],
            components: [row]
        });

        logger.info(`Stream Team ticket #${ticketId} created via dashboard by ${member.user.tag}`, { guildId, category: 'tickets' });

        // h. Alert embed → panel.alert_channel_id (mirror ticket_create.js).
        if (panel.alert_channel_id) {
            try {
                const alertChannel = await guild.channels.fetch(panel.alert_channel_id).catch(() => null);
                if (alertChannel) {
                    const alertEmbed = new EmbedBuilder()
                        .setColor('#2ECC71')
                        .setTitle('🎫 New Ticket Opened')
                        .setDescription(`**${channelName}** with ID: ${ticketId} has been opened.`)
                        .addFields(
                            { name: '📨 Opened By', value: `<@${userId}>`, inline: true },
                            { name: '📋 Panel', value: panel.panel_name || 'Default', inline: true },
                            { name: '📌 Channel', value: `<#${channel.id}>`, inline: true }
                        )
                        .setFooter({ text: `Ticket #${ticketId}` })
                        .setTimestamp();

                    const joinRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setStyle(ButtonStyle.Link)
                            .setLabel('Join Ticket')
                            .setEmoji('➕')
                            .setURL(`https://discord.com/channels/${guildId}/${channel.id}`)
                    );

                    await alertChannel.send({ embeds: [alertEmbed], components: [joinRow] });
                }
            } catch (alertErr) {
                logger.warn('[Stream Team Alert] Failed to send alert', { error: alertErr.message, guildId });
            }
        }

        // i. Done.
        res.json({ ok: true, channelId: channel.id });
    } catch (error) {
        logger.error('[API /me/stream-team POST /signup] Error', { userId: req.user?.id, error: error.message });
        res.status(500).json({ error: 'An error occurred while submitting your application.' });
    }
});

export default router;
