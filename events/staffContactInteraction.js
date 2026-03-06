import { Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

export default {
    name: Events.InteractionCreate,
    async execute(interaction) {
        // Handle staff contact buttons
        if (interaction.isButton() && interaction.customId.startsWith('staff_')) {
            await handleStaffButton(interaction);
            return;
        }

        // Handle staff contact modal submissions
        if (interaction.isModalSubmit() && interaction.customId.startsWith('staff_modal_')) {
            await handleStaffModal(interaction);
            return;
        }
    }
};

async function handleStaffButton(interaction) {
    try {
        const buttonId = interaction.customId;
        let modal;

        switch (buttonId) {
            case 'staff_report_user':
                modal = new ModalBuilder()
                    .setCustomId('staff_modal_report_user')
                    .setTitle('Report a User')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('reported_user')
                                .setLabel('Who are you reporting?')
                                .setPlaceholder('Username or @mention')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('report_reason')
                                .setLabel('What did they do?')
                                .setPlaceholder('Describe the rule violation or issue...')
                                .setStyle(TextInputStyle.Paragraph)
                                .setRequired(true)
                                .setMaxLength(1000)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('report_evidence')
                                .setLabel('Evidence (optional)')
                                .setPlaceholder('Links to screenshots, message IDs, etc.')
                                .setStyle(TextInputStyle.Paragraph)
                                .setRequired(false)
                                .setMaxLength(500)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('anonymous')
                                .setLabel('Submit anonymously? (yes/no)')
                                .setPlaceholder('Type "yes" to hide your name from the report')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(false)
                                .setMaxLength(10)
                        )
                    );
                break;

            case 'staff_report_scam':
                modal = new ModalBuilder()
                    .setCustomId('staff_modal_report_scam')
                    .setTitle('Report a Scam')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('scammer')
                                .setLabel('Who is the scammer?')
                                .setPlaceholder('Username or @mention')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('scam_details')
                                .setLabel('What happened?')
                                .setPlaceholder('Describe the scam attempt or incident...')
                                .setStyle(TextInputStyle.Paragraph)
                                .setRequired(true)
                                .setMaxLength(1000)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('scam_evidence')
                                .setLabel('Evidence')
                                .setPlaceholder('Screenshots, payment receipts, message links...')
                                .setStyle(TextInputStyle.Paragraph)
                                .setRequired(true)
                                .setMaxLength(500)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('anonymous')
                                .setLabel('Submit anonymously? (yes/no)')
                                .setPlaceholder('Type "yes" to hide your name')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(false)
                                .setMaxLength(10)
                        )
                    );
                break;

            case 'staff_contact':
                modal = new ModalBuilder()
                    .setCustomId('staff_modal_contact')
                    .setTitle('Contact Staff')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('subject')
                                .setLabel('Subject')
                                .setPlaceholder('Brief summary of your message')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setMaxLength(100)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('message')
                                .setLabel('Your Message')
                                .setPlaceholder('What would you like to tell the staff team?')
                                .setStyle(TextInputStyle.Paragraph)
                                .setRequired(true)
                                .setMaxLength(1500)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('contact_back')
                                .setLabel('Should we contact you back? (yes/no)')
                                .setPlaceholder('Type "yes" if you want a response')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(false)
                                .setMaxLength(10)
                        )
                    );
                break;

            case 'staff_suggestion':
                modal = new ModalBuilder()
                    .setCustomId('staff_modal_suggestion')
                    .setTitle('Submit a Suggestion')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('suggestion_title')
                                .setLabel('Suggestion Title')
                                .setPlaceholder('Brief title for your idea')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setMaxLength(100)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('suggestion_details')
                                .setLabel('Details')
                                .setPlaceholder('Describe your suggestion in detail...')
                                .setStyle(TextInputStyle.Paragraph)
                                .setRequired(true)
                                .setMaxLength(1500)
                        )
                    );
                break;

            default:
                return;
        }

        await interaction.showModal(modal);

    } catch (error) {
        logger.error('[StaffContact] Error handling button:', {
            error: error.message,
            customId: interaction.customId
        });

        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'An error occurred. Please try again.',
                ephemeral: true
            }).catch(() => {});
        }
    }
}

async function handleStaffModal(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const modalId = interaction.customId;
        const guild = interaction.guild;

        // Get the reports channel from database
        const [configs] = await pool.execute(
            'SELECT reports_channel_id FROM staff_contact_config WHERE guild_id = ?',
            [guild.id]
        );

        if (configs.length === 0) {
            await interaction.editReply('Staff contact system is not configured for this server.');
            return;
        }

        const reportsChannel = guild.channels.cache.get(configs[0].reports_channel_id);
        if (!reportsChannel) {
            await interaction.editReply('Reports channel not found. Please contact an admin.');
            return;
        }

        let embed;
        let isAnonymous = false;

        switch (modalId) {
            case 'staff_modal_report_user': {
                const reportedUser = interaction.fields.getTextInputValue('reported_user');
                const reason = interaction.fields.getTextInputValue('report_reason');
                const evidence = interaction.fields.getTextInputValue('report_evidence') || 'None provided';
                const anonInput = interaction.fields.getTextInputValue('anonymous')?.toLowerCase();
                isAnonymous = anonInput === 'yes' || anonInput === 'y';

                embed = new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle('🚨 User Report')
                    .addFields(
                        { name: 'Reported User', value: reportedUser, inline: true },
                        { name: 'Reported By', value: isAnonymous ? '*Anonymous*' : `${interaction.user} (${interaction.user.tag})`, inline: true },
                        { name: 'Reason', value: reason, inline: false },
                        { name: 'Evidence', value: evidence, inline: false }
                    )
                    .setTimestamp();
                break;
            }

            case 'staff_modal_report_scam': {
                const scammer = interaction.fields.getTextInputValue('scammer');
                const details = interaction.fields.getTextInputValue('scam_details');
                const evidence = interaction.fields.getTextInputValue('scam_evidence');
                const anonInput = interaction.fields.getTextInputValue('anonymous')?.toLowerCase();
                isAnonymous = anonInput === 'yes' || anonInput === 'y';

                embed = new EmbedBuilder()
                    .setColor(0xFEE75C)
                    .setTitle('⚠️ SCAM REPORT')
                    .addFields(
                        { name: 'Alleged Scammer', value: scammer, inline: true },
                        { name: 'Reported By', value: isAnonymous ? '*Anonymous*' : `${interaction.user} (${interaction.user.tag})`, inline: true },
                        { name: 'What Happened', value: details, inline: false },
                        { name: 'Evidence', value: evidence, inline: false }
                    )
                    .setTimestamp();
                break;
            }

            case 'staff_modal_contact': {
                const subject = interaction.fields.getTextInputValue('subject');
                const message = interaction.fields.getTextInputValue('message');
                const contactBack = interaction.fields.getTextInputValue('contact_back')?.toLowerCase();
                const wantsResponse = contactBack === 'yes' || contactBack === 'y';

                embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('💬 Staff Contact')
                    .addFields(
                        { name: 'From', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
                        { name: 'Wants Response', value: wantsResponse ? 'Yes' : 'No', inline: true },
                        { name: 'Subject', value: subject, inline: false },
                        { name: 'Message', value: message, inline: false }
                    )
                    .setTimestamp();
                break;
            }

            case 'staff_modal_suggestion': {
                const title = interaction.fields.getTextInputValue('suggestion_title');
                const details = interaction.fields.getTextInputValue('suggestion_details');

                embed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('💡 Suggestion')
                    .addFields(
                        { name: 'From', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
                        { name: 'Title', value: title, inline: false },
                        { name: 'Details', value: details, inline: false }
                    )
                    .setTimestamp();
                break;
            }

            default:
                await interaction.editReply('Unknown form type.');
                return;
        }

        // Send to reports channel
        await reportsChannel.send({ embeds: [embed] });

        // Log the submission
        logger.info('[StaffContact] Submission received', {
            type: modalId,
            guildId: guild.id,
            userId: isAnonymous ? 'anonymous' : interaction.user.id
        });

        // Confirm to user
        await interaction.editReply({
            content: '✅ **Submitted successfully!**\n\nYour message has been sent to the staff team. ' +
                (isAnonymous ? 'Your identity will remain anonymous.' : 'Staff may follow up with you if needed.')
        });

    } catch (error) {
        logger.error('[StaffContact] Error handling modal:', {
            error: error.message,
            stack: error.stack,
            customId: interaction.customId
        });

        if (!interaction.replied) {
            await interaction.editReply('An error occurred while submitting. Please try again.').catch(() => {});
        }
    }
}
