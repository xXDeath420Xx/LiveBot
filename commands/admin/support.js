import { SlashCommandBuilder, PermissionsBitField, ChannelType } from 'discord.js';
import { execute as handleTicket, autocomplete as ticketAutocomplete } from './support/ticket.js';
import { execute as handleForms, autocomplete as formsAutocomplete } from './support/forms.js';
import { execute as handlePanel } from './support/panel.js';
import logger from '../../utils/logger.js';

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('support')
        .setDescription('Manage support tickets, forms & ticket panels')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)

        // ── Ticket Management Group ──
        .addSubcommandGroup(group =>
            group.setName('ticket')
                .setDescription('Manage support tickets')
                .addSubcommand(sub =>
                    sub.setName('setup')
                        .setDescription('Configure the ticket system for this server')
                        .addRoleOption(opt => opt.setName('support-role').setDescription('The role that can manage tickets').setRequired(true))
                        .addChannelOption(opt => opt.setName('category').setDescription('The category where ticket channels will be created').setRequired(true).addChannelTypes(ChannelType.GuildCategory))
                        .addChannelOption(opt => opt.setName('log-channel').setDescription('Channel where ticket logs will be sent').addChannelTypes(ChannelType.GuildText)))
                .addSubcommand(sub =>
                    sub.setName('panel')
                        .setDescription('Create a ticket panel for users to open tickets')
                        .addStringOption(opt => opt.setName('title').setDescription('Title for the ticket panel'))
                        .addStringOption(opt => opt.setName('description').setDescription('Description for the ticket panel'))
                        .addStringOption(opt => opt.setName('form-name').setDescription('Optional: Use a custom form when users create tickets').setAutocomplete(true)))
                .addSubcommand(sub => sub.setName('claim').setDescription('Claims the current ticket for yourself'))
                .addSubcommand(sub => sub.setName('unclaim').setDescription('Releases the current ticket'))
                .addSubcommand(sub =>
                    sub.setName('transfer')
                        .setDescription('Transfers the current ticket to another staff member')
                        .addUserOption(opt => opt.setName('member').setDescription('The staff member to transfer to').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('close')
                        .setDescription('Closes the current ticket and generates a transcript')
                        .addStringOption(opt => opt.setName('reason').setDescription('Reason for closing the ticket')))
                .addSubcommand(sub =>
                    sub.setName('add')
                        .setDescription('Add a user to the current ticket')
                        .addUserOption(opt => opt.setName('user').setDescription('The user to add').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('remove')
                        .setDescription('Remove a user from the current ticket')
                        .addUserOption(opt => opt.setName('user').setDescription('The user to remove').setRequired(true))))

        // ── Ticket Forms Group ──
        .addSubcommandGroup(group =>
            group.setName('forms')
                .setDescription('Manage ticket intake forms')
                .addSubcommand(sub =>
                    sub.setName('create')
                        .setDescription('Create a new form template')
                        .addStringOption(opt => opt.setName('name').setDescription('A unique name for this form').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('delete')
                        .setDescription('Delete a ticket form')
                        .addStringOption(opt => opt.setName('name').setDescription('The form to delete').setRequired(true).setAutocomplete(true)))
                .addSubcommand(sub =>
                    sub.setName('add-question')
                        .setDescription('Add a question to a form')
                        .addStringOption(opt => opt.setName('form-name').setDescription('Which form to add the question to').setRequired(true).setAutocomplete(true))
                        .addStringOption(opt => opt.setName('question-text').setDescription('The question to ask').setRequired(true))
                        .addStringOption(opt => opt.setName('question-type').setDescription('Answer format').setRequired(true)
                            .addChoices({ name: 'Short Text (Single Line)', value: 'text' }, { name: 'Paragraph (Multi-Line)', value: 'paragraph' })))
                .addSubcommand(sub => sub.setName('list').setDescription('View all ticket forms')))

        // ── Panel Management Group ──
        .addSubcommandGroup(group =>
            group.setName('panel')
                .setDescription('Manage advanced ticket panels')
                .addSubcommand(sub => sub.setName('list').setDescription('List all ticket panels'))
                .addSubcommand(sub => sub.setName('create').setDescription('Create a new ticket panel'))
                .addSubcommand(sub =>
                    sub.setName('edit')
                        .setDescription('Edit an existing ticket panel')
                        .addIntegerOption(opt => opt.setName('panel_id').setDescription('The panel ID to edit').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('deploy')
                        .setDescription('Deploy a ticket panel to its channel')
                        .addIntegerOption(opt => opt.setName('panel_id').setDescription('The panel ID to deploy').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('delete')
                        .setDescription('Delete a ticket panel')
                        .addIntegerOption(opt => opt.setName('panel_id').setDescription('The panel ID to delete').setRequired(true)))),

    async autocomplete(interaction) {
        const group = interaction.options.getSubcommandGroup();
        if (group === 'ticket') {
            return await ticketAutocomplete(interaction);
        }
        if (group === 'forms') {
            return await formsAutocomplete(interaction);
        }
    },

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();

        try {
            switch (group) {
                case 'ticket':
                    return await handleTicket(interaction);
                case 'forms':
                    return await handleForms(interaction);
                case 'panel':
                    return await handlePanel(interaction);
            }
        } catch (error) {
            logger.error('[Support Command] Error:', { error: error.message, group, stack: error.stack });

            const reply = { content: `Error: ${error.message}`, ephemeral: true };
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(reply);
            } else {
                await interaction.reply(reply);
            }
        }
    }
};
