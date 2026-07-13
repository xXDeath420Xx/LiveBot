/**
 * Shared backup utility — creates v5 server snapshots
 * Used by both the dashboard route and the auto-backup scheduler
 */

import pool from './db.js';
import logger from './logger.js';

export const BACKUP_CONFIG_TABLES = [
    'guild_config', 'guild_settings', 'logging_config', 'log_config', 'log_event_config',
    'welcome_settings', 'moderation_config', 'escalation_rules', 'automod_rules',
    'automod_spam_config', 'automod_heat_config', 'adaptive_spam_config',
    'anti_raid_config', 'anti_nuke_config', 'anti_nuke_whitelist', 'join_gate_config',
    'quarantine_config', 'raid_detection_config', 'raid_protection_config',
    'selfbot_detection_config', 'phishing_config',
    'global_ban_config', 'starboard_config', 'suggestion_config',
    'economy_config', 'currency_config', 'gambling_config', 'music_config',
    'level_config', 'level_role_rewards', 'birthday_config',
    'ticket_config', 'ticket_panels', 'ticket_forms',
    'self_promo_config', 'community_support_config',
    'prefix_command_config', 'prefix_command_aliases',
    'guild_command_restrictions', 'orientation_config', 'imagine_config',
    'stat_display_channels', 'scheduled_purges', 'custom_embeds',
    'custom_commands', 'autoresponders', 'tags',
    'reaction_role_panels', 'autoroles_config',
    'temp_channel_config', 'auto_publisher_config', 'auto_meme_config',
    'auto_delete_channels', 'sticky_messages',
    'confession_config', 'weather_config', 'tts_config',
    'vc_sound_config', 'scheduled_events_config',
    'twitch_schedule_sync_config', 'free_games_subscriptions',
    'guild_streamer_auto_track', 'subscriptions',
    'tiktok_subscriptions', 'reddit_feeds', 'twitter_feeds', 'youtube_feeds',
    'steam_watchers', 'steam_guild_settings',
    'forum_config', 'modmail_config', 'qotd_channels',
    'channel_settings', 'log_channel_routing',
    'invite_policy', 'verification_config',
    'user_birthdays', 'reminders'
];

/**
 * Create a v5 snapshot for a guild
 * @param {Guild} guild - Discord.js guild object
 * @returns {Object} snapshot object
 */
export async function createSnapshot(guild) {
    function serializeOverwrites(channel) {
        return channel.permissionOverwrites.cache.map(ow => ({
            id: ow.id, type: ow.type,
            allow: ow.allow.bitfield.toString(),
            deny: ow.deny.bitfield.toString()
        }));
    }

    // Fetch members — gracefully handle missing intent
    try { await guild.members.fetch(); } catch { /* GuildMembers intent may be missing */ }

    const discord = {
        roles: guild.roles.cache
            .filter(r => !r.managed && r.name !== '@everyone')
            .sort((a, b) => b.position - a.position)
            .map(r => ({
                id: r.id, name: r.name, color: r.hexColor,
                position: r.position, permissions: r.permissions.bitfield.toString(),
                hoist: r.hoist, mentionable: r.mentionable,
                icon: r.icon || null, unicodeEmoji: r.unicodeEmoji || null
            })),
        everyonePermissions: guild.roles.everyone.permissions.bitfield.toString(),
        memberRoles: (() => {
            const map = {};
            guild.roles.cache.filter(r => !r.managed && r.name !== '@everyone').forEach(r => {
                const members = r.members.map(m => m.id);
                if (members.length > 0) map[r.id] = members;
            });
            return map;
        })(),
        members: guild.members.cache.map(m => ({
            id: m.id, username: m.user.username, displayName: m.displayName,
            nickname: m.nickname,
            roles: m.roles.cache.filter(r => r.name !== '@everyone' && !r.managed).map(r => r.id),
            joinedAt: m.joinedAt?.toISOString() || null
        })),
        categories: guild.channels.cache.filter(c => c.type === 4).sort((a, b) => a.position - b.position)
            .map(c => ({ id: c.id, name: c.name, position: c.position, permissionOverwrites: serializeOverwrites(c) })),
        channels: guild.channels.cache.filter(c => c.type !== 4).sort((a, b) => a.position - b.position)
            .map(c => {
                const ch = {
                    id: c.id, name: c.name, type: c.type, parentId: c.parentId,
                    position: c.position, topic: c.topic || null, nsfw: c.nsfw || false,
                    bitrate: c.bitrate || null, userLimit: c.userLimit || null,
                    rateLimitPerUser: c.rateLimitPerUser || 0,
                    permissionOverwrites: serializeOverwrites(c),
                    defaultAutoArchiveDuration: c.defaultAutoArchiveDuration || null,
                    defaultThreadRateLimitPerUser: c.defaultThreadRateLimitPerUser || null,
                };
                if (c.type === 15) {
                    ch.availableTags = c.availableTags?.map(t => ({ id: t.id, name: t.name, moderated: t.moderated, emoji: t.emoji })) || [];
                    ch.defaultForumLayout = c.defaultForumLayout;
                    ch.defaultSortOrder = c.defaultSortOrder;
                    ch.defaultReactionEmoji = c.defaultReactionEmoji;
                }
                return ch;
            }),
        settings: {
            name: guild.name, description: guild.description || null,
            iconURL: guild.iconURL({ size: 512 }),
            bannerURL: guild.bannerURL({ size: 512 }) || null,
            splashURL: guild.splashURL({ size: 512 }) || null,
            verificationLevel: guild.verificationLevel,
            defaultMessageNotifications: guild.defaultMessageNotifications,
            explicitContentFilter: guild.explicitContentFilter,
            systemChannelId: guild.systemChannelId,
            systemChannelFlags: guild.systemChannelFlags?.bitfield || 0,
            rulesChannelId: guild.rulesChannelId,
            publicUpdatesChannelId: guild.publicUpdatesChannelId,
            afkChannelId: guild.afkChannelId,
            afkTimeout: guild.afkTimeout,
            preferredLocale: guild.preferredLocale,
            premiumProgressBarEnabled: guild.premiumProgressBarEnabled,
        },
        emojis: (() => { try { return guild.emojis.cache.filter(e => !e.managed).map(e => ({ id: e.id, name: e.name, animated: e.animated, url: e.imageURL({ size: 128, extension: e.animated ? 'gif' : 'png' }) })); } catch { return []; } })(),
        stickers: (() => { try { return guild.stickers.cache.map(s => ({ id: s.id, name: s.name, description: s.description || '', tags: s.tags || '', url: s.url })); } catch { return []; } })(),
    };

    let autoModRules = [];
    try { const rules = await guild.autoModerationRules.fetch(); autoModRules = rules.map(r => ({ name: r.name, eventType: r.eventType, triggerType: r.triggerType, triggerMetadata: r.triggerMetadata, actions: r.actions.map(a => ({ type: a.type, metadata: a.metadata })), enabled: r.enabled, exemptRoles: r.exemptRoles.map(er => er.id), exemptChannels: r.exemptChannels.map(ec => ec.id) })); } catch {}

    let scheduledEvents = [];
    try { const events = await guild.scheduledEvents.fetch(); scheduledEvents = events.map(e => ({ name: e.name, description: e.description || '', scheduledStartAt: e.scheduledStartAt?.toISOString(), scheduledEndAt: e.scheduledEndAt?.toISOString(), entityType: e.entityType, channelId: e.channelId, entityMetadata: e.entityMetadata, image: e.image })); } catch {}

    let webhooks = [];
    try { const wh = await guild.fetchWebhooks(); webhooks = wh.filter(w => w.owner?.id !== guild.client.user.id).map(w => ({ name: w.name, channelId: w.channelId, avatar: w.avatarURL({ size: 256 }) || null })); } catch {}

    let bans = [];
    try { const banList = await guild.bans.fetch(); bans = banList.map(b => ({ userId: b.user.id, username: b.user.username, reason: b.reason || null })); } catch {}

    const botConfig = {};
    for (const table of BACKUP_CONFIG_TABLES) {
        try { const [rows] = await pool.execute(`SELECT * FROM \`${table}\` WHERE guild_id = ?`, [guild.id]); if (rows.length > 0) botConfig[table] = rows; } catch {}
    }

    return {
        version: 5,
        discord,
        autoModRules,
        scheduledEvents,
        webhooks,
        bans,
        botConfig,
        meta: {
            memberCount: guild.memberCount,
            roleCount: guild.roles.cache.size,
            channelCount: guild.channels.cache.size,
            emojiCount: discord.emojis.length,
            stickerCount: discord.stickers.length,
            webhookCount: webhooks.length,
            banCount: bans.length,
            configTablesCount: Object.keys(botConfig).length,
            configRowsCount: Object.values(botConfig).reduce((s, r) => s + r.length, 0),
            createdAt: new Date().toISOString(),
            botId: guild.client.user.id
        }
    };
}

/**
 * Save a snapshot to the database
 */
export async function saveBackup(guildId, snapshotName, snapshot, createdById) {
    await pool.execute(
        'INSERT INTO server_backups (guild_id, snapshot_name, snapshot_json, created_by_id) VALUES (?, ?, ?, ?)',
        [guildId, snapshotName, JSON.stringify(snapshot), createdById]
    );
}
