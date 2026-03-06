import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { generateTranscript } from '../utils/transcript-generator.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
 * @returns {Promise<Object>} Result object with success status
 */
async function closeTicket(client, guild, channel, ticket, closer, panelConfig = null) {
    try {
        const saveTranscript = panelConfig?.save_transcripts !== false; // Default to true
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
        } else {
            logger.info(`Ticket #${ticket.id} closed without transcript (save_transcripts disabled)`, { guildId: guild.id, category: 'tickets' });
        }

        // 4. Update database
        await pool.execute(
            'UPDATE tickets SET status = ?, closed_at = NOW(), closed_by_id = ?, transcript_url = ? WHERE id = ?',
            ['closed', closer.id, transcriptUrl, ticket.id]
        );

        // 5. DM the user
        const ticketOwner = await client.users.fetch(ticket.user_id).catch(() => null);
        if (ticketOwner) {
            const dmEmbed = new EmbedBuilder()
                .setColor('#5865F2')
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
                        .setColor('#E74C3C')
                        .setTitle('🔒 Ticket Closed')
                        .setDescription(`Ticket **#${ticket.id}** has been closed.`)
                        .addFields(
                            { name: '👤 Opened By', value: ticketOwner ? `${ticketOwner}` : `<@${ticket.user_id}>`, inline: true },
                            { name: '🔒 Closed By', value: `${closer}`, inline: true },
                            { name: '📋 Panel', value: panelConfig.panel_name || 'Default', inline: true }
                        )
                        .setFooter({ text: `Ticket #${ticket.id}` })
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

        setTimeout(async () => {
            await channel.delete('Ticket closed and archived.');
        }, 5000);

        return { success: true };

    } catch (error) {
        logger.error(`Failed to close and archive ticket ${channel.id}:`, error);
        return { success: false, error: error };
    }
}

export { closeTicket };
