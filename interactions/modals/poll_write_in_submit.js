import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

/**
 * Handle poll write-in submission
 * Stores the custom answer and allows others to vote on it
 */
export async function handlePollWriteInSubmit(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        // Extract poll ID from custom ID
        const pollId = interaction.customId.replace('poll_write_in_submit_', '');
        const answer = interaction.fields.getTextInputValue('write_in_answer').trim();

        if (!answer || answer.length === 0) {
            await interaction.editReply({ content: 'Please provide a valid answer.' });
            return;
        }

        // Get poll from database
        const [[poll]] = await pool.execute(
            'SELECT * FROM polls WHERE id = ? AND status = "active"',
            [pollId]
        );

        if (!poll) {
            await interaction.editReply({ content: 'This poll is no longer active.' });
            return;
        }

        if (!poll.allow_write_in) {
            await interaction.editReply({ content: 'Write-in answers are not enabled for this poll.' });
            return;
        }

        // Get existing write-in answers
        let writeInAnswers = [];
        if (poll.write_in_answers) {
            try {
                writeInAnswers = JSON.parse(poll.write_in_answers);
            } catch (e) {
                logger.error('[Poll Write-In] Error parsing write_in_answers:', e);
                writeInAnswers = [];
            }
        }

        // Check if user already submitted a write-in
        const existingIndex = writeInAnswers.findIndex(w => w.user_id === interaction.user.id);

        if (existingIndex >= 0) {
            // Update existing write-in
            writeInAnswers[existingIndex].answer = answer;
            writeInAnswers[existingIndex].updated_at = new Date().toISOString();
        } else {
            // Add new write-in
            writeInAnswers.push({
                user_id: interaction.user.id,
                answer: answer,
                created_at: new Date().toISOString()
            });
        }

        // Save to database
        await pool.execute(
            'UPDATE polls SET write_in_answers = ? WHERE id = ?',
            [JSON.stringify(writeInAnswers), pollId]
        );

        logger.info(`[Poll Write-In] User ${interaction.user.tag} submitted write-in for poll ${pollId}`, {
            pollId,
            userId: interaction.user.id,
            answer,
            guildId: poll.guild_id
        });

        // Update the poll message to show write-in options
        await updatePollMessage(interaction.client, poll, writeInAnswers);

        await interaction.editReply({
            content: `✅ Your answer "${answer}" has been added to the poll! Other users can now vote on it.`
        });

    } catch (error) {
        logger.error('[Poll Write-In Submit Error]', error);
        await interaction.editReply({
            content: 'An error occurred while submitting your answer.'
        }).catch(() => {});
    }
}

/**
 * Update the poll message to include write-in options
 */
async function updatePollMessage(client, poll, writeInAnswers) {
    try {
        const guild = client.guilds.cache.get(poll.guild_id);
        if (!guild) return;

        const channel = guild.channels.cache.get(poll.channel_id);
        if (!channel) return;

        const message = await channel.messages.fetch(poll.message_id).catch(() => null);
        if (!message) return;

        // Parse standard options
        const standardOptions = JSON.parse(poll.options);

        // Build options description
        const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

        // Get votes
        let votes = {};
        if (poll.votes) {
            try {
                votes = JSON.parse(poll.votes);
            } catch (e) {
                votes = {};
            }
        }

        // Format standard options
        let description = '';
        for (let i = 0; i < standardOptions.length; i++) {
            const voteCount = Object.values(votes).filter(v =>
                Array.isArray(v) ? v.includes(i) : v === i
            ).length;
            description += `${emojis[i]} **${standardOptions[i]}** - ${voteCount} vote${voteCount !== 1 ? 's' : ''}\n`;
        }

        // Format write-in options
        if (writeInAnswers.length > 0) {
            description += '\n**✍️ Write-In Answers:**\n';
            for (let i = 0; i < writeInAnswers.length; i++) {
                const writeInIndex = standardOptions.length + i;
                const voteCount = Object.values(votes).filter(v =>
                    Array.isArray(v) ? v.includes(writeInIndex) : v === writeInIndex
                ).length;
                const author = await client.users.fetch(writeInAnswers[i].user_id).catch(() => null);
                description += `🔹 **${writeInAnswers[i].answer}** (by ${author ? author.username : 'Unknown'}) - ${voteCount} vote${voteCount !== 1 ? 's' : ''}\n`;
            }
        }

        // Update embed
        const embed = EmbedBuilder.from(message.embeds[0]);
        embed.setDescription(description);

        // Create updated buttons (standard options + write-ins)
        const rows = [];
        let currentRow = new ActionRowBuilder();
        let buttonsInRow = 0;

        // Standard option buttons
        for (let i = 0; i < standardOptions.length; i++) {
            if (buttonsInRow >= 5) {
                rows.push(currentRow);
                currentRow = new ActionRowBuilder();
                buttonsInRow = 0;
            }

            const button = new ButtonBuilder()
                .setCustomId(`poll_vote_${i}`)
                .setLabel(standardOptions[i])
                .setStyle(ButtonStyle.Primary)
                .setEmoji(emojis[i]);

            currentRow.addComponents(button);
            buttonsInRow++;
        }

        // Write-in option buttons
        for (let i = 0; i < writeInAnswers.length; i++) {
            if (buttonsInRow >= 5) {
                rows.push(currentRow);
                currentRow = new ActionRowBuilder();
                buttonsInRow = 0;
            }

            const writeInIndex = standardOptions.length + i;
            const button = new ButtonBuilder()
                .setCustomId(`poll_vote_${writeInIndex}`)
                .setLabel(writeInAnswers[i].answer.substring(0, 80)) // Discord button label limit
                .setStyle(ButtonStyle.Success)
                .setEmoji('🔹');

            currentRow.addComponents(button);
            buttonsInRow++;
        }

        if (buttonsInRow > 0) rows.push(currentRow);

        // Add write-in button
        const writeInRow = new ActionRowBuilder();
        const writeInButton = new ButtonBuilder()
            .setCustomId('poll_write_in')
            .setLabel('Write Your Own Answer')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('✍️');

        writeInRow.addComponents(writeInButton);
        rows.push(writeInRow);

        await message.edit({ embeds: [embed], components: rows });

        logger.info(`[Poll Write-In] Updated poll message with ${writeInAnswers.length} write-in(s)`, {
            pollId: poll.id,
            guildId: poll.guild_id
        });

    } catch (error) {
        logger.error('[Poll Write-In] Error updating poll message:', error);
    }
}

export default handlePollWriteInSubmit;
