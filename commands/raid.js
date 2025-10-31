"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const data = new discord_js_1.SlashCommandBuilder()
    .setName('raid')
    .setDescription('Raid protection commands')
    .addSubcommand(subcommand => subcommand
    .setName('config')
    .setDescription('Configure raid protection settings (Admin only)')
    .addIntegerOption(option => option
    .setName('join-limit')
    .setDescription('Max joins allowed per interval (default: 10)')
    .setMinValue(1)
    .setMaxValue(50)
    .setRequired(false))
    .addIntegerOption(option => option
    .setName('interval')
    .setDescription('Time interval in seconds (default: 10)')
    .setMinValue(5)
    .setMaxValue(300)
    .setRequired(false))
    .addIntegerOption(option => option
    .setName('lockdown-threshold')
    .setDescription('Joins needed to trigger auto-lockdown (default: 15)')
    .setMinValue(5)
    .setMaxValue(100)
    .setRequired(false))
    .addIntegerOption(option => option
    .setName('account-age')
    .setDescription('Minimum account age in days (0 = disabled)')
    .setMinValue(0)
    .setMaxValue(365)
    .setRequired(false)))
    .addSubcommand(subcommand => subcommand
    .setName('enable')
    .setDescription('Enable raid protection (Admin only)'))
    .addSubcommand(subcommand => subcommand
    .setName('disable')
    .setDescription('Disable raid protection (Admin only)'))
    .addSubcommand(subcommand => subcommand
    .setName('lockdown')
    .setDescription('Manually activate server lockdown (Admin only)')
    .addIntegerOption(option => option
    .setName('duration')
    .setDescription('Lockdown duration in minutes (default: 10)')
    .setMinValue(1)
    .setMaxValue(1440)
    .setRequired(false)))
    .addSubcommand(subcommand => subcommand
    .setName('unlock')
    .setDescription('End server lockdown (Admin only)'))
    .addSubcommand(subcommand => subcommand
    .setName('status')
    .setDescription('View raid protection status'))
    .addSubcommand(subcommand => subcommand
    .setName('events')
    .setDescription('View recent raid detection events (Admin only)')
    .addIntegerOption(option => option
    .setName('limit')
    .setDescription('Number of events to show (default: 10)')
    .setMinValue(1)
    .setMaxValue(50)
    .setRequired(false)));
async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const client = interaction.client;
    const raidProtection = client.raidProtection;
    if (!raidProtection) {
        await interaction.reply({
            content: '❌ The raid protection system is not available.',
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
        if (subcommand === 'config') {
            if (!member.permissions.has(discord_js_1.PermissionFlagsBits.Administrator)) {
                await interaction.reply({
                    content: '❌ You need the **Administrator** permission to configure raid protection.',
                    ephemeral: true
                });
                return;
            }
            await interaction.deferReply({ ephemeral: true });
            const settings = {
                joinLimit: interaction.options.getInteger('join-limit'),
                interval: interaction.options.getInteger('interval'),
                lockdownThreshold: interaction.options.getInteger('lockdown-threshold'),
                accountAge: interaction.options.getInteger('account-age')
            };
            const updates = {};
            if (settings.joinLimit !== null)
                updates.join_rate_limit = settings.joinLimit;
            if (settings.interval !== null)
                updates.join_rate_interval = settings.interval;
            if (settings.lockdownThreshold !== null)
                updates.lockdown_threshold = settings.lockdownThreshold;
            if (settings.accountAge !== null)
                updates.min_account_age_days = settings.accountAge;
            if (Object.keys(updates).length === 0) {
                const config = await raidProtection.getConfig(interaction.guild.id);
                if (!config) {
                    await interaction.editReply({
                        content: '❌ Raid protection is not configured. Use the options to set it up.'
                    });
                    return;
                }
                const embed = new discord_js_1.EmbedBuilder()
                    .setColor('#FF6B6B')
                    .setTitle('🛡️ Raid Protection Configuration')
                    .addFields({ name: 'Status', value: config.enabled ? '🟢 Enabled' : '🔴 Disabled', inline: true }, { name: 'Join Rate Limit', value: `${config.join_rate_limit} joins`, inline: true }, { name: 'Rate Interval', value: `${config.join_rate_interval}s`, inline: true }, { name: 'Lockdown Threshold', value: `${config.lockdown_threshold} joins`, inline: true }, { name: 'Min Account Age', value: config.min_account_age_days > 0 ? `${config.min_account_age_days} days` : 'Disabled', inline: true }, { name: 'Alert Channel', value: config.alert_channel_id ? `<#${config.alert_channel_id}>` : 'Not set', inline: true })
                    .setFooter({ text: 'Use /raid config with options to update settings' })
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
                return;
            }
            const result = await raidProtection.updateConfig(interaction.guild.id, updates);
            if (result.success) {
                await interaction.editReply({
                    content: '✅ Raid protection settings have been updated!'
                });
            }
            else {
                await interaction.editReply({
                    content: `❌ ${result.error || 'Failed to update settings.'}`
                });
            }
        }
        else if (subcommand === 'enable') {
            if (!member.permissions.has(discord_js_1.PermissionFlagsBits.Administrator)) {
                await interaction.reply({
                    content: '❌ You need the **Administrator** permission to enable raid protection.',
                    ephemeral: true
                });
                return;
            }
            await interaction.deferReply();
            const result = await raidProtection.setEnabled(interaction.guild.id, true);
            if (result.success) {
                await interaction.editReply({
                    content: '✅ Raid protection has been **enabled**. The server is now protected!'
                });
            }
            else {
                await interaction.editReply({
                    content: `❌ ${result.error || 'Failed to enable raid protection.'}`
                });
            }
        }
        else if (subcommand === 'disable') {
            if (!member.permissions.has(discord_js_1.PermissionFlagsBits.Administrator)) {
                await interaction.reply({
                    content: '❌ You need the **Administrator** permission to disable raid protection.',
                    ephemeral: true
                });
                return;
            }
            await interaction.deferReply();
            const result = await raidProtection.setEnabled(interaction.guild.id, false);
            if (result.success) {
                await interaction.editReply({
                    content: '⚠️ Raid protection has been **disabled**.'
                });
            }
            else {
                await interaction.editReply({
                    content: `❌ ${result.error || 'Failed to disable raid protection.'}`
                });
            }
        }
        else if (subcommand === 'lockdown') {
            if (!member.permissions.has(discord_js_1.PermissionFlagsBits.Administrator)) {
                await interaction.reply({
                    content: '❌ You need the **Administrator** permission to activate lockdown.',
                    ephemeral: true
                });
                return;
            }
            await interaction.deferReply();
            const duration = interaction.options.getInteger('duration') || 10;
            const result = await raidProtection.activateLockdown(interaction.guild, duration, interaction.user.tag);
            if (result.success) {
                await interaction.editReply({
                    content: `🔒 **Server lockdown activated!**\nDuration: ${duration} minutes\nAll new joins will be kicked.`
                });
            }
            else {
                await interaction.editReply({
                    content: `❌ ${result.error || 'Failed to activate lockdown.'}`
                });
            }
        }
        else if (subcommand === 'unlock') {
            if (!member.permissions.has(discord_js_1.PermissionFlagsBits.Administrator)) {
                await interaction.reply({
                    content: '❌ You need the **Administrator** permission to end lockdown.',
                    ephemeral: true
                });
                return;
            }
            await interaction.deferReply();
            const result = await raidProtection.deactivateLockdown(interaction.guild.id);
            if (result.success) {
                await interaction.editReply({
                    content: '🔓 **Server lockdown ended.** New members can join again.'
                });
            }
            else {
                await interaction.editReply({
                    content: `❌ ${result.error || 'Failed to end lockdown.'}`
                });
            }
        }
        else if (subcommand === 'status') {
            await interaction.deferReply({ ephemeral: true });
            const status = await raidProtection.getStatus(interaction.guild.id);
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(status.lockdownActive ? '#FF0000' : status.enabled ? '#57F287' : '#99AAB5')
                .setTitle('🛡️ Raid Protection Status')
                .addFields({ name: 'Protection', value: status.enabled ? '🟢 Enabled' : '🔴 Disabled', inline: true }, { name: 'Lockdown', value: status.lockdownActive ? '🔒 Active' : '🔓 Inactive', inline: true });
            if (status.lockdownActive && status.lockdownExpiry) {
                embed.addFields({
                    name: 'Lockdown Ends',
                    value: `<t:${Math.floor(status.lockdownExpiry / 1000)}:R>`,
                    inline: true
                });
            }
            await interaction.editReply({ embeds: [embed] });
        }
        else if (subcommand === 'events') {
            if (!member.permissions.has(discord_js_1.PermissionFlagsBits.ModerateMembers)) {
                await interaction.reply({
                    content: '❌ You need the **Moderate Members** permission to view raid events.',
                    ephemeral: true
                });
                return;
            }
            await interaction.deferReply({ ephemeral: true });
            const limit = interaction.options.getInteger('limit') || 10;
            const events = await raidProtection.getRecentEvents(interaction.guild.id, limit);
            if (events.length === 0) {
                await interaction.editReply({
                    content: '✅ No raid events have been detected recently.'
                });
                return;
            }
            const embed = new discord_js_1.EmbedBuilder()
                .setColor('#FF6B6B')
                .setTitle('🚨 Recent Raid Detection Events')
                .setDescription(events.map(e => `**<t:${Math.floor(new Date(e.timestamp).getTime() / 1000)}:R>**\nJoin Rate: ${e.join_rate} users in ${e.interval}s\nAction: ${e.action_taken}`).join('\n\n'))
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        }
    }
    catch (error) {
        console.error('[Raid Command Error]', error);
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
