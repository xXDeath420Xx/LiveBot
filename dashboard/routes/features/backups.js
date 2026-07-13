/**
 * Server Backup Routes — create, delete, restore
 * Extracted from server.js for cleanliness
 */

import express from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { createSnapshot, saveBackup, BACKUP_CONFIG_TABLES } from '../../../utils/backup-utils.js';

const router = express.Router();

// Create backup
router.post('/manage/:guildId/create-backup', async (req, res) => {
    const guildId = req.params.guildId;
    try {
        const snapshotName = (req.body.snapshot_name || '').trim();
        if (!snapshotName) return res.redirect(`/manage/${guildId}?page=backups&error=name_required`);

        const botClient = global.botManager?.getClientForGuild(guildId) || req.app.locals.client;
        const guild = botClient?.guilds?.cache?.get(guildId);
        if (!guild) return res.redirect(`/manage/${guildId}?page=backups&error=guild_not_found`);

        const snapshot = await createSnapshot(guild);
        await saveBackup(guildId, snapshotName, snapshot, req.user.id);

        const m = snapshot.meta;
        logger.info(`[Backup] Created v5 backup "${snapshotName}" for ${guild.name} (${guildId}) — ${m.roleCount} roles, ${m.channelCount} channels, ${m.emojiCount} emojis, ${m.stickerCount} stickers, ${snapshot.discord.members.length} members, ${m.webhookCount} webhooks, ${m.banCount} bans, ${m.configTablesCount} config tables (${m.configRowsCount} rows)`);
        res.redirect(`/manage/${guildId}?page=backups&success=created`);
    } catch (error) {
        logger.error('[Backup] Error creating backup:', { error: error.message, stack: error.stack, guildId });
        res.redirect(`/manage/${guildId}?page=backups&error=create_failed`);
    }
});

// Delete backup
router.post('/manage/:guildId/delete-backup', async (req, res) => {
    const guildId = req.params.guildId;
    try {
        const backupId = req.body.backupId;
        if (!backupId) return res.redirect(`/manage/${guildId}?page=backups&error=no_id`);
        await pool.execute('DELETE FROM server_backups WHERE id = ? AND guild_id = ?', [backupId, guildId]);
        logger.info(`[Backup] Deleted backup ${backupId} for guild ${guildId} by ${req.user.username}`);
        res.redirect(`/manage/${guildId}?page=backups&success=deleted`);
    } catch (error) {
        logger.error('[Backup] Error deleting backup:', { error: error.message, guildId });
        res.redirect(`/manage/${guildId}?page=backups&error=delete_failed`);
    }
});

// Restore backup — full server restore
router.post('/manage/:guildId/restore-backup', async (req, res) => {
    const guildId = req.params.guildId;
    try {
        const backupId = req.body.backupId;
        if (!backupId) return res.redirect(`/manage/${guildId}?page=backups&error=no_id`);

        const [rows] = await pool.execute('SELECT snapshot_name, snapshot_json FROM server_backups WHERE id = ? AND guild_id = ?', [backupId, guildId]);
        if (!rows.length) return res.redirect(`/manage/${guildId}?page=backups&error=not_found`);

        const snapshot = JSON.parse(rows[0].snapshot_json);
        const botClient = global.botManager?.getClientForGuild(guildId) || req.app.locals.client;
        const guild = botClient?.guilds?.cache?.get(guildId);
        if (!guild) return res.redirect(`/manage/${guildId}?page=backups&error=guild_not_found`);

        const disc = snapshot.discord || snapshot;

        logger.warn(`[Backup Restore] Starting v${snapshot.version || '?'} restore of "${rows[0].snapshot_name}" for ${guild.name} (${guildId}) by ${req.user.username}`);

        const log = [];
        const delay = (ms) => new Promise(r => setTimeout(r, ms));
        const roleIdMap = new Map();
        const categoryIdMap = new Map();
        const channelIdMap = new Map();

        // Phase 1: Roles
        for (const rd of (disc.roles || []).sort((a, b) => b.position - a.position)) {
            try {
                const existing = guild.roles.cache.find(r => r.name === rd.name && !r.managed);
                if (existing) {
                    await existing.edit({ color: rd.color, hoist: rd.hoist, mentionable: rd.mentionable, permissions: BigInt(rd.permissions), reason: 'Backup restore' });
                    roleIdMap.set(rd.id, existing.id);
                    log.push(`Updated role: ${rd.name}`);
                } else {
                    const nr = await guild.roles.create({ name: rd.name, color: rd.color, hoist: rd.hoist, mentionable: rd.mentionable, permissions: BigInt(rd.permissions), reason: 'Backup restore' });
                    roleIdMap.set(rd.id, nr.id);
                    log.push(`Created role: ${rd.name}`);
                }
                await delay(300);
            } catch (err) { log.push(`Failed role ${rd.name}: ${err.message}`); }
        }
        if (disc.everyonePermissions) {
            try { await guild.roles.everyone.edit({ permissions: BigInt(disc.everyonePermissions), reason: 'Backup restore' }); log.push('Updated @everyone permissions'); } catch (err) { log.push(`Failed @everyone: ${err.message}`); }
        }

        // Phase 1.5: Member Role Assignments
        const memberRolesData = disc.memberRoles || {};
        if (Object.keys(memberRolesData).length > 0) {
            await guild.members.fetch();
            for (const [oldRoleId, memberIds] of Object.entries(memberRolesData)) {
                const newRoleId = roleIdMap.get(oldRoleId) || oldRoleId;
                const role = guild.roles.cache.get(newRoleId);
                if (!role || role.managed) continue;
                for (const memberId of memberIds) {
                    try {
                        const member = guild.members.cache.get(memberId);
                        if (!member || member.roles.cache.has(newRoleId)) continue;
                        await member.roles.add(role, 'Backup restore');
                        log.push(`Assigned role ${role.name} to ${member.user.username}`);
                        await delay(200);
                    } catch { /* skip */ }
                }
            }
        }

        // Phase 1.6: Pending rejoin restores
        const gracePeriodDays = parseInt(req.body.gracePeriod) || 30;
        if (disc.members && disc.members.length > 0 && gracePeriodDays > 0) {
            try {
                const pendingRestores = disc.members.map(m => ({
                    userId: m.id, username: m.username, nickname: m.nickname,
                    roles: m.roles.map(oldId => roleIdMap.get(oldId) || oldId).filter(id => guild.roles.cache.has(id))
                })).filter(m => m.roles.length > 0);

                if (pendingRestores.length > 0) {
                    await pool.execute(
                        `INSERT INTO guild_settings (guild_id, backup_restore_data, backup_restore_expires)
                         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))
                         ON DUPLICATE KEY UPDATE backup_restore_data = VALUES(backup_restore_data), backup_restore_expires = VALUES(backup_restore_expires)`,
                        [guildId, JSON.stringify(pendingRestores), gracePeriodDays]
                    ).catch(() => { logger.warn('[Backup Restore] backup_restore_data column not found'); });
                    log.push(`Stored ${pendingRestores.length} pending member restores (${gracePeriodDays}-day window)`);
                }
            } catch (err) { log.push(`Failed pending restores: ${err.message}`); }
        }

        // Phase 2: Categories
        function mapOverwrites(owList) {
            return (owList || []).map(ow => ({
                id: (ow.type === 0 ? roleIdMap.get(ow.id) : ow.id) || ow.id,
                type: ow.type, allow: BigInt(ow.allow), deny: BigInt(ow.deny)
            })).filter(ow => ow.id);
        }

        for (const cd of (disc.categories || []).sort((a, b) => a.position - b.position)) {
            try {
                const existing = guild.channels.cache.find(c => c.type === 4 && c.name === cd.name);
                const ow = mapOverwrites(cd.permissionOverwrites);
                if (existing) {
                    categoryIdMap.set(cd.id, existing.id);
                    if (ow.length) await existing.permissionOverwrites.set(ow, 'Backup restore');
                    log.push(`Updated category: ${cd.name}`);
                } else {
                    const nc = await guild.channels.create({ name: cd.name, type: 4, permissionOverwrites: ow, reason: 'Backup restore' });
                    categoryIdMap.set(cd.id, nc.id);
                    log.push(`Created category: ${cd.name}`);
                }
                await delay(500);
            } catch (err) { log.push(`Failed category ${cd.name}: ${err.message}`); }
        }

        // Phase 3: Channels
        for (const ch of (disc.channels || []).sort((a, b) => a.position - b.position)) {
            try {
                const existing = guild.channels.cache.find(c => c.type !== 4 && c.name === ch.name && c.type === ch.type);
                const parentId = ch.parentId ? (categoryIdMap.get(ch.parentId) || ch.parentId) : null;
                const validParent = parentId && guild.channels.cache.has(parentId) ? parentId : null;
                const ow = mapOverwrites(ch.permissionOverwrites);

                if (existing) {
                    const ed = { reason: 'Backup restore' };
                    if (ch.topic !== undefined) ed.topic = ch.topic;
                    if (ch.nsfw !== undefined) ed.nsfw = ch.nsfw;
                    if (validParent) ed.parent = validParent;
                    if (ch.rateLimitPerUser && existing.type === 0) ed.rateLimitPerUser = ch.rateLimitPerUser;
                    if (ch.defaultAutoArchiveDuration) ed.defaultAutoArchiveDuration = ch.defaultAutoArchiveDuration;
                    await existing.edit(ed);
                    if (ow.length) await existing.permissionOverwrites.set(ow, 'Backup restore');
                    channelIdMap.set(ch.id, existing.id);
                    log.push(`Updated channel: #${ch.name}`);
                } else {
                    const cd = { name: ch.name, type: ch.type, parent: validParent, permissionOverwrites: ow, reason: 'Backup restore' };
                    if (ch.topic) cd.topic = ch.topic;
                    if (ch.nsfw) cd.nsfw = ch.nsfw;
                    if (ch.bitrate && (ch.type === 2 || ch.type === 13)) cd.bitrate = ch.bitrate;
                    if (ch.userLimit && (ch.type === 2 || ch.type === 13)) cd.userLimit = ch.userLimit;
                    if (ch.rateLimitPerUser && ch.type === 0) cd.rateLimitPerUser = ch.rateLimitPerUser;
                    if (ch.defaultAutoArchiveDuration) cd.defaultAutoArchiveDuration = ch.defaultAutoArchiveDuration;
                    if (ch.type === 15 && ch.availableTags) cd.availableTags = ch.availableTags;
                    if (ch.type === 15 && ch.defaultForumLayout !== undefined) cd.defaultForumLayout = ch.defaultForumLayout;
                    if (ch.type === 15 && ch.defaultSortOrder !== undefined) cd.defaultSortOrder = ch.defaultSortOrder;
                    const nc = await guild.channels.create(cd);
                    channelIdMap.set(ch.id, nc.id);
                    log.push(`Created channel: #${ch.name}`);
                }
                await delay(500);
            } catch (err) { log.push(`Failed channel #${ch.name}: ${err.message}`); }
        }

        // Phase 4: Server Settings
        if (disc.settings) {
            try {
                const s = disc.settings;
                const ed = { reason: 'Backup restore' };
                if (s.verificationLevel !== undefined) ed.verificationLevel = s.verificationLevel;
                if (s.defaultMessageNotifications !== undefined) ed.defaultMessageNotifications = s.defaultMessageNotifications;
                if (s.explicitContentFilter !== undefined) ed.explicitContentFilter = s.explicitContentFilter;
                if (s.afkTimeout !== undefined) ed.afkTimeout = s.afkTimeout;
                if (s.preferredLocale) ed.preferredLocale = s.preferredLocale;
                if (s.premiumProgressBarEnabled !== undefined) ed.premiumProgressBarEnabled = s.premiumProgressBarEnabled;
                if (s.description !== undefined) ed.description = s.description;
                if (s.systemChannelFlags !== undefined) ed.systemChannelFlags = s.systemChannelFlags;
                if (s.afkChannelId) { const mapped = channelIdMap.get(s.afkChannelId) || s.afkChannelId; if (guild.channels.cache.has(mapped)) ed.afkChannel = mapped; }
                if (s.systemChannelId) { const mapped = channelIdMap.get(s.systemChannelId) || s.systemChannelId; if (guild.channels.cache.has(mapped)) ed.systemChannel = mapped; }
                if (s.rulesChannelId) { const mapped = channelIdMap.get(s.rulesChannelId) || s.rulesChannelId; if (guild.channels.cache.has(mapped)) ed.rulesChannel = mapped; }
                if (s.publicUpdatesChannelId) { const mapped = channelIdMap.get(s.publicUpdatesChannelId) || s.publicUpdatesChannelId; if (guild.channels.cache.has(mapped)) ed.publicUpdatesChannel = mapped; }
                await guild.edit(ed);
                log.push('Updated server settings');
            } catch (err) { log.push(`Failed settings: ${err.message}`); }
        }

        // Phase 5: Bot Config (DB)
        if (snapshot.botConfig) {
            for (const [table, tRows] of Object.entries(snapshot.botConfig)) {
                try {
                    await pool.execute(`DELETE FROM \`${table}\` WHERE guild_id = ?`, [guildId]);
                    for (const row of tRows) {
                        const cols = Object.keys(row);
                        const placeholders = cols.map(() => '?').join(', ');
                        const values = cols.map(c => row[c]);
                        await pool.execute(`INSERT INTO \`${table}\` (${cols.map(c => '`' + c + '`').join(', ')}) VALUES (${placeholders})`, values);
                    }
                    log.push(`Restored ${tRows.length} rows in ${table}`);
                } catch (err) { log.push(`Failed DB table ${table}: ${err.message}`); }
            }
        }

        // Phase 6: Bans
        if (snapshot.bans && snapshot.bans.length > 0) {
            const currentBans = await guild.bans.fetch().catch(() => new Map());
            for (const ban of snapshot.bans) {
                try {
                    if (currentBans.has(ban.userId)) continue;
                    await guild.members.ban(ban.userId, { reason: ban.reason ? `Backup restore: ${ban.reason}` : 'Backup restore' });
                    log.push(`Restored ban: ${ban.username}`);
                    await delay(300);
                } catch { /* skip */ }
            }
        }

        // Phase 7: Emojis
        if (disc.emojis && disc.emojis.length > 0) {
            const existingEmojis = guild.emojis.cache.map(e => e.name);
            for (const emoji of disc.emojis) {
                try {
                    if (existingEmojis.includes(emoji.name)) continue;
                    await guild.emojis.create({ attachment: emoji.url, name: emoji.name, reason: 'Backup restore' });
                    log.push(`Restored emoji: ${emoji.name}`);
                    await delay(500);
                } catch { /* skip */ }
            }
        }

        // Phase 8: Stickers
        if (disc.stickers && disc.stickers.length > 0) {
            const existingStickers = guild.stickers.cache.map(s => s.name);
            for (const sticker of disc.stickers) {
                try {
                    if (existingStickers.includes(sticker.name)) continue;
                    await guild.stickers.create({ file: sticker.url, name: sticker.name, tags: sticker.tags || 'custom', description: sticker.description || '', reason: 'Backup restore' });
                    log.push(`Restored sticker: ${sticker.name}`);
                    await delay(500);
                } catch { /* skip */ }
            }
        }

        // Phase 9: Webhooks
        if (snapshot.webhooks && snapshot.webhooks.length > 0) {
            for (const wh of snapshot.webhooks) {
                try {
                    const chId = channelIdMap.get(wh.channelId) || wh.channelId;
                    const channel = guild.channels.cache.get(chId);
                    if (!channel) continue;
                    const existing = await channel.fetchWebhooks().catch(() => new Map());
                    if (existing.some(w => w.name === wh.name)) continue;
                    await channel.createWebhook({ name: wh.name, avatar: wh.avatar, reason: 'Backup restore' });
                    log.push(`Restored webhook: ${wh.name}`);
                    await delay(300);
                } catch { /* skip */ }
            }
        }

        const created = log.filter(l => l.startsWith('Created') || l.startsWith('Restored')).length;
        const updated = log.filter(l => l.startsWith('Updated') || l.startsWith('Assigned') || l.startsWith('Stored')).length;
        const failed = log.filter(l => l.startsWith('Failed')).length;
        logger.info(`[Backup Restore] Completed v${snapshot.version || '?'} restore of "${rows[0].snapshot_name}" for ${guild.name} — ${log.length} ops: ${created} created/restored, ${updated} updated, ${failed} failed`);

        res.redirect(`/manage/${guildId}?page=backups&success=restored`);
    } catch (error) {
        logger.error('[Backup Restore] Error:', { error: error.message, stack: error.stack, guildId });
        res.redirect(`/manage/${guildId}?page=backups&error=restore_failed`);
    }
});

// Backup diff — compare a backup against current server state
router.get('/api/guilds/:guildId/backup-diff/:backupId', async (req, res) => {
    try {
        const { guildId, backupId } = req.params;
        const [rows] = await pool.execute('SELECT snapshot_name, snapshot_json FROM server_backups WHERE id = ? AND guild_id = ?', [backupId, guildId]);
        if (!rows.length) return res.status(404).json({ error: 'Backup not found' });

        const snapshot = JSON.parse(rows[0].snapshot_json);
        const disc = snapshot.discord || snapshot;

        const botClient = global.botManager?.getClientForGuild(guildId) || req.app?.locals?.client;
        const guild = botClient?.guilds?.cache?.get(guildId);
        if (!guild) return res.status(404).json({ error: 'Guild not accessible' });

        const diff = { roles: { added: [], removed: [], changed: [] }, categories: { added: [], removed: [] }, channels: { added: [], removed: [] }, settings: [], bans: { added: 0, removed: 0 }, emojis: { added: 0, removed: 0 }, summary: {} };

        // Role diff
        const currentRoles = guild.roles.cache.filter(r => !r.managed && r.name !== '@everyone');
        const backupRoleNames = new Set((disc.roles || []).map(r => r.name));
        const currentRoleNames = new Set(currentRoles.map(r => r.name));

        for (const r of disc.roles || []) {
            if (!currentRoleNames.has(r.name)) {
                diff.roles.removed.push(r.name);
            } else {
                const current = currentRoles.find(cr => cr.name === r.name);
                if (current) {
                    const changes = [];
                    if (current.hexColor !== r.color) changes.push(`color: ${r.color} → ${current.hexColor}`);
                    if (current.permissions.bitfield.toString() !== r.permissions) changes.push('permissions changed');
                    if (current.hoist !== r.hoist) changes.push(`hoist: ${r.hoist} → ${current.hoist}`);
                    if (changes.length) diff.roles.changed.push({ name: r.name, changes });
                }
            }
        }
        for (const [, r] of currentRoles) {
            if (!backupRoleNames.has(r.name)) diff.roles.added.push(r.name);
        }

        // Category diff
        const currentCats = guild.channels.cache.filter(c => c.type === 4);
        const backupCatNames = new Set((disc.categories || []).map(c => c.name));
        const currentCatNames = new Set(currentCats.map(c => c.name));
        for (const c of disc.categories || []) { if (!currentCatNames.has(c.name)) diff.categories.removed.push(c.name); }
        for (const [, c] of currentCats) { if (!backupCatNames.has(c.name)) diff.categories.added.push(c.name); }

        // Channel diff
        const currentChannels = guild.channels.cache.filter(c => c.type !== 4);
        const backupChNames = new Set((disc.channels || []).map(c => c.name));
        const currentChNames = new Set(currentChannels.map(c => c.name));
        for (const c of disc.channels || []) { if (!currentChNames.has(c.name)) diff.channels.removed.push(c.name); }
        for (const [, c] of currentChannels) { if (!backupChNames.has(c.name)) diff.channels.added.push('#' + c.name); }

        // Settings diff
        if (disc.settings) {
            const s = disc.settings;
            if (s.verificationLevel !== undefined && s.verificationLevel !== guild.verificationLevel) diff.settings.push(`Verification level: ${s.verificationLevel} → ${guild.verificationLevel}`);
            if (s.explicitContentFilter !== undefined && s.explicitContentFilter !== guild.explicitContentFilter) diff.settings.push(`Content filter: ${s.explicitContentFilter} → ${guild.explicitContentFilter}`);
            if (s.name && s.name !== guild.name) diff.settings.push(`Server name: ${s.name} → ${guild.name}`);
        }

        // Emoji diff
        const backupEmojiNames = new Set((disc.emojis || []).map(e => e.name));
        const currentEmojiNames = new Set(guild.emojis.cache.filter(e => !e.managed).map(e => e.name));
        diff.emojis.removed = [...backupEmojiNames].filter(n => !currentEmojiNames.has(n)).length;
        diff.emojis.added = [...currentEmojiNames].filter(n => !backupEmojiNames.has(n)).length;

        // Summary
        const totalChanges = diff.roles.added.length + diff.roles.removed.length + diff.roles.changed.length +
            diff.categories.added.length + diff.categories.removed.length +
            diff.channels.added.length + diff.channels.removed.length +
            diff.settings.length + diff.emojis.added + diff.emojis.removed;

        diff.summary = {
            totalChanges,
            identical: totalChanges === 0,
            backupName: rows[0].snapshot_name,
            backupVersion: snapshot.version || '?',
            backupDate: snapshot.meta?.createdAt
        };

        res.json({ success: true, diff });
    } catch (error) {
        logger.error('[Backup Diff] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to generate diff' });
    }
});

export default router;
