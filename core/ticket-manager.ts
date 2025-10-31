import { Client, Guild, TextChannel, User, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Message } from 'discord.js';
import { RowDataPacket } from 'mysql2';
import db from '../utils/db';
import logger from '../utils/logger';
import { generateTranscript } from '../utils/transcript-generator';
import fs from 'fs';
import path from 'path';

interface TicketRow extends RowDataPacket {
    id: number;
    guild_id: string;
    user_id: string;
    channel_id: string;
    status: string;
    created_at: Date;
    closed_at: Date | null;
    closed_by_id: string | null;
    transcript_url: string | null;
}

interface CloseTicketResult {
    success: boolean;
    error?: Error;
}

async function closeTicket(client: Client, guild: Guild, channel: TextChannel, ticket: TicketRow, closer: User): Promise<CloseTicketResult> {
    try {
        // 1. Fetch all messages
        let allMessages: Message[] = [];
        let lastId: string | undefined;
        while (true) {
            const options: any = { limit: 100 };
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
        const transcriptDir = path.join(__dirname, '..', 'uploads', 'transcripts');
        if (!fs.existsSync(transcriptDir)) {
            fs.mkdirSync(transcriptDir, { recursive: true });
        }
        const fileName = `transcript-${ticket.id}-${guild.id}.html`;
        const filePath = path.join(transcriptDir, fileName);
        fs.writeFileSync(filePath, transcriptHtml);

        // 4. Update database
        const transcriptUrl = `https://certifriedmultitool.com/transcripts/${fileName}`;
        await db.execute(
            'UPDATE tickets SET status = ?, closed_at = NOW(), closed_by_id = ?, transcript_url = ? WHERE id = ?',
            ['closed', closer.id, transcriptUrl, ticket.id]
        );

        // 5. DM the user
        const ticketOwner = await client.users.fetch(ticket.user_id).catch(() => null);
        if (ticketOwner) {
            const dmEmbed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('Ticket Closed')
                .setDescription(`Your ticket in **${guild.name}** has been closed. A transcript has been saved for your records.\n\nPlease rate the support you received:`)
                .addFields({ name: 'View Transcript', value: `[Click here](${transcriptUrl})` })
                .setTimestamp();

            const feedbackRow = new ActionRowBuilder<ButtonBuilder>();
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

        // 6. Log and delete channel
        logger.info(`Ticket #${ticket.id} closed and transcript saved by ${closer.tag}.`, { guildId: guild.id, category: 'tickets' });

        setTimeout(async () => {
            await channel.delete('Ticket closed and archived.');
        }, 5000);

        return { success: true };

    } catch (error) {
        logger.error(`Failed to close and archive ticket ${channel.id}:`, error as Record<string, any>);
        return { success: false, _error: _error as Error };
    }
}

export { closeTicket };
