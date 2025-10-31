"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const data = new discord_js_1.SlashCommandBuilder()
    .setName('timedmod')
    .setDescription('Timed moderation commands')
    .addSubcommand(subcommand => subcommand
    .setName('mute')
    .setDescription('Temporarily mute a user')
    .addUserOption(option => option
    .setName('user')
    .setDescription('User to mute')
    .setRequired(true))
    .addStringOption(option => option
    .setName('duration')
    .setDescription('Duration (e.g., 10m, 2h, 1d)')
    .setRequired(true))
    .addStringOption(option => option
    .setName('reason')
    .setDescription('Reason for the mute')
    .setRequired(false)))
    .addSubcommand(subcommand => subcommand
    .setName('ban')
    .setDescription('Temporarily ban a user')
    .addUserOption(option => option
    .setName('user')
    .setDescription('User to ban')
    .setRequired(true))
    .addStringOption(option => option
    .setName('duration')
    .setDescription('Duration (e.g., 10m, 2h, 1d, 7d)')
    .setRequired(true))
    .addStringOption(option => option
    .setName('reason')
    .setDescription('Reason for the ban')
    .setRequired(false)))
    .addSubcommand(subcommand => subcommand
    .setName('role')
    .setDescription('Temporarily add or remove a role')
    .addUserOption(option => option
    .setName('user')
    .setDescription('User to modify')
    .setRequired(true))
    .addRoleOption(option => option
    .setName('role')
    .setDescription('Role to add/remove')
    .setRequired(true))
    .addStringOption(option => option
    .setName('action')
    .setDescription('Add or remove the role')
    .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' })
    .setRequired(true))
    .addStringOption(option => option
    .setName('duration')
    .setDescription('Duration (e.g., 10m, 2h, 1d)')
    .setRequired(true))
    .addStringOption(option => option
    .setName('reason')
    .setDescription('Reason for the action')
    .setRequired(false)))
    .addSubcommand(subcommand => subcommand
    .setName('list')
    .setDescription('List active timed moderation actions')
    .addUserOption(option => option
    .setName('user')
    .setDescription('Filter by specific user (optional)')
    .setRequired(false)))
    .addSubcommand(subcommand => subcommand
    .setName('cancel')
    .setDescription('Cancel a timed moderation action')
    .addIntegerOption(option => option
    .setName('action-id')
    .setDescription('The ID of the action to cancel')
    .setRequired(true)));
async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const client = interaction.client;
    const timedMod = client.timedModeration;
    if (!timedMod) {
        await interaction.reply({
            content: '❌ The timed moderation system is not available.',
            ephemeral: true
        });
        return;
    }
    if (!interaction.guild || !interaction.member) {
        await interaction.reply({
            content: '❌ This command can only be used in a server.',
            ephemeral: true
        });
        return;
    }
    const member = interaction.member;
    try {
        if (subcommand === 'mute') {
            if (!member.permissions.has(discord_js_1.PermissionFlagsBits.ModerateMembers)) {
                await interaction.reply({
                    content: '❌ You need the **Moderate Members** permission to use this command.',
                    ephemeral: true
                });
                return;
            }
            await interaction.deferReply();
            const user = interaction.options.getUser('user', true);
            const duration = interaction.options.getString('duration', true);
            const reason = interaction.options.getString('reason') || 'No reason provided';
            const durationSeconds = timedMod.parseDuration(duration);
            if (!durationSeconds) {
                await interaction.editReply({
                    content: '❌ Invalid duration format. Use formats like: 10m, 2h, 1d'
                });
                return;
            }
            const result = await timedMod.createTimedMute(interaction.guild.id, user.id, interaction.user.id, durationSeconds, reason);
            if (result.success && result.expiresAt) {
                const expiryTimestamp = Math.floor(result.expiresAt.getTime() / 1000);
                await interaction.editReply({
                    content: `✅ **${user.tag}** has been muted for ${duration}.\n**Reason:** ${reason}\n**Expires:** <t:${expiryTimestamp}:R>`
                });
            }
            else {
                await interaction.editReply({
                    content: `❌ ${result.error || 'Failed to mute user.'}`
                });
            }
        }
        else if (subcommand === 'ban') {
            if (!member.permissions.has(discord_js_1.PermissionFlagsBits.BanMembers)) {
                await interaction.reply({
                    content: '❌ You need the **Ban Members** permission to use this command.',
                    ephemeral: true
                });
                return;
            }
            await interaction.deferReply();
            const user = interaction.options.getUser('user', true);
            const duration = interaction.options.getString('duration', true);
            const reason = interaction.options.getString('reason') || 'No reason provided';
            const durationSeconds = timedMod.parseDuration(duration);
            if (!durationSeconds) {
                await interaction.editReply({
                    content: '❌ Invalid duration format. Use formats like: 10m, 2h, 1d, 7d'
                });
                return;
            }
            const result = await timedMod.createTimedBan(interaction.guild.id, user.id, interaction.user.id, durationSeconds, reason);
            if (result.success && result.expiresAt) {
                const expiryTimestamp = Math.floor(result.expiresAt.getTime() / 1000);
                await interaction.editReply({
                    content: `✅ **${user.tag}** has been temporarily banned for ${duration}.\n**Reason:** ${reason}\n**Expires:** <t:${expiryTimestamp}:R>`
                });
            }
            else {
                await interaction.editReply({
                    content: `❌ ${result.error || 'Failed to ban user.'}`
                });
            }
        }
        else if (subcommand === 'role') {
            if (!member.permissions.has(discord_js_1.PermissionFlagsBits.ManageRoles)) {
                await interaction.reply({
                    content: '❌ You need the **Manage Roles** permission to use this command.',
                    ephemeral: true
                });
                return;
            }
            await interaction.deferReply();
            const user = interaction.options.getUser('user', true);
            const role = interaction.options.getRole('role', true);
            const action = interaction.options.getString('action', true);
            const duration = interaction.options.getString('duration', true);
            const reason = interaction.options.getString('reason') || 'No reason provided';
            const durationSeconds = timedMod.parseDuration(duration);
            if (!durationSeconds) {
                await interaction.editReply({
                    content: '❌ Invalid duration format. Use formats like: 10m, 2h, 1d'
                });
                return;
            }
            const result = await timedMod.createTimedRole(interaction.guild.id, user.id, role.id, interaction.user.id, action === 'add', durationSeconds, reason);
            if (result.success && result.expiresAt) {
                const expiryTimestamp = Math.floor(result.expiresAt.getTime() / 1000);
                const actionText = action === 'add' ? 'given' : 'removed from';
                await interaction.editReply({
                    content: `✅ ${role} has been ${actionText} **${user.tag}** for ${duration}.\n**Reason:** ${reason}\n**Expires:** <t:${expiryTimestamp}:R>`
                });
            }
            else {
                await interaction.editReply({
                    content: `❌ ${result.error || 'Failed to modify role.'}`
                });
            }
        }
        else if (subcommand === 'list') {
            if (!member.permissions.has(discord_js_1.PermissionFlagsBits.ModerateMembers)) {
                await interaction.reply({
                    content: '❌ You need the **Moderate Members** permission to view timed actions.',
                    ephemeral: true
                });
                return;
            }
            await interaction.deferReply({ ephemeral: true });
            const user = interaction.options.getUser('user');
            const actions = await timedMod.getActiveActions(interaction.guild.id, user ? user.id : null);
            if (actions.length === 0) {
                await interaction.editReply({
                    content: user
                        ? `✅ No active timed moderation actions for **${user.tag}**.`
                        : '✅ No active timed moderation actions on this server.'
                });
                return;
            }
            const embed = new discord_js_1.EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('⏰ Active Timed Moderation Actions')
                .setDescription(actions.map(a => {
                const expiryTimestamp = Math.floor(new Date(a.expires_at).getTime() / 1000);
                return `**ID ${a.id}** | <@${a.user_id}>\nType: ${a.action_type}\nExpires: <t:${expiryTimestamp}:R>\nReason: ${a.reason || 'None'}`;
            }).join('\n\n'))
                .setFooter({ text: `Total: ${actions.length} action(s)` })
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        }
        else if (subcommand === 'cancel') {
            if (!member.permissions.has(discord_js_1.PermissionFlagsBits.ModerateMembers)) {
                await interaction.reply({
                    content: '❌ You need the **Moderate Members** permission to cancel timed actions.',
                    ephemeral: true
                });
                return;
            }
            await interaction.deferReply();
            const actionId = interaction.options.getInteger('action-id', true);
            const result = await timedMod.cancelAction(actionId, interaction.guild.id);
            if (result.success) {
                await interaction.editReply({
                    content: `✅ Timed moderation action #${actionId} has been cancelled.`
                });
            }
            else {
                await interaction.editReply({
                    content: `❌ ${result.error || 'Failed to cancel action. Make sure the ID is correct.'}`
                });
            }
        }
    }
    catch (error) {
        console.error('[TimedMod Command Error]', error);
        const replyMethod = interaction.deferred ? 'editReply' : 'reply';
        await interaction[replyMethod]({
            content: '❌ An error occurred while processing this command.',
            ephemeral: true
        });
    }
}
// Export using CommonJS pattern
module.exports = {
    data,
    execute,
    category: 'moderation'
};
