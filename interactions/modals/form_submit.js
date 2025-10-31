const { EmbedBuilder } = require('discord.js');
const { db } = require('../../utils/db');
const { logger } = require('../../utils/logger');

module.exports = {
    customId: /^form_submit_/,

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const formId = interaction.customId.replace('form_submit_', '');
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;

        try {
            // Fetch form details
            const [[form]] = await db.execute(
                "SELECT * FROM forms WHERE form_id = ? AND guild_id = ?",
                [formId, guildId]
            );

            if (!form) {
                return interaction.editReply({
                    content: '❌ This form no longer exists.'
                });
            }

            // Fetch questions to match with answers
            const [questions] = await db.execute(
                "SELECT * FROM form_questions WHERE form_id = ? ORDER BY question_order ASC, question_id ASC",
                [formId]
            );

            if (questions.length === 0) {
                return interaction.editReply({
                    content: '❌ This form has no questions.'
                });
            }

            // Collect answers
            const submissionData = {};
            const embedFields = [];

            for (let i = 0; i < questions.length; i++) {
                const question = questions[i];
                const answer = interaction.fields.getTextInputValue(`question_${i}`);

                submissionData[question.question_text] = answer;

                // Add to embed (limit to first 1024 chars for Discord)
                embedFields.push({
                    name: question.question_text.substring(0, 256),
                    value: answer.substring(0, 1024) || '*No answer provided*',
                    inline: false
                });
            }

            // Save submission to database
            await db.execute(
                "INSERT INTO form_submissions (form_id, user_id, guild_id, submission_data) VALUES (?, ?, ?, ?)",
                [formId, userId, guildId, JSON.stringify(submissionData)]
            );

            // Create embed for submission
            const submissionEmbed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(`📋 ${form.form_name} - New Submission`)
                .setAuthor({
                    name: interaction.user.tag,
                    iconURL: interaction.user.displayAvatarURL()
                })
                .addFields(embedFields)
                .setFooter({ text: `User ID: ${userId}` })
                .setTimestamp();

            // If submit channel is configured, send notification there
            if (form.submit_channel_id) {
                try {
                    const channel = await interaction.guild.channels.fetch(form.submit_channel_id);

                    if (channel && channel.isTextBased()) {
                        await channel.send({
                            content: `**New form submission from ${interaction.user}**`,
                            embeds: [submissionEmbed]
                        });
                    }
                } catch (channelError) {
                    logger.warn(`[Form Submit] Could not send to channel ${form.submit_channel_id}:`, channelError);
                }
            }

            // Confirm submission to user
            await interaction.editReply({
                content: `✅ Your submission for **${form.form_name}** has been recorded. Thank you!`
            });

            logger.info(`[Form Submit] User ${userId} submitted form ${form.form_name} (ID: ${formId}) in guild ${guildId}`);

        } catch (error) {
            logger.error('[Form Submit] Error processing submission:', error);

            try {
                await interaction.editReply({
                    content: '❌ An error occurred while submitting your form. Please try again later.'
                });
            } catch (replyError) {
                logger.error('[Form Submit] Could not send error reply:', replyError);
            }
        }
    }
};
