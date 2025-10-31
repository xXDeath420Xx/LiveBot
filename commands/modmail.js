"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
module.exports = {
    data: new discord_js_1.SlashCommandBuilder()
        .setName('modmail')
        .setDescription('Modmail system commands')
        .addSubcommand(subcommand => subcommand
        .setName('setup')
        .setDescription('Set up the modmail system (Admin only)')
        .addChannelOption(option => option
        .setName('category')
        .setDescription('Category where modmail threads will be created')
        .addChannelTypes(discord_js_1.ChannelType.GuildCategory)
        .setRequired(true))
        .addRoleOption(option => option
        .setName('staff-role')
        .setDescription('Role that can respond to modmail threads')
        .setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('close')
        .setDescription('Close the current modmail thread')
        .addStringOption(option => option
        .setName('reason')
        .setDescription('Reason for closing the thread')
        .setRequired(false)))
        .addSubcommand(subcommand => subcommand
        .setName('config')
        .setDescription('View or edit modmail configuration (Admin only)'))
        .addSubcommand(subcommand => subcommand
        .setName('block')
        .setDescription('Block a user from using modmail (Admin only)')
        .addUserOption(option => option
        .setName('user')
        .setDescription('User to block')
        .setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('unblock')
        .setDescription('Unblock a user from using modmail (Admin only)')
        .addUserOption(option => option
        .setName('user')
        .setDescription('User to unblock')
        .setRequired(true))),
    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const modmail = interaction.client.modmail;
        if (!modmail) {
            await interaction.reply({
                content: '❌ The modmail system is not available.',
                ephemeral: true
            });
            return;
        }
        try {
            if (subcommand === 'setup') {
                const member = interaction.member;
                if (!member.permissions.has(discord_js_1.PermissionFlagsBits.ManageGuild)) {
                    await interaction.reply({
                        content: '❌ You need the **Manage Server** permission to set up modmail.',
                        ephemeral: true
                    });
                    return;
                }
                await interaction.deferReply({ ephemeral: true });
                const category = interaction.options.getChannel('category');
                const staffRole = interaction.options.getRole('staff-role');
                const result = await modmail.setupModmail(interaction.guild.id, category.id, staffRole.id);
                if (result.success) {
                    await interaction.editReply({
                        content: `✅ Modmail has been set up!\n\n📁 Category: ${category}\n👥 Staff Role: ${staffRole}\n\n**Users can now DM the bot to open a modmail thread.**`
                    });
                }
                else {
                    await interaction.editReply({
                        content: `❌ ${result.error || 'Failed to set up modmail.'}`
                    });
                }
            }
            else if (subcommand === 'close') {
                await interaction.deferReply();
                const reason = interaction.options.getString('reason') || 'No reason provided';
                const result = await modmail.closeThread(interaction.guild.id, interaction.channel.id, interaction.user.id, reason);
                if (result.success) {
                    await interaction.editReply({
                        content: `✅ Modmail thread closed.\n**Reason:** ${reason}`
                    });
                }
                else {
                    await interaction.editReply({
                        content: `❌ ${result.error || 'Failed to close thread. Is this a modmail channel?'}`
                    });
                }
            }
            else if (subcommand === 'config') {
                const member = interaction.member;
                if (!member.permissions.has(discord_js_1.PermissionFlagsBits.ManageGuild)) {
                    await interaction.reply({
                        content: '❌ You need the **Manage Server** permission to view modmail config.',
                        ephemeral: true
                    });
                    return;
                }
                await interaction.deferReply({ ephemeral: true });
                const config = await modmail.getConfig(interaction.guild.id);
                if (!config) {
                    await interaction.editReply({
                        content: '❌ Modmail is not set up on this server. Use `/modmail setup` to configure it.'
                    });
                    return;
                }
                const category = interaction.guild.channels.cache.get(config.category_id);
                const staffRole = interaction.guild.roles.cache.get(config.staff_role_id);
                const embed = new discord_js_1.EmbedBuilder()
                    .setColor('#5865F2')
                    .setTitle('📬 Modmail Configuration')
                    .addFields({ name: 'Status', value: config.enabled ? '🟢 Enabled' : '🔴 Disabled', inline: true }, { name: 'Category', value: category ? category.toString() : 'Not found', inline: true }, { name: 'Staff Role', value: staffRole ? staffRole.toString() : 'Not found', inline: true }, { name: 'Greeting Message', value: config.greeting_message || 'Default greeting', inline: false }, { name: 'Closing Message', value: config.closing_message || 'Default closing', inline: false })
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
            }
            else if (subcommand === 'block') {
                const member = interaction.member;
                if (!member.permissions.has(discord_js_1.PermissionFlagsBits.ModerateMembers)) {
                    await interaction.reply({
                        content: '❌ You need the **Moderate Members** permission to block users from modmail.',
                        ephemeral: true
                    });
                    return;
                }
                await interaction.deferReply({ ephemeral: true });
                const user = interaction.options.getUser('user');
                const result = await modmail.blockUser(interaction.guild.id, user.id);
                if (result.success) {
                    await interaction.editReply({
                        content: `✅ **${user.tag}** has been blocked from using modmail.`
                    });
                }
                else {
                    await interaction.editReply({
                        content: `❌ ${result.error || 'Failed to block user.'}`
                    });
                }
            }
            else if (subcommand === 'unblock') {
                const member = interaction.member;
                if (!member.permissions.has(discord_js_1.PermissionFlagsBits.ModerateMembers)) {
                    await interaction.reply({
                        content: '❌ You need the **Moderate Members** permission to unblock users from modmail.',
                        ephemeral: true
                    });
                    return;
                }
                await interaction.deferReply({ ephemeral: true });
                const user = interaction.options.getUser('user');
                const result = await modmail.unblockUser(interaction.guild.id, user.id);
                if (result.success) {
                    await interaction.editReply({
                        content: `✅ **${user.tag}** can now use modmail again.`
                    });
                }
                else {
                    await interaction.editReply({
                        content: `❌ ${result.error || 'Failed to unblock user.'}`
                    });
                }
            }
        }
        catch (error) {
            console.error('[Modmail Command Error]', error);
            const replyMethod = interaction.deferred ? 'editReply' : 'reply';
            await interaction[replyMethod]({
                content: '❌ An error occurred while processing this command.',
                ephemeral: true
            });
        }
    },
    category: 'moderation'
};
