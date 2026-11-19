import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { execute as handleSpam } from './protection/spam.js';
import { execute as handleAntiNuke } from './protection/antinuke.js';
import { execute as handleRaid } from './protection/raid.js';
import { execute as handleSelfbot } from './protection/selfbot.js';
import { execute as handleGlobalBan } from './protection/globalban.js';
import { execute as handleJoinGate } from './protection/joingate.js';
import { execute as handleCore } from './protection/core.js';
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
                        .addChoices({ name: 'Mute (Recommended)', value: 'mute' }, { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }, { name: 'Delete the message and warn', value: 'delete+warn' }, { name: 'Alert only', value: 'alert' }))
                    .addChannelOption(opt => opt.setName('alert_channel').setDescription('Channel to send spam alerts').addChannelTypes(ChannelType.GuildText)))
                .addSubcommand(sub => sub.setName('status').setDescription('View current adaptive spam settings'))
                .addSubcommand(sub => sub.setName('user').setDescription('View a user\'s spam profile')
                    .addUserOption(opt => opt.setName('user').setDescription('User to check').setRequired(true)))
                .addSubcommand(sub => sub.setName('patterns').setDescription('View pattern effectiveness rankings'))
                .addSubcommand(sub => sub.setName('reset').setDescription('Reset a user\'s spam profile')
                    .addUserOption(opt => opt.setName('user').setDescription('User to reset').setRequired(true)))
                .addSubcommand(sub => sub.setName('pattern-add').setDescription('Add a custom automod pattern (text, exact message, domain or regex)')
                    .addStringOption(opt => opt.setName('type').setDescription('How to match').setRequired(true)
                        .addChoices(
                            { name: 'Contains text', value: 'contains' },
                            { name: 'Exact message', value: 'exact' },
                            { name: 'Link to a domain (and its subdomains)', value: 'domain' },
                            { name: 'Regular expression (case-insensitive)', value: 'regex' }))
                    .addStringOption(opt => opt.setName('pattern').setDescription('Text, domain or regex to match').setRequired(true).setMaxLength(300))
                    .addStringOption(opt => opt.setName('action').setDescription('What to do on a match (default: delete)')
                        .addChoices(
                            { name: 'Delete the message', value: 'delete' },
                            { name: 'Delete + warn', value: 'warn' },
                            { name: 'Delete + mute 10 minutes', value: 'mute' },
                            { name: 'Delete + kick', value: 'kick' },
                            { name: 'Delete + ban', value: 'ban' }))
                    .addStringOption(opt => opt.setName('reason').setDescription('Reason shown to the member and in the log').setMaxLength(200)))
                .addSubcommand(sub => sub.setName('pattern-remove').setDescription('Remove a custom pattern')
                    .addIntegerOption(opt => opt.setName('id').setDescription('Pattern # from pattern-list').setRequired(true).setMinValue(1)))
                .addSubcommand(sub => sub.setName('pattern-list').setDescription('List this server\'s custom patterns'))
                .addSubcommand(sub => sub.setName('pattern-toggle').setDescription('Turn a custom pattern on or off')
                    .addIntegerOption(opt => opt.setName('id').setDescription('Pattern # from pattern-list').setRequired(true).setMinValue(1))
                    .addBooleanOption(opt => opt.setName('enabled').setDescription('On or off').setRequired(true)))
                .addSubcommand(sub => sub.setName('pattern-false-positive').setDescription('Report that a pattern caught a message it should not have')
                    .addIntegerOption(opt => opt.setName('id').setDescription('Pattern # (shown in the automod log)').setRequired(true).setMinValue(1))))

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
                        .addChoices({ name: 'Time out raiders (Recommended)', value: 'mute' }, { name: 'Kick raiders', value: 'kick' }, { name: 'Ban raiders', value: 'ban' }, { name: 'Alert only (default)', value: 'alert' }))
                    .addChannelOption(opt => opt.setName('alert_channel').setDescription('Channel to send raid alerts').addChannelTypes(ChannelType.GuildText))
                    .addIntegerOption(opt => opt.setName('mute_duration').setDescription('Mute duration in minutes (default: 60)').setMinValue(1).setMaxValue(10080))
                    .addBooleanOption(opt => opt.setName('purge_messages').setDescription('Purge messages from detected raiders (default: off)')))
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
                    .addBooleanOption(opt => opt.setName('purge_messages').setDescription('Purge messages from detected self-bots (default: off)')))
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
                .addSubcommand(sub => sub.setName('status').setDescription('View global ban protection status')))

        // ── Account-age join gate ──
        .addSubcommandGroup(group =>
            group.setName('joingate')
                .setDescription('Kick brand new accounts on join; admit young ones by application')
                .addSubcommand(sub => sub.setName('enable').setDescription('Turn the account-age gate on'))
                .addSubcommand(sub => sub.setName('disable').setDescription('Turn the account-age gate off'))
                .addSubcommand(sub => sub.setName('config').setDescription('Set the thresholds and channels')
                    .addIntegerOption(o => o.setName('kick-under-hours')
                        .setDescription('Remove accounts younger than this, no application offered')
                        .setMinValue(1).setMaxValue(720))
                    .addIntegerOption(o => o.setName('apply-under-days')
                        .setDescription('Below this age they may apply to join. 0 disables applications')
                        .setMinValue(0).setMaxValue(365))
                    .addChannelOption(o => o.setName('review-channel')
                        .setDescription('Where applications appear for staff to approve or decline')
                        .addChannelTypes(ChannelType.GuildText))
                    .addChannelOption(o => o.setName('invite-channel')
                        .setDescription('Channel the approval invite points at')
                        .addChannelTypes(ChannelType.GuildText))
                    .addChannelOption(o => o.setName('log-channel')
                        .setDescription('Where removals are logged. Defaults to the review channel')
                        .addChannelTypes(ChannelType.GuildText))
                    .addStringOption(o => o.setName('action').setDescription('What to do to a blocked account')
                        .addChoices(
                            { name: 'kick — they may return later', value: 'kick' },
                            { name: 'ban — permanent', value: 'ban' },
                            { name: 'nothing — log only, for trialling', value: 'none' }))
                    .addBooleanOption(o => o.setName('block-default-avatar')
                        .setDescription('Refuse the application route to new accounts with no picture')))
                .addSubcommand(sub => sub.setName('status').setDescription('Thresholds, channels and recent activity'))
                .addSubcommand(sub => sub.setName('applications').setDescription('List applications')
                    .addStringOption(o => o.setName('status').setDescription('Which ones to list')
                        .addChoices(
                            { name: 'pending', value: 'pending' },
                            { name: 'approved', value: 'approved' },
                            { name: 'declined', value: 'denied' })))
                .addSubcommand(sub => sub.setName('rejoin').setDescription('Remove members who keep leaving and rejoining')
                    .addBooleanOption(o => o.setName('enabled').setDescription('Turn the rejoin limit on or off'))
                    .addIntegerOption(o => o.setName('max-joins')
                        .setDescription('How many times someone may join; the join after that is acted on')
                        .setMinValue(1).setMaxValue(100))
                    .addIntegerOption(o => o.setName('window-days')
                        .setDescription('Only count joins from the last N days. 0 counts every join ever')
                        .setMinValue(0).setMaxValue(3650))
                    .addStringOption(o => o.setName('action').setDescription('What to do to someone over the limit')
                        .addChoices(
                            { name: 'ban — they cannot come back', value: 'ban' },
                            { name: 'kick — removed every time they rejoin', value: 'kick' },
                            { name: 'remove with an application', value: 'apply' },
                            { name: 'nothing — log only, for trialling', value: 'none' })))
                .addSubcommand(sub => sub.setName('history').setDescription('Every time a member has joined this server')
                    .addUserOption(o => o.setName('user').setDescription('Member (or user ID)').setRequired(true)))
                .addSubcommand(sub => sub.setName('reset').setDescription("Restart a member's rejoin count from now")
                    .addUserOption(o => o.setName('user').setDescription('Member (or user ID)').setRequired(true)))
                .addSubcommand(sub => sub.setName('spammer').setDescription('Act on accounts Discord itself has flagged as spammers, when they join')
                    .addBooleanOption(o => o.setName('enabled').setDescription('Turn the spammer check on or off'))
                    .addStringOption(o => o.setName('action').setDescription('What to do to a flagged account')
                        .addChoices(
                            { name: 'kick — removed (default)', value: 'kick' },
                            { name: 'ban — permanent', value: 'ban' },
                            { name: 'flag — give them a role for staff to review', value: 'flag' },
                            { name: 'nothing — log only, for trialling', value: 'none' }))
                    .addRoleOption(o => o.setName('flag-role')
                        .setDescription('Role for the flag action. Without one, a "Flagged Spammer" role is made'))
                    .addBooleanOption(o => o.setName('silent')
                        .setDescription('Stop posting a log for each one. The action still happens')))
                .addSubcommand(sub => sub.setName('spammer-scan')
                    .setDescription('Find members already in the server that Discord has flagged as spammers'))
                .addSubcommand(sub => sub.setName('spammer-allow')
                    .setDescription('Let a flagged member stay (or stop letting them). No user lists the allowlist')
                    .addUserOption(o => o.setName('user').setDescription('Member (or user ID)'))
                    .addBooleanOption(o => o.setName('remove').setDescription('Take them off the allowlist instead'))))

        // ── Shared controls: allowlist, bot managers, pause (core/protection-exempt.js) ──
        .addSubcommandGroup(group =>
            group.setName('allowlist')
                .setDescription('Users and roles no automatic protection acts on')
                .addSubcommand(sub => sub.setName('add').setDescription('Exempt a user or role from every automatic protection')
                    .addUserOption(o => o.setName('user').setDescription('User'))
                    .addRoleOption(o => o.setName('role').setDescription('Role'))
                    .addStringOption(o => o.setName('note').setDescription('Why').setMaxLength(200)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Stop exempting a user or role')
                    .addUserOption(o => o.setName('user').setDescription('User'))
                    .addRoleOption(o => o.setName('role').setDescription('Role')))
                .addSubcommand(sub => sub.setName('list').setDescription('Who is exempt')))
        .addSubcommandGroup(group =>
            group.setName('managers')
                .setDescription('Roles that may configure the bot without Manage Server')
                .addSubcommand(sub => sub.setName('add').setDescription('Make a role a bot manager (owner/admin only)')
                    .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Remove a bot-manager role (owner/admin only)')
                    .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
                .addSubcommand(sub => sub.setName('list').setDescription('List bot-manager roles')))
        .addSubcommand(sub => sub.setName('pause').setDescription('Stop all automatic actions; detection and logs carry on')
            .addStringOption(o => o.setName('duration').setDescription('e.g. 30m, 2h, 1d. Empty: until /protection resume'))
            .addStringOption(o => o.setName('reason').setDescription('Shown in status and the log').setMaxLength(200)))
        .addSubcommand(sub => sub.setName('resume').setDescription('Turn automatic actions back on'))
        .addSubcommand(sub => sub.setName('status').setDescription('Pause state, allowlist, managers and what is on')),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup(false);

        try {
            switch (group) {
                case 'allowlist':
                case 'managers':
                case null:
                    return await handleCore(interaction);
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
                case 'joingate':
                    return await handleJoinGate(interaction);
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
