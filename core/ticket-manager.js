"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.closeTicket = closeTicket;
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const transcript_generator_1 = require("../utils/transcript-generator");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
async function closeTicket(client, guild, channel, ticket, closer) {
    try {
        // 1. Fetch all messages
        let allMessages = [];
        let lastId;
        while (true) {
            const options = { limit: 100 };
            if (lastId) {
                options.before = lastId;
            }
            const messages = await channel.messages.fetch(options);
            if (messages.size === 0)
                break;
            allMessages.push(...messages.values());
            lastId = messages.last()?.id;
        }
        allMessages.reverse(); // Sort from oldest to newest
        // 2. Generate HTML
        const transcriptHtml = (0, transcript_generator_1.generateTranscript)(allMessages);
        // 3. Save transcript
        const transcriptDir = path_1.default.join(__dirname, '..', 'uploads', 'transcripts');
        if (!fs_1.default.existsSync(transcriptDir)) {
            fs_1.default.mkdirSync(transcriptDir, { recursive: true });
        }
        const fileName = `transcript-${ticket.id}-${guild.id}.html`;
        const filePath = path_1.default.join(transcriptDir, fileName);
        fs_1.default.writeFileSync(filePath, transcriptHtml);
        // 4. Update database
        const transcriptUrl = `https://certifriedmultitool.com/transcripts/${fileName}`;
        await db_1.default.execute('UPDATE tickets SET status = ?, closed_at = NOW(), closed_by_id = ?, transcript_url = ? WHERE id = ?', ['closed', closer.id, transcriptUrl, ticket.id]);
        // 5. DM the user
        const ticketOwner = await client.users.fetch(ticket.user_id).catch(() => null);
        if (ticketOwner) {
            const dmEmbed = new discord_js_1.EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('Ticket Closed')
                .setDescription(`Your ticket in **${guild.name}** has been closed. A transcript has been saved for your records.\n\nPlease rate the support you received:`)
                .addFields({ name: 'View Transcript', value: `[Click here](${transcriptUrl})` })
                .setTimestamp();
            const feedbackRow = new discord_js_1.ActionRowBuilder();
            for (let i = 1; i <= 5; i++) {
                feedbackRow.addComponents(new discord_js_1.ButtonBuilder()
                    .setCustomId(`ticket_feedback_${ticket.id}_${i}`)
                    .setLabel('⭐'.repeat(i))
                    .setStyle(discord_js_1.ButtonStyle.Primary));
            }
            await ticketOwner.send({ embeds: [dmEmbed], components: [feedbackRow] }).catch(() => { });
        }
        // 6. Log and delete channel
        logger_1.default.info(`Ticket #${ticket.id} closed and transcript saved by ${closer.tag}.`, { guildId: guild.id, category: 'tickets' });
        setTimeout(async () => {
            await channel.delete('Ticket closed and archived.');
        }, 5000);
        return { success: true };
    }
    catch (error) {
        logger_1.default.error(`Failed to close and archive ticket ${channel.id}:`, error);
        return { success: false, error: error };
    }
}
