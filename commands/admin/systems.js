import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getSelfPromoConfig, invalidateSelfPromoConfig } from '../../core/self-promo-handler.js';
import { invalidateConfig as invalidateCommunityConfig } from '../../core/community-support-manager.js';
import { invalidateAutoTrackConfig, scanGuildForActiveStreamers } from '../../events/presenceUpdate.js';

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
            LEFT JOIN guild_config gc ON CAST(sub.guild_id AS CHAR) = CAST(gc.guild_id AS CHAR)
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
    }
};
