import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getSelfPromoConfig, invalidateSelfPromoConfig } from '../../core/self-promo-handler.js';
import { invalidateConfig as invalidateCommunityConfig } from '../../core/community-support-manager.js';
import { invalidateAutoTrackConfig, scanGuildForActiveStreamers } from '../../events/presenceUpdate.js';
import { STYLES, STYLE_LABELS, DEFAULT_STYLE, setStyle, clearStyle, listStyles, resolveStyle } from '../../core/stream-render-style.js';
import {
    getConfig as getTempAccessConfig, invalidateConfig as invalidateTempAccessConfig,
    trackInvite, untrackInvite, getTrackedInvites, pardon as pardonTempAccess,
} from '../../core/temp-access-manager.js';
import {
    handleVerification as handleVerificationCommand, handleAutoPrune as handleAutoPruneCommand,
} from './systems-verify-handler.js';

// 'inherit' is not a stored style — it deletes the override so the next scope up applies.
const LIVE_STYLE_CHOICES = [
    // Every style the dashboard offers (core/stream-render-style.js STYLES), so the two cannot drift (H-670).
    ...STYLES.map(value => ({ name: `${STYLE_LABELS[value]}${value === DEFAULT_STYLE ? ' — default' : ''}`.slice(0, 100), value })),
    { name: 'Inherit (remove this override)', value: 'inherit' },
];

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('systems')
        .setDescription('Configure guild-specific systems')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

        // ==================== SELFPROMO GROUP ====================
        .addSubcommandGroup(group =>
            group
                .setName('selfpromo')
                .setDescription('Self-promo channel auto-tracking')
                .addSubcommand(sub =>
                    sub
                        .setName('setup')
                        .setDescription('Configure the self-promo channel')
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('The self-promo channel to watch').setRequired(true)
                                .addChannelTypes(ChannelType.GuildText)
                        )
                        .addStringOption(opt =>
                            opt.setName('platforms').setDescription('Allowed platforms (comma-separated: twitch,kick,youtube)')
                        )
                        .addBooleanOption(opt =>
                            opt.setName('auto_subscribe').setDescription('Auto-create streamer+subscription (default: true)')
                        )
                        .addBooleanOption(opt =>
                            opt.setName('delete_invalid').setDescription('Delete non-link messages (default: true)')
                        )
                        .addBooleanOption(opt =>
                            opt.setName('dm_on_track').setDescription('DM user when added to tracking (default: true)')
                        )
                        .addBooleanOption(opt =>
                            opt.setName('dm_on_already_tracked').setDescription('DM if already tracked (default: true)')
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('status').setDescription('Show current self-promo config')
                )
                .addSubcommand(sub =>
                    sub.setName('disable').setDescription('Disable self-promo for this guild')
                )
        )

        // ==================== COMMUNITY GROUP ====================
        .addSubcommandGroup(group =>
            group
                .setName('community')
                .setDescription('Community support tracking system')
                .addSubcommand(sub =>
                    sub
                        .setName('setup')
                        .setDescription('Configure community support tracking')
                        .addChannelOption(opt =>
                            opt.setName('raid_channel').setDescription('Channel where raid posts go').setRequired(true)
                                .addChannelTypes(ChannelType.GuildText)
                        )
                        .addChannelOption(opt =>
                            opt.setName('support_channel').setDescription('Channel where support posts go').setRequired(true)
                                .addChannelTypes(ChannelType.GuildText)
                        )
                        .addChannelOption(opt =>
                            opt.setName('shoutout_channel').setDescription('Channel for monthly shoutouts').setRequired(true)
                                .addChannelTypes(ChannelType.GuildText)
                        )
                        .addChannelOption(opt =>
                            opt.setName('affiliate_link_channel').setDescription('Channel for affiliate link posts')
                                .addChannelTypes(ChannelType.GuildText)
                        )
                        .addChannelOption(opt =>
                            opt.setName('non_affiliate_link_channel').setDescription('Channel for non-affiliate link posts')
                                .addChannelTypes(ChannelType.GuildText)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('status').setDescription('Show current community support config')
                )
                .addSubcommand(sub =>
                    sub
                        .setName('points')
                        .setDescription('Adjust point values')
                        .addIntegerOption(opt =>
                            opt.setName('raid_affiliate').setDescription('Points for raiding an affiliate').setMinValue(1).setMaxValue(100)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('raid_non_affiliate').setDescription('Points for raiding a non-affiliate').setMinValue(1).setMaxValue(100)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('support').setDescription('Points for support channel activity').setMinValue(1).setMaxValue(100)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('disable').setDescription('Disable community support for this guild')
                )
        )

        // ==================== STREAM-ENDED GROUP ====================
        .addSubcommandGroup(group =>
            group
                .setName('stream-ended')
                .setDescription('Control edit-on-end behavior for stream announcements')
                .addSubcommand(sub =>
                    sub
                        .setName('set')
                        .setDescription('Toggle edit-on-end for a subscription')
                        .addStringOption(opt =>
                            opt.setName('streamer').setDescription('Streamer username').setRequired(true)
                        )
                        .addBooleanOption(opt =>
                            opt.setName('edit_on_end').setDescription('Edit to "stream ended" instead of deleting').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('platform').setDescription('Platform (if multiple)')
                                .addChoices(
                                    { name: 'Twitch', value: 'twitch' },
                                    { name: 'Kick', value: 'kick' },
                                    { name: 'YouTube', value: 'youtube' }
                                )
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('status').setDescription('Show which subscriptions have edit-on-end enabled')
                )
        )

        // ==================== AUTOTRACK GROUP ====================
        .addSubcommandGroup(group =>
            group
                .setName('autotrack')
                .setDescription('Auto-track streamers by presence detection (fallback system)')
                .addSubcommand(sub =>
                    sub
                        .setName('setup')
                        .setDescription('Add a role→channel auto-track mapping')
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('Channel for auto-track announcements').setRequired(true)
                                .addChannelTypes(ChannelType.GuildText)
                        )
                        .addRoleOption(opt =>
                            opt.setName('role').setDescription('Role to watch (omit for any member)')
                        )
                )
                .addSubcommand(sub =>
                    sub
                        .setName('remove')
                        .setDescription('Remove an auto-track mapping')
                        .addRoleOption(opt =>
                            opt.setName('role').setDescription('Role mapping to remove (omit to remove "any member" mapping)')
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('status').setDescription('Show all auto-track mappings for this guild')
                )
                .addSubcommand(sub =>
                    sub.setName('disable').setDescription('Disable all auto-track mappings for this guild')
                )
        )

        // ==================== LIVE-STYLE GROUP ====================
        .addSubcommandGroup(group =>
            group
                .setName('live-style')
                .setDescription('Choose how live announcements are drawn: platform preview or custom card')
                .addSubcommand(sub =>
                    sub
                        .setName('server')
                        .setDescription('Set the default look for every live announcement in this server')
                        .addStringOption(opt =>
                            opt.setName('style').setDescription('How announcements should look').setRequired(true)
                                .addChoices(...LIVE_STYLE_CHOICES))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('channel')
                        .setDescription('Override the look for one live channel')
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('The live channel').setRequired(true)
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
                        .addStringOption(opt =>
                            opt.setName('style').setDescription('How announcements in this channel should look').setRequired(true)
                                .addChoices(...LIVE_STYLE_CHOICES))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('streamer')
                        .setDescription('Override the look for one streamer, wherever they are announced')
                        .addStringOption(opt =>
                            opt.setName('streamer').setDescription('Streamer username').setRequired(true))
                        .addStringOption(opt =>
                            opt.setName('style').setDescription('How this streamer\'s announcements should look').setRequired(true)
                                .addChoices(...LIVE_STYLE_CHOICES))
                        .addStringOption(opt =>
                            opt.setName('platform').setDescription('Platform (if this name exists on more than one)')
                                .addChoices(
                                    { name: 'Twitch', value: 'twitch' },
                                    { name: 'Kick', value: 'kick' },
                                    { name: 'YouTube', value: 'youtube' }
                                ))
                )
                .addSubcommand(sub =>
                    sub.setName('status').setDescription('Show every live-style setting in this server')
                )
        )

        // ==================== TEMP-ACCESS GROUP ====================
        .addSubcommandGroup(group =>
            group
                .setName('temp-access')
                .setDescription('Guest access that expires unless the guest shows up')
                .addSubcommand(sub =>
                    sub
                        .setName('setup')
                        .setDescription('Configure temporary guest access')
                        .addRoleOption(opt =>
                            opt.setName('temp_role').setDescription('The guest marker role this system hands out').setRequired(true))
                        .addRoleOption(opt =>
                            opt.setName('access_role').setDescription('Role that actually opens the server to them (e.g. your Verified role)'))
                        .addIntegerOption(opt =>
                            opt.setName('hours').setDescription('Hours of silence before removal (default 24)').setMinValue(1).setMaxValue(720))
                        .addChannelOption(opt =>
                            opt.setName('log_channel').setDescription('Where to post trial starts, passes and removals')
                                .addChannelTypes(ChannelType.GuildText))
                        .addBooleanOption(opt =>
                            opt.setName('dm_on_kick').setDescription('DM the guest explaining the removal (default: true)'))
                        .addBooleanOption(opt =>
                            opt.setName('keep_role_on_pass').setDescription('Keep the guest role after they pass (default: false)'))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('invite')
                        .setDescription('Create an invite link wired to the guest role')
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('Channel the link lands in (default: this one)')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement))
                        .addIntegerOption(opt =>
                            opt.setName('max_uses').setDescription('Uses before the link dies (0 = unlimited, default 0)').setMinValue(0).setMaxValue(100))
                        .addIntegerOption(opt =>
                            opt.setName('expires_hours').setDescription('Hours before the LINK expires (0 = never, default 0)').setMinValue(0).setMaxValue(168))
                )
                .addSubcommand(sub =>
                    sub.setName('status').setDescription('Show the temporary-access config and its invite links')
                )
                .addSubcommand(sub =>
                    sub.setName('list').setDescription('List guests currently on trial and when they run out')
                )
                .addSubcommand(sub =>
                    sub
                        .setName('pardon')
                        .setDescription('End a guest\'s trial and let them stay')
                        .addUserOption(opt =>
                            opt.setName('user').setDescription('The guest to keep').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('revoke-invite')
                        .setDescription('Stop a link from granting guest access')
                        .addStringOption(opt =>
                            opt.setName('code').setDescription('Invite code (not the full URL)').setRequired(true))
                        .addBooleanOption(opt =>
                            opt.setName('delete').setDescription('Also delete the invite from Discord (default: true)'))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('toggle')
                        .setDescription('Turn temporary access on or off without losing the config')
                        .addBooleanOption(opt =>
                            opt.setName('enabled').setDescription('Whether new trials start and expired ones are acted on').setRequired(true))
                )
        )

        // ==================== VERIFICATION GROUP ====================
        // core/verification.js; the same and more on the dashboard's Verification page.
        .addSubcommandGroup(group =>
            group
                .setName('verification')
                .setDescription('Verification gate: CAPTCHA or I agree, setup wizard, stats')
                .addSubcommand(sub =>
                    sub.setName('setup').setDescription('Create what is missing, lock channels, post the panel (preview first)')
                        .addStringOption(opt => opt.setName('mode').setDescription('How members verify (default CAPTCHA)')
                            .addChoices({ name: 'CAPTCHA (image code)', value: 'captcha' }, { name: 'I agree button', value: 'button' }))
                        .addStringOption(opt => opt.setName('lock').setDescription('Hide public channels until verified (default: Unverified role)')
                            .addChoices({ name: 'Unverified role cannot see them', value: 'unverified' },
                                { name: 'Only the Verified role can see them', value: 'verified' }, { name: 'Do not lock', value: 'none' }))
                        .addChannelOption(opt => opt.setName('channel').setDescription('Verification channel (default: create #verify)')
                            .addChannelTypes(ChannelType.GuildText))
                        .addRoleOption(opt => opt.setName('verified_role').setDescription('Role given on verifying (default: create it)'))
                        .addRoleOption(opt => opt.setName('unverified_role').setDescription('Role held until verified (default: create it)'))
                        .addBooleanOption(opt => opt.setName('hide_gate').setDescription('Hide the verify channel once verified (default true)')))
                .addSubcommand(sub =>
                    sub.setName('settings').setDescription('Mode, tries, time limit and what happens on failure')
                        .addBooleanOption(opt => opt.setName('enabled').setDescription('Verification on or off'))
                        .addStringOption(opt => opt.setName('mode').setDescription('How members verify')
                            .addChoices({ name: 'CAPTCHA (image code)', value: 'captcha' }, { name: 'I agree button', value: 'button' }))
                        .addIntegerOption(opt => opt.setName('attempts').setDescription('Wrong codes allowed (default 3)').setMinValue(1).setMaxValue(10))
                        .addIntegerOption(opt => opt.setName('minutes').setDescription('Minutes from joining to finish (0 = no limit, max 20160 = 14 days, default 5)').setMinValue(0).setMaxValue(20160))
                        .addStringOption(opt => opt.setName('fail_action').setDescription('On failure')
                            .addChoices({ name: 'Log only', value: 'none' }, { name: 'Timeout', value: 'timeout' }, { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }))
                        .addIntegerOption(opt => opt.setName('timeout_minutes').setDescription('Timeout length').setMinValue(1).setMaxValue(40320))
                        .addBooleanOption(opt => opt.setName('dm').setDescription('DM the member why'))
                        .addIntegerOption(opt => opt.setName('unverified_days').setDescription('Kick if still Unverified after N days (0 = never)').setMinValue(0).setMaxValue(365)))
                .addSubcommand(sub =>
                    sub.setName('panel').setDescription('Post the verification panel again')
                        .addChannelOption(opt => opt.setName('channel').setDescription('Where (default: the verification channel)').addChannelTypes(ChannelType.GuildText)))
                .addSubcommand(sub => sub.setName('status').setDescription('Settings, 30-day stats and verification rate'))
                .addSubcommand(sub =>
                    sub.setName('undo').setDescription('Revert the permission changes the setup made')
                        .addBooleanOption(opt => opt.setName('delete_created').setDescription('Also delete the channel and roles it created')))
        )

        // ==================== AUTO-PRUNE GROUP ====================
        // core/auto-prune.js; the queue and settings are also on the dashboard's Verification page.
        .addSubcommandGroup(group =>
            group
                .setName('auto-prune')
                .setDescription('Kick members with no real role in time, or inactive members')
                .addSubcommand(sub =>
                    sub.setName('set').setDescription('Switch on/off, time limit, action')
                        .addBooleanOption(opt => opt.setName('enabled').setDescription('On or off (off clears the queue)'))
                        .addIntegerOption(opt => opt.setName('minutes').setDescription('Minutes after joining (10-20160, default 240)').setMinValue(10).setMaxValue(20160))
                        .addIntegerOption(opt => opt.setName('days').setDescription('Or whole days after joining (1-14; replaces minutes)').setMinValue(1).setMaxValue(14))
                        .addStringOption(opt => opt.setName('action').setDescription('What happens at the limit')
                            .addChoices({ name: 'Kick', value: 'kick' }, { name: 'Log only', value: 'log' }))
                        .addBooleanOption(opt => opt.setName('dm').setDescription('DM before kicking (default true)')))
                .addSubcommand(sub =>
                    sub.setName('bypass').setDescription('Roles that do not count as a real role')
                        .addRoleOption(opt => opt.setName('role').setDescription('The role').setRequired(true))
                        .addBooleanOption(opt => opt.setName('remove').setDescription('Remove it from the list instead')))
                .addSubcommand(sub => sub.setName('status').setDescription('Settings and the current queue'))
                .addSubcommand(sub =>
                    sub.setName('unqueue').setDescription('Take a member off the queue')
                        .addUserOption(opt => opt.setName('user').setDescription('The member').setRequired(true)))
                // Inactivity prune (core/inactivity-prune.js): members who got in but never / no longer show up.
                .addSubcommand(sub =>
                    sub.setName('inactive').setDescription('Inactivity rules: never active / gone quiet, warning, caps')
                        .addBooleanOption(opt => opt.setName('never').setDescription('Rule: no message or voice join within N days of joining'))
                        .addIntegerOption(opt => opt.setName('never_days').setDescription('Days to first activity (7-180, default 30)').setMinValue(7).setMaxValue(180))
                        .addStringOption(opt => opt.setName('never_action').setDescription('Never-active members are')
                            .addChoices({ name: 'Logged only', value: 'log' }, { name: 'Kicked', value: 'kick' }))
                        .addBooleanOption(opt => opt.setName('quiet').setDescription('Rule: no message or voice join for N days (rolling)'))
                        .addIntegerOption(opt => opt.setName('quiet_days').setDescription('Days since last activity (30-365, default 90)').setMinValue(30).setMaxValue(365))
                        .addStringOption(opt => opt.setName('quiet_action').setDescription('Members gone quiet are')
                            .addChoices({ name: 'Logged only', value: 'log' }, { name: 'Kicked', value: 'kick' }))
                        .addIntegerOption(opt => opt.setName('warn_days').setDescription('DM a warning N days before a kick (0 = none, default 3)').setMinValue(0).setMaxValue(30))
                        .addIntegerOption(opt => opt.setName('min_days').setDescription('Never judge members in the server under N days (default 7)').setMinValue(0).setMaxValue(365))
                        .addIntegerOption(opt => opt.setName('per_sweep').setDescription('Most kicks per sweep (default 25)').setMinValue(1).setMaxValue(100))
                        .addIntegerOption(opt => opt.setName('per_day').setDescription('Most kicks per day (default 100)').setMinValue(1).setMaxValue(1000))
                        .addBooleanOption(opt => opt.setName('boosters_exempt').setDescription('Never judge server boosters (default true)'))
                        .addBooleanOption(opt => opt.setName('staff_exempt').setDescription('Never judge members with moderation permissions (default true)')))
                .addSubcommand(sub =>
                    sub.setName('inactive-exempt').setDescription('Roles the inactivity rules never judge')
                        .addRoleOption(opt => opt.setName('role').setDescription('The role').setRequired(true))
                        .addBooleanOption(opt => opt.setName('remove').setDescription('Remove it from the list instead')))
                .addSubcommand(sub => sub.setName('inactive-preview').setDescription('Who the inactivity rules would warn or remove right now'))
        ),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        try {
            switch (group) {
                case 'selfpromo':
                    return await this.handleSelfPromo(interaction, subcommand);
                case 'community':
                    return await this.handleCommunity(interaction, subcommand);
                case 'stream-ended':
                    return await this.handleStreamEnded(interaction, subcommand);
                case 'autotrack':
                    return await this.handleAutoTrack(interaction, subcommand);
                case 'live-style':
                    return await this.handleLiveStyle(interaction, subcommand);
                case 'temp-access':
                    return await this.handleTempAccess(interaction, subcommand);
                case 'verification':
                    return await handleVerificationCommand(interaction, subcommand);
                case 'auto-prune':
                    return await handleAutoPruneCommand(interaction, subcommand);
            }
        } catch (error) {
            logger.error('[Systems Command Error]', { error: error.message, group, subcommand });
            const method = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
            await interaction[method]({
                content: 'An error occurred while processing this command.',
                ephemeral: true
            }).catch(() => {});
        }
    },

    // ==================== LIVE-STYLE HANDLERS ====================

    async handleLiveStyle(interaction, subcommand) {
        await interaction.deferReply({ ephemeral: true });
        const guildId = interaction.guildId;

        if (subcommand === 'status') {
            const rows = await listStyles(guildId);
            const embed = new EmbedBuilder()
                .setColor('#a78bfa')
                .setTitle('Live announcement style')
                .setDescription(`Unset scopes inherit downward: **streamer → channel → server → ${STYLE_LABELS[DEFAULT_STYLE]}**.`);

            const guildRow = rows.find(r => r.scope_type === 'guild');
            embed.addFields({
                name: 'Server default',
                value: guildRow ? STYLE_LABELS[guildRow.style] : `${STYLE_LABELS[DEFAULT_STYLE]} _(not set — using the built-in default)_`,
            });

            const channelRows = rows.filter(r => r.scope_type === 'channel');
            if (channelRows.length) {
                embed.addFields({
                    name: `Channel overrides (${channelRows.length})`,
                    value: channelRows.map(r => `<#${r.scope_id}> — ${STYLE_LABELS[r.style]}`).join('\n').slice(0, 1024),
                });
            }

            const streamerRows = rows.filter(r => r.scope_type === 'streamer');
            if (streamerRows.length) {
                const names = [];
                for (const row of streamerRows) {
                    const [[s]] = await pool.execute(
                        'SELECT username, platform FROM streamers WHERE streamer_id = ? LIMIT 1', [row.scope_id]);
                    names.push(`${s ? `**${s.username}** (${s.platform})` : `streamer ${row.scope_id}`} — ${STYLE_LABELS[row.style]}`);
                }
                embed.addFields({ name: `Streamer overrides (${streamerRows.length})`, value: names.join('\n').slice(0, 1024) });
            }

            if (!rows.length) embed.setFooter({ text: 'Nothing overridden — every announcement uses the platform preview.' });
            return interaction.editReply({ embeds: [embed] });
        }

        const style = interaction.options.getString('style');
        const clearing = style === 'inherit';

        if (subcommand === 'server') {
            if (clearing) {
                await clearStyle({ guildId, scopeType: 'guild' });
                return interaction.editReply(`Server default cleared — back to **${STYLE_LABELS[DEFAULT_STYLE]}**.`);
            }
            await setStyle({ guildId, scopeType: 'guild', style, updatedBy: interaction.user.id });
            return interaction.editReply(`Server default is now **${STYLE_LABELS[style]}**. Channel and streamer overrides still win.`);
        }

        if (subcommand === 'channel') {
            const channel = interaction.options.getChannel('channel');
            if (clearing) {
                await clearStyle({ guildId, scopeType: 'channel', scopeId: channel.id });
                const { style: now, source } = await resolveStyle({ guildId, channelId: channel.id });
                return interaction.editReply(`Override removed from ${channel} — it now inherits **${STYLE_LABELS[now]}** (from the ${source === 'default' ? 'built-in default' : source}).`);
            }
            await setStyle({ guildId, scopeType: 'channel', scopeId: channel.id, style, updatedBy: interaction.user.id });
            return interaction.editReply(`${channel} will use **${STYLE_LABELS[style]}**. Per-streamer overrides still win inside it.`);
        }

        if (subcommand === 'streamer') {
            const username = interaction.options.getString('streamer').trim();
            const platform = interaction.options.getString('platform');
            const params = platform ? [username, platform] : [username];
            const [matches] = await pool.execute(
                `SELECT streamer_id, username, platform FROM streamers WHERE username = ?${platform ? ' AND platform = ?' : ''}`,
                params
            );

            if (!matches.length) {
                return interaction.editReply(`No tracked streamer called **${username}**${platform ? ` on ${platform}` : ''}. Check the spelling, or add them first.`);
            }
            if (matches.length > 1) {
                return interaction.editReply(`**${username}** exists on ${matches.map(m => m.platform).join(', ')}. Re-run with the \`platform\` option to say which one.`);
            }

            const target = matches[0];
            if (clearing) {
                await clearStyle({ guildId, scopeType: 'streamer', scopeId: target.streamer_id });
                const { style: now, source } = await resolveStyle({ guildId, streamerId: target.streamer_id });
                return interaction.editReply(`Override removed from **${target.username}** — they now inherit **${STYLE_LABELS[now]}** (from the ${source === 'default' ? 'built-in default' : source}).`);
            }
            await setStyle({ guildId, scopeType: 'streamer', scopeId: target.streamer_id, style, updatedBy: interaction.user.id });
            return interaction.editReply(`**${target.username}** (${target.platform}) will use **${STYLE_LABELS[style]}** in every channel of this server.`);
        }
    },

    // ==================== SELFPROMO HANDLERS ====================

    async handleSelfPromo(interaction, subcommand) {
        switch (subcommand) {
            case 'setup': return await this.selfPromoSetup(interaction);
            case 'status': return await this.selfPromoStatus(interaction);
            case 'disable': return await this.selfPromoDisable(interaction);
        }
    },

    async selfPromoSetup(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guildId = interaction.guild.id;
        const channel = interaction.options.getChannel('channel');
        const platformsRaw = interaction.options.getString('platforms') || 'twitch,kick,youtube';
        const platforms = platformsRaw.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
        const autoSubscribe = interaction.options.getBoolean('auto_subscribe') ?? true;
        const deleteInvalid = interaction.options.getBoolean('delete_invalid') ?? true;
        const dmOnTrack = interaction.options.getBoolean('dm_on_track') ?? true;
        const dmOnAlreadyTracked = interaction.options.getBoolean('dm_on_already_tracked') ?? true;

        await pool.execute(`
            INSERT INTO self_promo_config (guild_id, enabled, channel_id, allowed_platforms, auto_subscribe, delete_invalid, dm_on_track, dm_on_already_tracked)
            VALUES (?, 1, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = 1, channel_id = VALUES(channel_id), allowed_platforms = VALUES(allowed_platforms),
                auto_subscribe = VALUES(auto_subscribe), delete_invalid = VALUES(delete_invalid),
                dm_on_track = VALUES(dm_on_track), dm_on_already_tracked = VALUES(dm_on_already_tracked)
        `, [guildId, channel.id, JSON.stringify(platforms), autoSubscribe ? 1 : 0, deleteInvalid ? 1 : 0, dmOnTrack ? 1 : 0, dmOnAlreadyTracked ? 1 : 0]);

        invalidateSelfPromoConfig(guildId);

        const embed = new EmbedBuilder()
            .setColor('#00FF88')
            .setTitle('Self-Promo Configured')
            .addFields(
                { name: 'Channel', value: `<#${channel.id}>`, inline: true },
                { name: 'Platforms', value: platforms.join(', '), inline: true },
                { name: 'Auto-Subscribe', value: autoSubscribe ? 'Yes' : 'No', inline: true },
                { name: 'Delete Invalid', value: deleteInvalid ? 'Yes' : 'No', inline: true },
                { name: 'DM on Track', value: dmOnTrack ? 'Yes' : 'No', inline: true },
                { name: 'DM if Already Tracked', value: dmOnAlreadyTracked ? 'Yes' : 'No', inline: true }
            );

        await interaction.editReply({ embeds: [embed] });
    },

    async selfPromoStatus(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const config = await getSelfPromoConfig(interaction.guild.id);

        if (!config) {
            return interaction.editReply({ content: 'Self-promo is not configured for this server.' });
        }

        const platforms = Array.isArray(config.allowed_platforms) ? config.allowed_platforms.join(', ') : 'none';
        const embed = new EmbedBuilder()
            .setColor('#00FF88')
            .setTitle('Self-Promo Configuration')
            .addFields(
                { name: 'Enabled', value: config.enabled ? 'Yes' : 'No', inline: true },
                { name: 'Channel', value: config.channel_id ? `<#${config.channel_id}>` : 'Not set', inline: true },
                { name: 'Platforms', value: platforms, inline: true },
                { name: 'Auto-Subscribe', value: config.auto_subscribe ? 'Yes' : 'No', inline: true },
                { name: 'Delete Invalid', value: config.delete_invalid ? 'Yes' : 'No', inline: true },
                { name: 'DM on Track', value: config.dm_on_track ? 'Yes' : 'No', inline: true },
                { name: 'DM if Already Tracked', value: config.dm_on_already_tracked ? 'Yes' : 'No', inline: true }
            );

        await interaction.editReply({ embeds: [embed] });
    },

    async selfPromoDisable(interaction) {
        await interaction.deferReply({ ephemeral: true });
        await pool.execute('UPDATE self_promo_config SET enabled = 0 WHERE guild_id = ?', [interaction.guild.id]);
        invalidateSelfPromoConfig(interaction.guild.id);
        await interaction.editReply({ content: 'Self-promo has been disabled for this server.' });
    },

    // ==================== COMMUNITY HANDLERS ====================

    async handleCommunity(interaction, subcommand) {
        switch (subcommand) {
            case 'setup': return await this.communitySetup(interaction);
            case 'status': return await this.communityStatus(interaction);
            case 'points': return await this.communityPoints(interaction);
            case 'disable': return await this.communityDisable(interaction);
        }
    },

    async communitySetup(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guildId = interaction.guild.id;
        const raidChannel = interaction.options.getChannel('raid_channel');
        const supportChannel = interaction.options.getChannel('support_channel');
        const shoutoutChannel = interaction.options.getChannel('shoutout_channel');
        const affiliateLinkChannel = interaction.options.getChannel('affiliate_link_channel');
        const nonAffiliateLinkChannel = interaction.options.getChannel('non_affiliate_link_channel');

        await pool.execute(`
            INSERT INTO community_support_config (guild_id, raid_channel_id, support_channel_id, shoutout_channel_id, affiliate_link_channel_id, non_affiliate_link_channel_id, enabled)
            VALUES (?, ?, ?, ?, ?, ?, 1)
            ON DUPLICATE KEY UPDATE
                raid_channel_id = VALUES(raid_channel_id), support_channel_id = VALUES(support_channel_id),
                shoutout_channel_id = VALUES(shoutout_channel_id), affiliate_link_channel_id = VALUES(affiliate_link_channel_id),
                non_affiliate_link_channel_id = VALUES(non_affiliate_link_channel_id), enabled = 1
        `, [guildId, raidChannel.id, supportChannel.id, shoutoutChannel.id,
            affiliateLinkChannel?.id || null, nonAffiliateLinkChannel?.id || null]);

        invalidateCommunityConfig(guildId);

        const embed = new EmbedBuilder()
            .setColor('#8B5CF6')
            .setTitle('Community Support Configured')
            .addFields(
                { name: 'Raid Channel', value: `<#${raidChannel.id}>`, inline: true },
                { name: 'Support Channel', value: `<#${supportChannel.id}>`, inline: true },
                { name: 'Shoutout Channel', value: `<#${shoutoutChannel.id}>`, inline: true }
            );

        if (affiliateLinkChannel) {
            embed.addFields({ name: 'Affiliate Links', value: `<#${affiliateLinkChannel.id}>`, inline: true });
        }
        if (nonAffiliateLinkChannel) {
            embed.addFields({ name: 'Non-Affiliate Links', value: `<#${nonAffiliateLinkChannel.id}>`, inline: true });
        }

        await interaction.editReply({ embeds: [embed] });
    },

    async communityStatus(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const [rows] = await pool.execute('SELECT * FROM community_support_config WHERE guild_id = ?', [interaction.guild.id]);

        if (rows.length === 0) {
            return interaction.editReply({ content: 'Community support is not configured for this server.' });
        }

        const config = rows[0];
        const embed = new EmbedBuilder()
            .setColor('#8B5CF6')
            .setTitle('Community Support Configuration')
            .addFields(
                { name: 'Enabled', value: config.enabled ? 'Yes' : 'No', inline: true },
                { name: 'Raid Channel', value: config.raid_channel_id ? `<#${config.raid_channel_id}>` : 'Not set', inline: true },
                { name: 'Support Channel', value: config.support_channel_id ? `<#${config.support_channel_id}>` : 'Not set', inline: true },
                { name: 'Shoutout Channel', value: config.shoutout_channel_id ? `<#${config.shoutout_channel_id}>` : 'Not set', inline: true },
                { name: 'Raid Affiliate Points', value: String(config.raid_affiliate_points), inline: true },
                { name: 'Raid Non-Affiliate Points', value: String(config.raid_non_affiliate_points), inline: true },
                { name: 'Support Points', value: String(config.support_points), inline: true }
            );

        await interaction.editReply({ embeds: [embed] });
    },

    async communityPoints(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guildId = interaction.guild.id;
        const raidAffiliate = interaction.options.getInteger('raid_affiliate');
        const raidNonAffiliate = interaction.options.getInteger('raid_non_affiliate');
        const support = interaction.options.getInteger('support');

        if (!raidAffiliate && !raidNonAffiliate && !support) {
            return interaction.editReply({ content: 'Please specify at least one point value to change.' });
        }

        const updates = [];
        const params = [];
        if (raidAffiliate !== null) { updates.push('raid_affiliate_points = ?'); params.push(raidAffiliate); }
        if (raidNonAffiliate !== null) { updates.push('raid_non_affiliate_points = ?'); params.push(raidNonAffiliate); }
        if (support !== null) { updates.push('support_points = ?'); params.push(support); }
        params.push(guildId);

        await pool.execute(`UPDATE community_support_config SET ${updates.join(', ')} WHERE guild_id = ?`, params);
        invalidateCommunityConfig(guildId);

        const changes = [];
        if (raidAffiliate !== null) changes.push(`Raid Affiliate: **${raidAffiliate}**`);
        if (raidNonAffiliate !== null) changes.push(`Raid Non-Affiliate: **${raidNonAffiliate}**`);
        if (support !== null) changes.push(`Support: **${support}**`);

        await interaction.editReply({ content: `Point values updated:\n${changes.join('\n')}` });
    },

    async communityDisable(interaction) {
        await interaction.deferReply({ ephemeral: true });
        await pool.execute('UPDATE community_support_config SET enabled = 0 WHERE guild_id = ?', [interaction.guild.id]);
        invalidateCommunityConfig(interaction.guild.id);
        await interaction.editReply({ content: 'Community support has been disabled for this server.' });
    },

    // ==================== STREAM-ENDED HANDLERS ====================

    async handleStreamEnded(interaction, subcommand) {
        switch (subcommand) {
            case 'set': return await this.streamEndedSet(interaction);
            case 'status': return await this.streamEndedStatus(interaction);
        }
    },

    async streamEndedSet(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guildId = interaction.guild.id;
        const streamerName = interaction.options.getString('streamer').toLowerCase();
        const editOnEnd = interaction.options.getBoolean('edit_on_end');
        const platform = interaction.options.getString('platform');

        let query = `
            UPDATE subscriptions sub
            JOIN streamers s ON sub.streamer_id = s.streamer_id
            SET sub.edit_on_end = ?
            WHERE sub.guild_id = ? AND LOWER(s.username) = ?
        `;
        const params = [editOnEnd ? 1 : 0, guildId, streamerName];

        if (platform) {
            query += ' AND s.platform = ?';
            params.push(platform);
        }

        const [result] = await pool.execute(query, params);

        if (result.affectedRows === 0) {
            return interaction.editReply({ content: `No subscription found for streamer **${streamerName}**${platform ? ` on ${platform}` : ''} in this server.` });
        }

        await interaction.editReply({
            content: `Updated **${result.affectedRows}** subscription(s) for **${streamerName}**: edit-on-end is now **${editOnEnd ? 'enabled' : 'disabled'}**.`
        });
    },

    async streamEndedStatus(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guildId = interaction.guild.id;

        const [rows] = await pool.execute(`
            SELECT s.username, s.platform, sub.edit_on_end, sub.delete_on_end,
                   COALESCE(sub.announcement_channel_id, ts.announcement_channel_id, gc.announcement_channel_id) AS channel_id
            FROM subscriptions sub
            JOIN streamers s ON sub.streamer_id = s.streamer_id
            LEFT JOIN twitch_teams ts ON sub.team_subscription_id = ts.id
            LEFT JOIN guild_config gc ON sub.guild_id COLLATE utf8mb4_unicode_ci = gc.guild_id COLLATE utf8mb4_unicode_ci
            WHERE sub.guild_id = ?
            ORDER BY sub.edit_on_end DESC, s.username
        `, [guildId]);

        if (rows.length === 0) {
            return interaction.editReply({ content: 'No subscriptions found for this server.' });
        }

        const editEnabled = rows.filter(r => r.edit_on_end);
        const editDisabled = rows.filter(r => !r.edit_on_end);

        let description = '';
        if (editEnabled.length > 0) {
            description += '**Edit-on-End Enabled:**\n';
            description += editEnabled.slice(0, 15).map(r =>
                `- ${r.username} (${r.platform})${r.channel_id ? ` → <#${r.channel_id}>` : ''}`
            ).join('\n');
            if (editEnabled.length > 15) description += `\n... and ${editEnabled.length - 15} more`;
            description += '\n\n';
        }

        description += `**Standard (Delete):** ${editDisabled.length} subscription(s)`;

        const embed = new EmbedBuilder()
            .setColor('#F59E0B')
            .setTitle('Stream-Ended Behavior')
            .setDescription(description);

        await interaction.editReply({ embeds: [embed] });
    },

    // ==================== AUTOTRACK HANDLERS ====================

    async handleAutoTrack(interaction, subcommand) {
        switch (subcommand) {
            case 'setup': return await this.autoTrackSetup(interaction);
            case 'remove': return await this.autoTrackRemove(interaction);
            case 'status': return await this.autoTrackStatus(interaction);
            case 'disable': return await this.autoTrackDisable(interaction);
        }
    },

    async autoTrackSetup(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guildId = interaction.guild.id;
        const channel = interaction.options.getChannel('channel');
        const role = interaction.options.getRole('role');
        const roleId = role?.id || null;

        // Application-layer enforcement: only one NULL-role row per guild
        if (!roleId) {
            const [existing] = await pool.execute(
                'SELECT auto_id FROM guild_streamer_auto_track WHERE guild_id = ? AND role_id IS NULL',
                [guildId]
            );
            if (existing.length > 0) {
                // Update existing "any member" mapping
                await pool.execute(
                    'UPDATE guild_streamer_auto_track SET announcement_channel_id = ?, enabled = 1 WHERE guild_id = ? AND role_id IS NULL',
                    [channel.id, guildId]
                );
                invalidateAutoTrackConfig(guildId);
                scanGuildForActiveStreamers(interaction.client, guildId).catch(() => {});
                return interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setColor('#FB923C')
                        .setTitle('Auto-Track Updated')
                        .setDescription(`Updated **Any Member** mapping to announce in <#${channel.id}>.`)
                    ]
                });
            }
        }

        await pool.execute(`
            INSERT INTO guild_streamer_auto_track (guild_id, role_id, announcement_channel_id, enabled)
            VALUES (?, ?, ?, 1)
            ON DUPLICATE KEY UPDATE
                announcement_channel_id = VALUES(announcement_channel_id), enabled = 1
        `, [guildId, roleId, channel.id]);

        invalidateAutoTrackConfig(guildId);
        scanGuildForActiveStreamers(interaction.client, guildId).catch(() => {});

        const embed = new EmbedBuilder()
            .setColor('#FB923C')
            .setTitle('Auto-Track Configured')
            .addFields(
                { name: 'Role', value: role ? `<@&${role.id}>` : 'Any Member', inline: true },
                { name: 'Channel', value: `<#${channel.id}>`, inline: true }
            )
            .setFooter({ text: 'Members already tracked by self-promo, teams, or manual subs will be skipped.' });

        await interaction.editReply({ embeds: [embed] });
    },

    async autoTrackRemove(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guildId = interaction.guild.id;
        const role = interaction.options.getRole('role');
        const roleId = role?.id || null;

        // <=> is NULL-safe equality in MySQL
        const [result] = await pool.execute(
            'DELETE FROM guild_streamer_auto_track WHERE guild_id = ? AND role_id <=> ?',
            [guildId, roleId]
        );

        invalidateAutoTrackConfig(guildId);

        if (result.affectedRows === 0) {
            return interaction.editReply({
                content: `No auto-track mapping found for ${role ? `<@&${role.id}>` : '**Any Member**'}.`
            });
        }

        await interaction.editReply({
            content: `Removed auto-track mapping for ${role ? `<@&${role.id}>` : '**Any Member**'}.`
        });
    },

    async autoTrackStatus(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guildId = interaction.guild.id;

        const [rows] = await pool.execute(
            'SELECT * FROM guild_streamer_auto_track WHERE guild_id = ? ORDER BY auto_id',
            [guildId]
        );

        if (rows.length === 0) {
            return interaction.editReply({ content: 'No auto-track mappings configured for this server.' });
        }

        const description = rows.map(r => {
            const roleDisplay = r.role_id ? `<@&${r.role_id}>` : '**Any Member**';
            const status = r.enabled ? '\\u2705' : '\\u274C';
            return `${status} ${roleDisplay} → <#${r.announcement_channel_id}>`;
        }).join('\n');

        const embed = new EmbedBuilder()
            .setColor('#FB923C')
            .setTitle('Auto-Track Mappings')
            .setDescription(description)
            .setFooter({ text: 'Fallback system — skips members already tracked by other systems.' });

        await interaction.editReply({ embeds: [embed] });
    },

    async autoTrackDisable(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guildId = interaction.guild.id;

        const [result] = await pool.execute(
            'UPDATE guild_streamer_auto_track SET enabled = 0 WHERE guild_id = ?',
            [guildId]
        );

        invalidateAutoTrackConfig(guildId);

        if (result.affectedRows === 0) {
            return interaction.editReply({ content: 'No auto-track mappings found to disable.' });
        }

        await interaction.editReply({
            content: `Disabled **${result.affectedRows}** auto-track mapping(s) for this server.`
        });
    },

    // ==================== TEMP-ACCESS HANDLERS ====================

    async handleTempAccess(interaction, subcommand) {
        switch (subcommand) {
            case 'setup': return await this.tempAccessSetup(interaction);
            case 'invite': return await this.tempAccessInvite(interaction);
            case 'status': return await this.tempAccessStatus(interaction);
            case 'list': return await this.tempAccessList(interaction);
            case 'pardon': return await this.tempAccessPardon(interaction);
            case 'revoke-invite': return await this.tempAccessRevokeInvite(interaction);
            case 'toggle': return await this.tempAccessToggle(interaction);
        }
    },

    async tempAccessSetup(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        const tempRole = interaction.options.getRole('temp_role');
        const accessRole = interaction.options.getRole('access_role');
        const hours = interaction.options.getInteger('hours');
        const logChannel = interaction.options.getChannel('log_channel');
        const dmOnKick = interaction.options.getBoolean('dm_on_kick');
        const keepRole = interaction.options.getBoolean('keep_role_on_pass');

        if (tempRole.managed) {
            return interaction.editReply({
                content: `${tempRole} is managed by an integration, so the bot cannot assign or remove it. Make a plain role for guests instead.`,
            });
        }
        if (accessRole?.managed) {
            return interaction.editReply({
                content: `${accessRole} is managed by an integration and cannot be granted by the bot.`,
            });
        }

        // Both roles have to sit below the bot's highest role or every grant and
        // every removal silently 403s at runtime. Better to refuse now.
        const me = await guild.members.fetchMe();
        const tooHigh = [tempRole, accessRole].filter(r => r && me.roles.highest.comparePositionTo(r) <= 0);
        if (tooHigh.length) {
            return interaction.editReply({
                content: `The bot's highest role sits below ${tooHigh.map(r => `${r}`).join(' and ')}, so it can't assign ${tooHigh.length > 1 ? 'them' : 'it'}. Move the bot's role above ${tooHigh.length > 1 ? 'those roles' : 'that role'} and run this again.`,
            });
        }

        const existing = await getTempAccessConfig(guild.id);
        const accessIds = accessRole ? [accessRole.id] : (existing?.accessRoleIds ?? []);

        await pool.execute(`
            INSERT INTO temp_access_config
                (guild_id, enabled, temp_role_id, access_role_ids, trial_hours, dm_on_kick, keep_role_on_pass, log_channel_id, created_by)
            VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = 1,
                temp_role_id      = VALUES(temp_role_id),
                access_role_ids   = VALUES(access_role_ids),
                trial_hours       = VALUES(trial_hours),
                dm_on_kick        = VALUES(dm_on_kick),
                keep_role_on_pass = VALUES(keep_role_on_pass),
                log_channel_id    = VALUES(log_channel_id)
        `, [
            guild.id,
            tempRole.id,
            JSON.stringify(accessIds),
            hours ?? existing?.trial_hours ?? 24,
            (dmOnKick ?? existing?.dm_on_kick ?? 1) ? 1 : 0,
            (keepRole ?? existing?.keep_role_on_pass ?? 0) ? 1 : 0,
            logChannel?.id ?? existing?.log_channel_id ?? null,
            interaction.user.id,
        ]);
        invalidateTempAccessConfig(guild.id);

        const cfg = await getTempAccessConfig(guild.id);
        const embed = new EmbedBuilder()
            .setColor('#FB923C')
            .setTitle('Temporary Access Configured')
            .addFields(
                { name: 'Guest role', value: `<@&${cfg.temp_role_id}>`, inline: true },
                { name: 'Also granted', value: cfg.accessRoleIds.length ? cfg.accessRoleIds.map(id => `<@&${id}>`).join(', ') : 'nothing', inline: true },
                { name: 'Trial length', value: `${cfg.trial_hours} hours`, inline: true },
                { name: 'On pass', value: cfg.keep_role_on_pass ? 'keep the guest role' : 'remove the guest role', inline: true },
                { name: 'On removal', value: cfg.dm_on_kick ? 'DM the guest first' : 'no DM', inline: true },
                { name: 'Log channel', value: cfg.log_channel_id ? `<#${cfg.log_channel_id}>` : 'none', inline: true },
            )
            .setDescription(
                'A guest who joins through a link from `/systems temp-access invite`, or who is handed the guest role, ' +
                'is removed from the server unless they post a message, join voice, or are given any other role before their trial runs out.'
            );

        // An autorole would hand every new member a role we didn't grant, which
        // this system reads as "somebody adopted them" — every trial would end the
        // moment it began. Worth saying out loud rather than letting it look broken.
        const [autoroles] = await pool.execute(
            'SELECT roles_to_assign FROM autoroles_config WHERE guild_id = ? AND is_enabled = 1',
            [guild.id]
        ).catch(() => [[]]);
        if (autoroles?.length) {
            embed.addFields({
                name: '⚠️ Autoroles are enabled here',
                value: 'Every new member is given a role automatically, and this system treats any role it did not grant as proof someone adopted the guest — so invite-based trials will end instantly. Disable autoroles, or add the autorole as the `access_role`.',
            });
        }

        await interaction.editReply({ embeds: [embed] });
    },

    async tempAccessInvite(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        const cfg = await getTempAccessConfig(guild.id);
        if (!cfg) {
            return interaction.editReply({ content: 'Run `/systems temp-access setup` first — there is no guest role to tie a link to.' });
        }

        const channel = interaction.options.getChannel('channel') || interaction.channel;
        const maxUses = interaction.options.getInteger('max_uses') ?? 0;
        const expiresHours = interaction.options.getInteger('expires_hours') ?? 0;

        let invite;
        try {
            invite = await channel.createInvite({
                maxUses,
                maxAge: expiresHours * 3600,
                unique: true,
                reason: `Temporary guest access invite created by ${interaction.user.tag}`.replace(/[^\x00-\xFF]/g, ''),
            });
        } catch (err) {
            return interaction.editReply({ content: `Could not create an invite in ${channel}: ${err.message}` });
        }

        await trackInvite(guild.id, invite, interaction.user.id);

        const embed = new EmbedBuilder()
            .setColor('#FB923C')
            .setTitle('Guest Invite Created')
            .setDescription(`https://discord.gg/${invite.code}`)
            .addFields(
                { name: 'Lands in', value: `${channel}`, inline: true },
                { name: 'Uses', value: maxUses === 0 ? 'unlimited' : String(maxUses), inline: true },
                { name: 'Link expires', value: expiresHours === 0 ? 'never' : `in ${expiresHours}h`, inline: true },
                { name: 'Grants', value: `<@&${cfg.temp_role_id}>${cfg.accessRoleIds.length ? ` + ${cfg.accessRoleIds.map(id => `<@&${id}>`).join(', ')}` : ''}`, inline: false },
                { name: 'Guest trial', value: `${cfg.trial_hours} hours of silence and they are removed`, inline: false },
            )
            .setFooter({ text: 'Anyone joining through this link starts a trial. Other invites are unaffected.' });

        await interaction.editReply({ embeds: [embed] });
    },

    async tempAccessStatus(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        const cfg = await getTempAccessConfig(guild.id);
        if (!cfg) {
            return interaction.editReply({ content: 'Temporary access is not configured here. Set it up with `/systems temp-access setup`.' });
        }

        const invites = await getTrackedInvites(guild.id);
        const [counts] = await pool.execute(
            `SELECT status, COUNT(*) AS c FROM temp_access_members WHERE guild_id = ? AND kind = 'trial' GROUP BY status`,
            [guild.id]
        );
        const tally = Object.fromEntries(counts.map(r => [r.status, r.c]));

        const embed = new EmbedBuilder()
            .setColor(cfg.enabled ? '#FB923C' : '#6B7280')
            .setTitle(`Temporary Access — ${cfg.enabled ? 'enabled' : 'disabled'}`)
            .addFields(
                { name: 'Guest role', value: `<@&${cfg.temp_role_id}>`, inline: true },
                { name: 'Also granted', value: cfg.accessRoleIds.length ? cfg.accessRoleIds.map(id => `<@&${id}>`).join(', ') : 'nothing', inline: true },
                { name: 'Trial length', value: `${cfg.trial_hours} hours`, inline: true },
                {
                    name: `Guest invites (${invites.length})`,
                    value: invites.length
                        ? invites.map(i => `\`${i.invite_code}\` → <#${i.channel_id}> · ${i.uses_seen} use(s)`).join('\n').slice(0, 1000)
                        : 'none — create one with `/systems temp-access invite`',
                },
                {
                    name: 'Trials so far',
                    value: [
                        `on trial now: **${tally.pending || 0}**`,
                        `stayed: **${(tally.passed || 0) + (tally.exempt || 0)}**`,
                        `removed: **${tally.kicked || 0}**`,
                        `left on their own: **${tally.left || 0}**`,
                    ].join('\n'),
                },
            );

        await interaction.editReply({ embeds: [embed] });
    },

    async tempAccessList(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const [rows] = await pool.execute(
            `SELECT user_id, source, invite_code, started_at, expires_at
               FROM temp_access_members
              WHERE guild_id = ? AND status = 'pending' AND kind = 'trial'
              ORDER BY expires_at ASC
              LIMIT 40`,
            [interaction.guild.id]
        );
        if (!rows.length) {
            return interaction.editReply({ content: 'Nobody is on a temporary-access trial right now.' });
        }

        const lines = rows.map(r => {
            const ts = Math.floor(new Date(r.expires_at).getTime() / 1000);
            const how = r.source === 'invite' ? `invite \`${r.invite_code || '?'}\`` : 'given the role';
            return `<@${r.user_id}> — runs out <t:${ts}:R> (${how})`;
        });

        const embed = new EmbedBuilder()
            .setColor('#FB923C')
            .setTitle(`Guests on trial (${rows.length})`)
            .setDescription(lines.join('\n').slice(0, 4000))
            .setFooter({ text: 'A message, joining voice, or any other role keeps them. /systems temp-access pardon overrides.' });

        await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    },

    async tempAccessPardon(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const user = interaction.options.getUser('user');
        const ok = await pardonTempAccess(interaction.guild.id, user.id, `pardoned by ${interaction.user.tag}`);
        await interaction.editReply({
            content: ok
                ? `${user} is off the clock — they keep their access.`
                : `${user} is not on a temporary-access trial.`,
            allowedMentions: { parse: [] },
        });
    },

    async tempAccessRevokeInvite(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const code = interaction.options.getString('code').trim().replace(/^.*\//, '');
        const alsoDelete = interaction.options.getBoolean('delete') ?? true;

        const untracked = await untrackInvite(interaction.guild.id, code);
        if (!untracked) {
            return interaction.editReply({ content: `\`${code}\` is not a tracked guest invite.` });
        }

        let deleted = false;
        if (alsoDelete) {
            try {
                const invites = await interaction.guild.invites.fetch();
                const invite = invites.get(code);
                if (invite) { await invite.delete('Guest invite revoked'); deleted = true; }
            } catch (err) {
                logger.warn(`[TempAccess] could not delete invite ${code}: ${err.message}`);
            }
        }

        await interaction.editReply({
            content: `\`${code}\` no longer grants guest access${deleted ? ' and has been deleted from Discord' : ''}. Guests already on trial are unaffected.`,
        });
    },

    async tempAccessToggle(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const enabled = interaction.options.getBoolean('enabled');
        const [res] = await pool.execute(
            'UPDATE temp_access_config SET enabled = ? WHERE guild_id = ?',
            [enabled ? 1 : 0, interaction.guild.id]
        );
        invalidateTempAccessConfig(interaction.guild.id);

        if (!res.affectedRows) {
            return interaction.editReply({ content: 'Temporary access is not configured here yet.' });
        }
        await interaction.editReply({
            content: enabled
                ? 'Temporary access is on. New guests start a trial and expired trials are acted on.'
                : 'Temporary access is off. No new trials start and nobody will be removed — existing trials stay paused until you turn it back on.',
        });
    }
};
