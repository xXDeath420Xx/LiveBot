import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { execute as handleSpam } from './protection/spam.js';
import { execute as handleAntiNuke } from './protection/antinuke.js';
import { execute as handleRaid } from './protection/raid.js';
import { execute as handleSelfbot } from './protection/selfbot.js';
import { execute as handleGlobalBan } from './protection/globalban.js';
import logger from '../../utils/logger.js';

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('protection')
        .setDescription('Server protection systems — spam, anti-nuke, raid & selfbot detection')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

        // ── Spam Detection Group ──
        .addSubcommandGroup(group =>
            group.setName('spam')
                .setDescription('Adaptive spam detection system')
                .addSubcommand(sub => sub.setName('enable').setDescription('Enable adaptive spam detection'))
                .addSubcommand(sub => sub.setName('disable').setDescription('Disable adaptive spam detection'))
                .addSubcommand(sub => sub.setName('config').setDescription('Configure adaptive spam settings')
                    .addIntegerOption(opt => opt.setName('cross_channel_threshold').setDescription('Channels with same message to flag (default: 3)').setMinValue(2).setMaxValue(10))
                    .addIntegerOption(opt => opt.setName('cross_channel_timeframe').setDescription('Timeframe for cross-channel detection (minutes, default: 5)').setMinValue(1).setMaxValue(30))
                    .addNumberOption(opt => opt.setName('deviation_multiplier').setDescription('Flag when rate exceeds baseline by this multiplier (default: 2.0)').setMinValue(1.5).setMaxValue(5.0))
                    .addNumberOption(opt => opt.setName('new_account_7d').setDescription('Score multiplier for accounts <7 days old (default: 1.5)').setMinValue(1.0).setMaxValue(3.0))
                    .addNumberOption(opt => opt.setName('new_account_24h').setDescription('Score multiplier for accounts <24h old (default: 2.0)').setMinValue(1.0).setMaxValue(5.0))
                    .addStringOption(opt => opt.setName('action').setDescription('Action to take when spam detected')
                        .addChoices({ name: 'Mute (Recommended)', value: 'mute' }, { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }, { name: 'Alert only', value: 'alert' }))
                    .addChannelOption(opt => opt.setName('alert_channel').setDescription('Channel to send spam alerts').addChannelTypes(ChannelType.GuildText)))
                .addSubcommand(sub => sub.setName('status').setDescription('View current adaptive spam settings'))
                .addSubcommand(sub => sub.setName('user').setDescription('View a user\'s spam profile')
                    .addUserOption(opt => opt.setName('user').setDescription('User to check').setRequired(true)))
                .addSubcommand(sub => sub.setName('patterns').setDescription('View pattern effectiveness rankings'))
                .addSubcommand(sub => sub.setName('reset').setDescription('Reset a user\'s spam profile')
                    .addUserOption(opt => opt.setName('user').setDescription('User to reset').setRequired(true))))

        // ── Anti-Nuke Group ──
        .addSubcommandGroup(group =>
            group.setName('antinuke')
                .setDescription('Anti-nuke protection system')
                .addSubcommand(sub => sub.setName('enable').setDescription('Enable anti-nuke protection'))
                .addSubcommand(sub => sub.setName('disable').setDescription('Disable anti-nuke protection'))
                .addSubcommand(sub => sub.setName('config').setDescription('Configure anti-nuke settings')
                    .addIntegerOption(opt => opt.setName('max_channel_deletes').setDescription('Max channel deletions before action (default: 3)').setMinValue(1).setMaxValue(20))
                    .addIntegerOption(opt => opt.setName('max_role_deletes').setDescription('Max role deletions before action (default: 3)').setMinValue(1).setMaxValue(20))
                    .addIntegerOption(opt => opt.setName('max_bans').setDescription('Max bans before action (default: 3)').setMinValue(1).setMaxValue(20))
                    .addStringOption(opt => opt.setName('action').setDescription('Action to take when triggered')
                        .addChoices({ name: 'Kick the offender', value: 'kick' }, { name: 'Ban the offender', value: 'ban' }, { name: 'Remove roles only', value: 'strip' }, { name: 'Alert only (no action)', value: 'alert' }))
                    .addChannelOption(opt => opt.setName('alert_channel').setDescription('Channel to send anti-nuke alerts')))
                .addSubcommand(sub => sub.setName('status').setDescription('View current anti-nuke settings'))
                .addSubcommand(sub => sub.setName('whitelist').setDescription('Manage anti-nuke whitelist')
                    .addStringOption(opt => opt.setName('action').setDescription('Add or remove from whitelist').setRequired(true)
                        .addChoices({ name: 'Add user', value: 'add' }, { name: 'Remove user', value: 'remove' }, { name: 'List whitelisted users', value: 'list' }))
                    .addUserOption(opt => opt.setName('user').setDescription('User to add/remove from whitelist'))))

        // ── Raid Protection Group ──
        .addSubcommandGroup(group =>
            group.setName('raid')
                .setDescription('Raid detection and protection system')
                .addSubcommand(sub => sub.setName('enable').setDescription('Enable raid protection'))
                .addSubcommand(sub => sub.setName('disable').setDescription('Disable raid protection'))
                .addSubcommand(sub => sub.setName('config').setDescription('Configure raid protection settings')
                    .addIntegerOption(opt => opt.setName('join_threshold').setDescription('Number of joins to trigger raid detection (default: 10)').setMinValue(3).setMaxValue(50))
                    .addIntegerOption(opt => opt.setName('timeframe').setDescription('Timeframe in seconds to count joins (default: 30)').setMinValue(10).setMaxValue(300))
                    .addIntegerOption(opt => opt.setName('account_age').setDescription('Flag accounts younger than this (hours, default: 24)').setMinValue(1).setMaxValue(720))
                    .addNumberOption(opt => opt.setName('account_ratio').setDescription('Ratio of new accounts to trigger (0.5-1.0, default: 0.7)').setMinValue(0.3).setMaxValue(1.0))
                    .addStringOption(opt => opt.setName('action').setDescription('Action to take when raid detected')
                        .addChoices({ name: 'Mute raiders (Recommended)', value: 'mute' }, { name: 'Kick raiders', value: 'kick' }, { name: 'Ban raiders', value: 'ban' }, { name: 'Alert only', value: 'alert' }, { name: 'Lockdown server', value: 'lockdown' }))
                    .addChannelOption(opt => opt.setName('alert_channel').setDescription('Channel to send raid alerts').addChannelTypes(ChannelType.GuildText))
                    .addIntegerOption(opt => opt.setName('mute_duration').setDescription('Mute duration in minutes (default: 60)').setMinValue(1).setMaxValue(10080))
                    .addBooleanOption(opt => opt.setName('purge_messages').setDescription('Purge messages from detected raiders (default: true)')))
                .addSubcommand(sub => sub.setName('status').setDescription('View current raid protection settings'))
                .addSubcommand(sub => sub.setName('history').setDescription('View recent raid incidents'))
                .addSubcommand(sub => sub.setName('resolve').setDescription('Manually resolve an active raid')))

        // ── Self-Bot Detection Group ──
        .addSubcommandGroup(group =>
            group.setName('selfbot')
                .setDescription('Self-bot and automation detection system')
                .addSubcommand(sub => sub.setName('enable').setDescription('Enable self-bot detection'))
                .addSubcommand(sub => sub.setName('disable').setDescription('Disable self-bot detection'))
                .addSubcommand(sub => sub.setName('config').setDescription('Configure self-bot detection settings')
                    .addIntegerOption(opt => opt.setName('min_response_time').setDescription('Flag responses faster than this (ms, default: 50)').setMinValue(10).setMaxValue(500))
                    .addIntegerOption(opt => opt.setName('burst_threshold').setDescription('Messages in burst window to flag (default: 20)').setMinValue(5).setMaxValue(100))
                    .addIntegerOption(opt => opt.setName('burst_window').setDescription('Burst detection window in ms (default: 1000)').setMinValue(100).setMaxValue(5000))
                    .addIntegerOption(opt => opt.setName('pattern_threshold').setDescription('Suspicious patterns before action (default: 3)').setMinValue(1).setMaxValue(10))
                    .addStringOption(opt => opt.setName('action').setDescription('Action to take when self-bot detected')
                        .addChoices({ name: 'Mute (Recommended)', value: 'mute' }, { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }, { name: 'Alert only', value: 'alert' }))
                    .addChannelOption(opt => opt.setName('alert_channel').setDescription('Channel to send detection alerts').addChannelTypes(ChannelType.GuildText))
                    .addIntegerOption(opt => opt.setName('mute_duration').setDescription('Mute duration in minutes (default: 60)').setMinValue(1).setMaxValue(10080))
                    .addBooleanOption(opt => opt.setName('purge_messages').setDescription('Purge messages from detected self-bots (default: true)')))
                .addSubcommand(sub => sub.setName('status').setDescription('View current self-bot detection settings'))
                .addSubcommand(sub => sub.setName('exempt').setDescription('Manage exempt roles')
                    .addStringOption(opt => opt.setName('action').setDescription('Add or remove exempt role').setRequired(true)
                        .addChoices({ name: 'Add role', value: 'add' }, { name: 'Remove role', value: 'remove' }, { name: 'List exempt roles', value: 'list' }))
                    .addRoleOption(opt => opt.setName('role').setDescription('Role to add/remove from exemptions')))
                .addSubcommand(sub => sub.setName('check').setDescription('Manually check a user for self-bot behavior')
                    .addUserOption(opt => opt.setName('user').setDescription('User to check').setRequired(true)))
                .addSubcommand(sub => sub.setName('history').setDescription('View detection history')
                    .addUserOption(opt => opt.setName('user').setDescription('Filter by specific user'))))

        // ── Global Ban Protection Group ──
        .addSubcommandGroup(group =>
            group.setName('globalban')
                .setDescription('Global ban database protection system')
                .addSubcommand(sub => sub.setName('enable').setDescription('Enable global ban protection'))
                .addSubcommand(sub => sub.setName('disable').setDescription('Disable global ban protection'))
                .addSubcommand(sub => sub.setName('config').setDescription('Configure global ban settings')
                    .addStringOption(opt => opt.setName('action_critical').setDescription('Action for critical severity')
                        .addChoices({ name: 'Ban (Default)', value: 'ban' }, { name: 'Kick', value: 'kick' }, { name: 'Alert only', value: 'alert' }, { name: 'None', value: 'none' }))
                    .addStringOption(opt => opt.setName('action_high').setDescription('Action for high severity')
                        .addChoices({ name: 'Ban (Default)', value: 'ban' }, { name: 'Kick', value: 'kick' }, { name: 'Alert only', value: 'alert' }, { name: 'None', value: 'none' }))
                    .addStringOption(opt => opt.setName('action_medium').setDescription('Action for medium severity')
                        .addChoices({ name: 'Ban', value: 'ban' }, { name: 'Kick (Default)', value: 'kick' }, { name: 'Alert only', value: 'alert' }, { name: 'None', value: 'none' }))
                    .addStringOption(opt => opt.setName('action_low').setDescription('Action for low severity')
                        .addChoices({ name: 'Ban', value: 'ban' }, { name: 'Kick', value: 'kick' }, { name: 'Alert only (Default)', value: 'alert' }, { name: 'None', value: 'none' }))
                    .addChannelOption(opt => opt.setName('alert_channel').setDescription('Channel to send global ban alerts').addChannelTypes(ChannelType.GuildText))
                    .addBooleanOption(opt => opt.setName('check_on_message').setDescription('Also check on message send (default: off, impacts performance)'))
                    .addBooleanOption(opt => opt.setName('auto_aggregate').setDescription('Opt in to auto-aggregation (default: yes)')))
                .addSubcommand(sub => sub.setName('status').setDescription('View global ban protection status'))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();

        try {
            switch (group) {
                case 'spam':
                    return await handleSpam(interaction);
                case 'antinuke':
                    return await handleAntiNuke(interaction);
                case 'raid':
                    return await handleRaid(interaction);
                case 'selfbot':
                    return await handleSelfbot(interaction);
                case 'globalban':
                    return await handleGlobalBan(interaction);
            }
        } catch (error) {
            logger.error('[Protection Command] Error:', { error: error.message, group, stack: error.stack });

            const reply = { content: `Error: ${error.message}`, ephemeral: true };
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(reply);
            } else {
                await interaction.reply(reply);
            }
        }
    }
};
