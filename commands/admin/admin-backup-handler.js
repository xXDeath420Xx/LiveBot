import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { logFeatureEvent, userLabel } from '../../core/feature-log.js';
import { themeColor } from '../../core/guild-theme.js';
import { isRestoreDisabled, RESTORE_UNAVAILABLE_MESSAGE } from '../../utils/backup-restore-guard.js';
import { createSnapshot } from '../../utils/backup-utils.js';
import { loadBackupRow, previewRestore, startRestore, activeRun, normalizeSnapshot } from '../../core/backup-restore.js';

export async function handleCreate(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    const name = interaction.options.getString('name');
    const guild = interaction.guild;

    // Same v5 snapshot as the dashboard and the weekly backup (utils/backup-utils.js), so every backup
    // restores the same way (H-801). Until 2026-11-20 this wrote its own older format.
    const snapshot = await createSnapshot(guild);
    const [result] = await pool.execute(
        `INSERT INTO server_backups (guild_id, snapshot_name, snapshot_json, created_by_id) VALUES (?, ?, ?, ?)`,
        [guildId, name, JSON.stringify(snapshot), userId]
    );
    const m = snapshot.meta;
    const d = snapshot.discord;

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'success'))
        .setTitle('✅ Backup Created')
        .setDescription(`Server backup **${name}** has been created successfully!`)
        .addFields(
            { name: 'Backup ID', value: `${result.insertId}`, inline: true },
            { name: 'Roles', value: `${d.roles.length}`, inline: true },
            { name: 'Categories', value: `${d.categories.length}`, inline: true },
            { name: 'Channels', value: `${d.channels.length}`, inline: true },
            { name: 'Emoji', value: `${m.emojiCount}`, inline: true },
            { name: 'Stickers', value: `${m.stickerCount}`, inline: true },
            { name: 'Members', value: `${d.members.length}`, inline: true },
            { name: 'Bans', value: `${m.banCount}`, inline: true },
            { name: 'Bot settings', value: `${m.configTablesCount} tables`, inline: true }
        )
        .setFooter({ text: `Use /admin backup restore ${result.insertId} to see what a restore would change` })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    logger.info('[Backup] Created backup', {
        guildId,
        backupId: result.insertId,
        name,
        userId
    });

    void logFeatureEvent(() => (guild), 'backup.created', () => ({
        title: '💾 Backup Created',
        description: `Server backup **${name}** was saved with \`/admin backup create\`.`,
        fields: [
            ['Name', name],
            ['Backup ID', String(result.insertId)],
            ['By', userLabel(interaction.user)],
            ['Roles', d.roles.length],
            ['Channels', d.channels.length],
            ['Categories', d.categories.length],
            ['Emoji', m.emojiCount],
            ['Members', d.members.length],
        ],
    }));
}

export async function handleList(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const [backups] = await pool.execute(
        `SELECT id, snapshot_name, created_by_id, created_at FROM server_backups WHERE guild_id = ? ORDER BY created_at DESC`,
        [guildId]
    );

    if (backups.length === 0) {
        return await interaction.editReply({
            content: 'No backups found for this server. Create one with `/admin backup create`!'
        });
    }

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle('📦 Server Backups')
        .setDescription(`Found ${backups.length} backup${backups.length !== 1 ? 's' : ''} for this server:\n`);

    for (const backup of backups.slice(0, 10)) {
        const creator = await interaction.guild.members.fetch(backup.created_by_id).catch(() => null);
        const creatorName = creator ? creator.user.tag : 'Unknown User';
        const date = new Date(backup.created_at).toLocaleString();

        embed.addFields({
            name: `ID: ${backup.id} - ${backup.snapshot_name}`,
            value: `Created by ${creatorName} on ${date}`,
            inline: false
        });
    }

    if (backups.length > 10) {
        embed.setFooter({ text: `Showing 10 of ${backups.length} backups` });
    }

    await interaction.editReply({ embeds: [embed] });
}

// Restore (register H-801, rebuilt 2026-11-20): a preview first, nothing deleted unless the admin asks,
// deletes last. The work is done by core/backup-restore.js, shared with the dashboard.
const clip = (lines, max = 1000) => {
    let out = '';
    let n = 0;
    for (const l of lines) {
        const next = `${out}${out ? '\n' : ''}• ${l}`;
        if (next.length > max - 30) break;
        out = next; n++;
    }
    return lines.length > n ? `${out}\n…and ${lines.length - n} more` : out;
};

function restorePreviewEmbed(guildId, backupRow, summary, removeExtras, extra) {
    const c = summary.counts;
    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, c.deletes ? 'danger' : 'primary'))
        .setTitle(`♻️ Restore preview: ${backupRow.snapshot_name}`.slice(0, 256))
        .setDescription([
            c.total ? `This restore would make **${c.total}** change${c.total === 1 ? '' : 's'}. Nothing has been changed yet.` : 'The server already matches this backup. There is nothing to restore.',
            removeExtras ? '**Also remove** is on: channels, categories and roles that are not in the backup are deleted at the end, and only if everything before worked.'
                : 'Nothing that is not in the backup is removed.',
            extra || '',
        ].filter(Boolean).join('\n\n'));
    const kept = summary.keptNotInBackup;
    const keptLines = kept ? [...kept.categories.map(n => `Category ${n}`), ...kept.channels.map(n => `#${n}`), ...kept.roles.map(n => `Role ${n}`)] : [];
    for (const [title, lines] of [['Will be created', summary.create], ['Will be changed', summary.update], ['Will be deleted', summary.remove],
        ['Not in the backup, kept', keptLines], ['Cannot be restored', summary.skipped], ['Good to know', summary.notes]]) {
        if (lines?.length) embed.addFields({ name: `${title} (${lines.length})`, value: clip(lines) });
    }
    return embed.setFooter({ text: 'Buttons stay active for 2 minutes' });
}

function restoreButtons(summary, removeExtras, running) {
    const row = new ActionRowBuilder();
    if (summary.counts.total && !running) {
        row.addComponents(new ButtonBuilder().setCustomId('bkrestore_go')
            .setLabel(summary.counts.deletes ? `Restore and delete ${summary.counts.deletes}` : 'Restore')
            .setStyle(summary.counts.deletes ? ButtonStyle.Danger : ButtonStyle.Primary));
    }
    row.addComponents(new ButtonBuilder().setCustomId('bkrestore_toggle')
        .setLabel(removeExtras ? 'Keep things not in the backup' : 'Preview with "also remove"')
        .setStyle(ButtonStyle.Secondary));
    row.addComponents(new ButtonBuilder().setCustomId('bkrestore_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
    return [row];
}

export async function handleRestore(interaction) {
    // H-801 kill switch: refuse before reading the backup or touching the server.
    if (isRestoreDisabled()) {
        return interaction.reply({ content: RESTORE_UNAVAILABLE_MESSAGE, ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const backupId = interaction.options.getInteger('backup_id');
    const backupRow = await loadBackupRow(pool, guild.id, backupId);
    if (!backupRow) {
        return interaction.editReply({ content: `Backup with ID ${backupId} not found for this server!` });
    }

    let removeExtras = false;
    let pv = await previewRestore({ guild, backupRow, options: { removeExtras } });
    if (!pv.ok) return interaction.editReply({ content: pv.error });
    const running = !!activeRun(guild.id);
    let msg = await interaction.editReply({
        embeds: [restorePreviewEmbed(interaction.guildId, backupRow, pv.summary, removeExtras, running ? 'A restore is already running for this server.' : '')],
        components: restoreButtons(pv.summary, removeExtras, running),
    });
    if (!msg?.awaitMessageComponent) return;

    for (;;) {
        let i;
        try {
            i = await msg.awaitMessageComponent({ filter: (b) => b.user.id === interaction.user.id && b.customId.startsWith('bkrestore_'), time: 120_000 });
        } catch {
            await interaction.editReply({ components: [] }).catch(() => {});
            return;
        }
        if (i.customId === 'bkrestore_cancel') {
            await i.update({ content: 'Restore cancelled. Nothing was changed.', embeds: [], components: [] });
            return;
        }
        if (i.customId === 'bkrestore_toggle') {
            removeExtras = !removeExtras;
            await i.deferUpdate();
            pv = await previewRestore({ guild, backupRow, options: { removeExtras } });
            if (!pv.ok) { await interaction.editReply({ content: pv.error, embeds: [], components: [] }); return; }
            msg = await interaction.editReply({ embeds: [restorePreviewEmbed(interaction.guildId, backupRow, pv.summary, removeExtras)], components: restoreButtons(pv.summary, removeExtras, false) });
            continue;
        }
        // bkrestore_go
        await i.deferUpdate();
        const started = await startRestore({
            guild, backupRow, options: { removeExtras, restoreBotConfig: true, restoreBans: false },
            by: interaction.user, source: 'command', expectedHash: pv.summary.hash, graceDays: 30,
            deps: {
                onStart: (run, summary) => void logFeatureEvent(() => (guild), 'backup.restoreStarted', () => ({
                    title: '⏳ Backup Restore Started',
                    description: `Restoring server backup **${run.backupName}** with \`/admin backup restore\`. ${removeExtras ? 'Channels and roles that are not in the backup are removed at the end.' : 'Nothing that is not in the backup is removed.'}`,
                    fields: [['Name', run.backupName], ['By', userLabel(interaction.user)], ['Create', `${summary.counts.createRoles} roles, ${summary.counts.createCategories} categories, ${summary.counts.createChannels} channels`],
                        ['Change', summary.counts.updates], ['Delete', summary.counts.deletes]],
                })),
                onFinish: (run) => {
                    const fields = [['Steps done', `${run.completed.length}/${run.total}`], ['Failed', run.failed.length], ['By', userLabel(interaction.user)]];
                    if (run.status === 'failed') {
                        void logFeatureEvent(() => (guild), 'backup.failed', () => ({
                            title: '❌ Backup Restore Stopped',
                            description: `The restore of **${run.backupName}** stopped: ${run.error || 'unknown error'}. It can be resumed from the dashboard's Backups page.`,
                            fields,
                        }));
                    } else {
                        void logFeatureEvent(() => (guild), 'backup.restored', () => ({
                            title: '♻️ Backup Restored',
                            description: `Server backup **${run.backupName}** was restored with \`/admin backup restore\`.`,
                            fields,
                        }));
                    }
                },
            },
        });
        if (!started.ok) {
            if (started.summary) {
                pv = { ...pv, summary: started.summary };
                msg = await interaction.editReply({ embeds: [restorePreviewEmbed(interaction.guildId, backupRow, started.summary, removeExtras, started.error)], components: restoreButtons(started.summary, removeExtras, false) });
                continue;
            }
            await interaction.editReply({ content: started.error, embeds: [], components: [] });
            return;
        }
        await interaction.editReply({
            content: `⏳ Restoring **${backupRow.snapshot_name}**: ${started.run.total} steps. This can take several minutes; progress shows on the dashboard's Backups page, where an interrupted restore can be resumed.`,
            embeds: [], components: [],
        });
        const run = await started.done;
        const text = `${run.status === 'failed' ? '❌ Restore stopped' : run.failed.length ? '⚠️ Restore finished with errors' : '✅ Restore finished'}: **${backupRow.snapshot_name}**, ${run.completed.length} of ${run.total} steps done`
            + (run.failed.length ? `, ${run.failed.length} failed:\n${run.failed.slice(0, 8).map(f => `• ${f.label}: ${f.error}`).join('\n')}` : '.')
            + (run.status === 'failed' ? '\nIt can be resumed from the dashboard\'s Backups page.' : '');
        // The reply token lasts 15 minutes; a long restore reports by DM instead.
        await interaction.editReply({ content: text.slice(0, 1900) }).catch(() => interaction.user.send({ content: text.slice(0, 1900) }).catch(() => {}));
        return;
    }
}

export async function handleDelete(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const backupId = interaction.options.getInteger('backup_id');

    // Name read first so the server log can say what was deleted (best-effort).
    const [[doomed]] = await pool.execute(
        `SELECT snapshot_name FROM server_backups WHERE id = ? AND guild_id = ?`,
        [backupId, guildId]
    ).catch(() => [[null]]);

    const [result] = await pool.execute(
        `DELETE FROM server_backups WHERE id = ? AND guild_id = ?`,
        [backupId, guildId]
    );

    if (result.affectedRows === 0) {
        return await interaction.editReply({
            content: `Backup with ID ${backupId} not found for this server!`
        });
    }

    await interaction.editReply({
        content: `✅ Deleted backup ID ${backupId}`
    });

    logger.info('[Backup] Deleted backup', { guildId, backupId });

    void logFeatureEvent(() => (interaction.guild), 'backup.deleted', () => ({
        title: '🗑️ Backup Deleted',
        description: `Server backup **${doomed?.snapshot_name || `#${backupId}`}** was deleted with \`/admin backup delete\`.`,
        fields: [['Name', doomed?.snapshot_name], ['Backup ID', String(backupId)], ['By', userLabel(interaction.user)]],
    }));
}

export async function handleInfo(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const backupId = interaction.options.getInteger('backup_id');

    const [backups] = await pool.execute(
        `SELECT * FROM server_backups WHERE id = ? AND guild_id = ?`,
        [backupId, guildId]
    );

    if (backups.length === 0) {
        return await interaction.editReply({
            content: `Backup with ID ${backupId} not found for this server!`
        });
    }

    const backup = backups[0];
    const snapshot = JSON.parse(backup.snapshot_json);
    const creator = await interaction.guild.members.fetch(backup.created_by_id).catch(() => null);
    const creatorName = creator ? creator.user.tag : 'Unknown User';

    // Every backup kind: weekly and dashboard (v5, under snapshot.discord) and the old command format (H-801).
    const norm = normalizeSnapshot(snapshot, { guildId });
    const channelCount = norm.channels.length;
    const originalName = snapshot.guildName || snapshot.discord?.settings?.name || 'Unknown';

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle(`📦 Backup: ${backup.snapshot_name}`)
        .setDescription(`Detailed information about backup ID ${backupId}`)
        .addFields(
            { name: 'Created By', value: creatorName, inline: true },
            { name: 'Created At', value: new Date(backup.created_at).toLocaleString(), inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Total Channels', value: `${channelCount}`, inline: true },
            { name: 'Categories', value: `${norm.categories.length}`, inline: true },
            { name: 'Roles', value: `${norm.roles.length}`, inline: true },
            { name: 'Backup Version', value: String(snapshot.version || '1.0'), inline: true },
            { name: 'Original Server Name', value: String(originalName).slice(0, 1024), inline: true }
        )
        .setFooter({ text: `Use /admin backup restore ${backupId} to see what a restore would change` })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}
