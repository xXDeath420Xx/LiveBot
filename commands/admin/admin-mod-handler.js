import {
    PermissionsBitField,
    ChannelType,
    EmbedBuilder
} from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import {
    logInfraction, sendModerationDm, protectedRoleFor, getModerationSettings, describeMinutes,
} from '../../core/moderation-manager.js';
import { MessageContextAdapter } from '../../core/message-context-adapter.js';
import { parseTimeToSeconds, parseTimeToMs as parseDuration } from '../../utils/timeParser.js';
import { isProtectedFromBanCommands } from '../../utils/owner-protection.js';
import { themeColor } from '../../core/guild-theme.js';
import {
    TEMP_BAN_LIMITS, TEMP_ROLE_LIMITS, parseModerationDuration, banReasonWithMarker, unixSeconds,
} from '../../core/timed-moderation-logic.js';
import {
    createTempBanRow, closeTempBanRow, cancelPendingBans, findTimerForBan, rescheduleTempBan,
    grantTempRole, cancelTempRole, getActiveTempRole,
} from '../../core/timed-moderation-manager.js';
import { liftMuteRole } from '../../core/mute-role.js';
import { lockChannel, unlockChannel } from '../../core/lockdown-manager.js';
import { describeStateForHumans } from '../../core/lockdown-state.js';
import { postModNote } from '../../core/mod-log-notes.js';
import { logFeatureEvent, userLabel } from '../../core/feature-log.js';
// Every reason below is read through reasonOption, so /modreason aliases expand here as they do in /ban (H-713).
import { reasonOption, expandReason } from '../../core/moderation-aliases.js';

/** quarantined_users.previous_roles → array of role ids (tolerates a malformed value). */
function parseRoleIds(value) {
    if (!value) return [];
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string' && id.length > 0) : [];
    } catch {
        return [];
    }
}

/**
 * A member holding one of the Moderation page's protected roles cannot be warned, muted, kicked or banned
 * with bot commands. Replies and returns true when the target is protected.
 */
async function refuseProtected(interaction, target, verb) {
    const role = await protectedRoleFor(interaction.guild, target);
    if (!role) return false;
    logger.info(`[Moderation] Refused to ${verb} a member with a protected role`, {
        guildId: interaction.guild.id, actor: interaction.user.id, target: target.id, roleId: role.id,
    });
    await interaction.editReply(`${target.tag ?? target.user?.tag ?? 'This member'} has the protected role "${role.name}", so they cannot be ${verb === 'ban' ? 'banned' : verb === 'kick' ? 'kicked' : verb === 'mute' ? 'muted' : 'warned'} with bot commands. The protected roles are set on the dashboard's Moderation page.`);
    return true;
}

/** "permanent" (or perm / forever / never) given as a ban duration: no timer, even with a server default. */
const PERMANENT_WORDS = /^(perm|permanent|forever|never)$/i;

export async function handleBan(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const reason = await reasonOption(interaction);
    const durationStr = interaction.options.getString('duration');
    const guild = interaction.guild;

    if (isProtectedFromBanCommands(targetUser.id)) {
        logger.warn('[Ban Command] Blocked attempt to ban protected bot owner', {
            guildId: guild.id,
            actor: interaction.user.id,
            target: targetUser.id
        });
        return interaction.editReply('This user is the bot owner / developer and cannot be banned through this bot.');
    }
    if (await refuseProtected(interaction, targetUser, 'ban')) return;

    // Optional duration → a temporary ban, lifted by jobs/timed-moderation-job.js when it runs out.
    // "permanent" overrides the server's default ban length (Moderation page).
    const explicitPermanent = !!durationStr && PERMANENT_WORDS.test(durationStr.trim());
    let duration = null;
    if (durationStr && !explicitPermanent) {
        const parsed = parseModerationDuration(durationStr, TEMP_BAN_LIMITS);
        if (!parsed.ok) return interaction.editReply(parsed.error);
        duration = parsed;
    }

    const member = await guild.members.fetch(targetUser.id).catch(() => null);

    if (member && !member.bannable) {
        return interaction.editReply('I cannot ban this user. They may have a higher role than me or I lack permissions.');
    }
    if (member && member.id === interaction.user.id) {
        return interaction.editReply('You cannot ban yourself.');
    }

    try {
        // Already banned? Then this is about the timer on that ban, not a new ban.
        let existingBan = null;
        try {
            existingBan = await guild.bans.fetch({ user: targetUser.id, force: true });
        } catch (err) {
            if (err.code !== 10026) throw err; // 10026 Unknown Ban → not banned
        }
        if (existingBan) return handleAlreadyBanned(interaction, targetUser, existingBan, duration, reason);

        // No length given for a new ban: the server's default ban length, if it set one.
        if (!duration && !explicitPermanent) {
            const { defaultBanMinutes } = await getModerationSettings(guild.id);
            if (defaultBanMinutes) duration = { ok: true, ms: defaultBanMinutes * 60_000, minutes: defaultBanMinutes };
        }

        // Any timer still pending for this user belongs to a ban that was lifted some other way; a
        // new ban must never be undone by an old timer.
        await cancelPendingBans(guild.id, targetUser.id, 'superseded by a new ban');

        let timerId = null;
        let expiresAtMs = null;
        if (duration) {
            timerId = await createTempBanRow({
                guildId: guild.id, userId: targetUser.id, moderatorId: interaction.user.id,
                reason, seconds: duration.ms / 1000,
            });
            expiresAtMs = Date.now() + duration.ms;
        }

        // Before the ban: afterwards the bot usually shares no server with them. Wording, on/off and the
        // appeal link come from the Moderation page (core/moderation-manager.js).
        await sendModerationDm(guild, targetUser, 'ban', {
            reason, expiresAtMs, durationMinutes: duration ? duration.minutes : null, permanent: !duration, moderator: interaction.user,
        });

        try {
            await guild.members.ban(targetUser, { reason: timerId ? banReasonWithMarker(reason, timerId) : reason });
        } catch (banError) {
            if (timerId) {
                await closeTempBanRow(timerId, 'ban failed to apply').catch(e =>
                    logger.error('[Ban Command] Could not close the timer of a failed ban', { timerId, error: e.message }));
            }
            throw banError;
        }
        await logInfraction(interaction, targetUser, 'Ban', reason, duration ? duration.minutes : null);

        const replyEmbed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setDescription(expiresAtMs
                ? `Successfully banned ${targetUser.tag} until <t:${unixSeconds(expiresAtMs)}:f> (<t:${unixSeconds(expiresAtMs)}:R>). They will be unbanned automatically.`
                : `Successfully banned ${targetUser.tag}.`);

        await interaction.editReply({ embeds: [replyEmbed] });

    } catch (error) {
        logger.error('[Ban Command] Error', { error: error.message, code: error.code, stack: error.stack });
        await interaction.editReply('An unexpected error occurred while trying to ban this user.');
    }
}

/**
 * `/admin mod ban` on someone who is already banned. With a duration: change the end time of the
 * running temporary ban (a permanent ban is not silently turned into a temporary one). Without:
 * make the ban permanent by stopping its timer.
 */
async function handleAlreadyBanned(interaction, targetUser, ban, duration, reason) {
    const guild = interaction.guild;
    const timer = await findTimerForBan(guild.id, targetUser.id, ban.reason);

    if (duration) {
        if (!timer) {
            return interaction.editReply(`${targetUser.tag} is already banned permanently. Unban them first if the ban should be temporary.`);
        }
        await rescheduleTempBan(timer.id, duration.ms / 1000, interaction.user.id, reason);
        const until = unixSeconds(Date.now() + duration.ms);
        const modLogChannelId = await postModNote(guild, {
            kind: 'warning',
            title: 'Temporary ban changed',
            fields: [
                { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
                { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
                { name: 'Now ends', value: `<t:${until}:f> (<t:${until}:R>)` },
                { name: 'Reason', value: reason || 'No reason provided' },
            ],
        });
        void logFeatureEvent(() => (guild), 'moderation.banTimer', () => ({
            title: '⏳ Temporary Ban Changed',
            fields: [
                ['Member', userLabel(targetUser)],
                ['Moderator', userLabel(interaction.user)],
                ['Now ends', `<t:${until}:f> (<t:${until}:R>)`],
                ['Reason', reason || 'No reason given', false],
            ],
            avoidChannelIds: [modLogChannelId],
        }));
        return interaction.editReply(`${targetUser.tag} was already temporarily banned — the ban now ends <t:${until}:f> (<t:${until}:R>).`);
    }

    const cancelled = await cancelPendingBans(guild.id, targetUser.id, `made permanent by ${interaction.user.tag}`);
    if (cancelled) {
        const modLogChannelId = await postModNote(guild, {
            kind: 'warning',
            title: 'Temporary ban made permanent',
            fields: [
                { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
                { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
                { name: 'Reason', value: reason || 'No reason provided' },
            ],
        });
        void logFeatureEvent(() => (guild), 'moderation.banTimer', () => ({
            title: '⏳ Temporary Ban Changed',
            fields: [
                ['Member', userLabel(targetUser)],
                ['Moderator', userLabel(interaction.user)],
                ['Now ends', 'Never — the ban is now permanent'],
                ['Reason', reason || 'No reason given', false],
            ],
            avoidChannelIds: [modLogChannelId],
        }));
        return interaction.editReply(`${targetUser.tag} was temporarily banned — the timer has been removed, so the ban is now permanent.`);
    }
    return interaction.editReply(`${targetUser.tag} is already banned.`);
}

export async function handleUnban(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUserId = interaction.options.getString('user-id');
    const reason = await reasonOption(interaction);

    try {
        const targetUser = await interaction.client.users.fetch(targetUserId);
        await interaction.guild.members.unban(targetUser, reason);
        // Lifted early: stop any temporary-ban timer so it does not act on a later ban.
        await cancelPendingBans(interaction.guild.id, targetUser.id, `lifted early by ${interaction.user.tag}`)
            .catch(e => logger.error('[Unban Command] Could not cancel the temporary-ban timer', { userId: targetUser.id, error: e.message }));
        await logInfraction(interaction, targetUser, 'Unban', reason);
        await sendModerationDm(interaction.guild, targetUser, 'unban', { reason, moderator: interaction.user });

        const replyEmbed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setDescription(`Successfully unbanned ${targetUser.tag}.`);

        await interaction.editReply({ embeds: [replyEmbed] });

    } catch (error) {
        logger.error('[Unban Command] Error', { error: error.message, stack: error.stack });
        if (error.code === 10026) {
            await interaction.editReply('Could not find a ban for that user ID.');
        } else {
            await interaction.editReply('An error occurred. I may be missing Ban Members permission or the User ID is invalid.');
        }
    }
}

export async function handleKick(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const reason = await reasonOption(interaction);

    if (isProtectedFromBanCommands(targetUser.id)) {
        logger.warn('[Kick Command] Blocked attempt to kick protected bot owner', {
            guildId: interaction.guild.id,
            actor: interaction.user.id,
            target: targetUser.id
        });
        return interaction.editReply('This user is the bot owner / developer and cannot be kicked through this bot.');
    }

    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
        return interaction.editReply('Could not find that user in the server.');
    }
    if (member.id === interaction.user.id) {
        return interaction.editReply('You cannot kick yourself.');
    }
    if (!member.kickable) {
        return interaction.editReply('I cannot kick this user. They may have a higher role than me or I lack permissions.');
    }
    if (await refuseProtected(interaction, member, 'kick')) return;

    try {
        await sendModerationDm(interaction.guild, targetUser, 'kick', { reason, moderator: interaction.user });

        await member.kick(reason);
        await logInfraction(interaction, targetUser, 'Kick', reason);

        const replyEmbed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setDescription(`Successfully kicked ${targetUser.tag}.`);

        await interaction.editReply({ embeds: [replyEmbed] });

    } catch (error) {
        logger.error('[Kick Command] Error', { error: error.message, stack: error.stack });
        await interaction.editReply('An unexpected error occurred while trying to kick this user.');
    }
}

export async function handleMute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const durationStr = interaction.options.getString('duration');
    let reason = await reasonOption(interaction);

    if (isProtectedFromBanCommands(targetUser.id)) {
        logger.warn('[Mute Command] Blocked attempt to mute protected bot owner', {
            guildId: interaction.guild.id,
            actor: interaction.user.id,
            target: targetUser.id
        });
        return interaction.editReply('This user is the bot owner / developer and cannot be muted through this bot.');
    }

    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
        return interaction.editReply('Could not find that user in the server.');
    }
    if (member.id === interaction.user.id) {
        return interaction.editReply('You cannot mute yourself.');
    }
    if (member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        return interaction.editReply('You cannot mute another moderator.');
    }
    if (!member.moderatable) {
        return interaction.editReply('I cannot mute this user. They may have a higher role than me.');
    }
    if (await refuseProtected(interaction, member, 'mute')) return;

    let durationMs = durationStr ? parseDuration(durationStr) : null;
    if (!durationMs) {
        // No length (or, for a prefix command, a first word that is not a length): the server's default
        // timeout length from the Moderation page. That first word then belongs to the reason.
        const { defaultMuteMinutes } = await getModerationSettings(interaction.guild.id);
        const usable = defaultMuteMinutes && (!durationStr || interaction instanceof MessageContextAdapter);
        if (!usable) {
            return interaction.editReply(durationStr
                ? 'Invalid duration format. Use formats like `10m`, `2h`, `1d`.'
                : 'Give a duration like `10m`, `2h` or `1d`, or set a default timeout length on the dashboard\'s Moderation page.');
        }
        if (durationStr) reason = [durationStr, reason].filter(Boolean).join(' ');
        // `!mute @member gh`: the word taken as a length was the reason, so expand the reason it became.
        if (durationStr) reason = await expandReason(interaction.guildId ?? interaction.guild?.id, reason);
        durationMs = defaultMuteMinutes * 60_000;
    }
    const durationText = describeMinutes(Math.floor(durationMs / 60_000)) || durationStr;

    try {
        await member.timeout(durationMs, reason);

        const durationMinutes = Math.floor(durationMs / (60 * 1000));
        await logInfraction(interaction, targetUser, 'Mute', reason, durationMinutes);

        await sendModerationDm(interaction.guild, targetUser, 'mute', {
            reason, durationMinutes, expiresAtMs: Date.now() + durationMs, moderator: interaction.user,
        });

        const replyEmbed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setDescription(`Successfully muted ${targetUser.tag} for ${durationText}. Reason: ${reason || 'No reason given'}`);

        await interaction.editReply({ embeds: [replyEmbed] });

    } catch (error) {
        logger.error('[Mute Command] Error', { error: error.message, stack: error.stack });
        await interaction.editReply('An unexpected error occurred while trying to mute this user.');
    }
}

export async function handleUnmute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const reason = await reasonOption(interaction);
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
        return interaction.editReply('Could not find that user in the server.');
    }
    // Muted = timed out now, or still holding the server's mute role on its mute timer (the timer
    // removes it within a minute of the timeout ending; core/mute-role.js).
    const timedOut = (member.communicationDisabledUntilTimestamp ?? 0) > Date.now();
    const { mutedRoleId } = await getModerationSettings(interaction.guild.id);
    const muteRoleTimer = mutedRoleId && member.roles.cache.has(mutedRoleId)
        ? await getActiveTempRole(interaction.guild.id, member.id, mutedRoleId)
        : null;
    if (!timedOut && !muteRoleTimer) {
        return interaction.editReply('This user is not currently muted.');
    }

    try {
        if (timedOut) await member.timeout(null, reason);
        // The member-update event also lifts the role; doing it here as well means it is gone by the
        // time the moderator reads the reply. A second lift finds no timer and does nothing.
        if (muteRoleTimer) await liftMuteRole(member, mutedRoleId, reason || 'Unmuted');
        await logInfraction(interaction, targetUser, 'Unmute', reason);

        await sendModerationDm(interaction.guild, targetUser, 'unmute', { reason, moderator: interaction.user });

        const replyEmbed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setDescription(`Successfully unmuted ${targetUser.tag}.`);

        await interaction.editReply({ embeds: [replyEmbed] });

    } catch (error) {
        logger.error('[Unmute Command] Error', { error: error.message, stack: error.stack });
        await interaction.editReply('An unexpected error occurred. I may be missing permissions to remove timeouts.');
    }
}

export async function handleWarn(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const reason = await reasonOption(interaction);

    if (isProtectedFromBanCommands(targetUser.id)) {
        logger.warn('[Warn Command] Blocked attempt to warn protected bot owner', {
            guildId: interaction.guild.id,
            actor: interaction.user.id,
            target: targetUser.id
        });
        return interaction.editReply('This user is the bot owner / developer and cannot be warned through this bot.');
    }

    if (targetUser.id === interaction.user.id) {
        return interaction.editReply('You cannot warn yourself.');
    }
    if (targetUser.bot) {
        return interaction.editReply('You cannot warn a bot.');
    }
    if (await refuseProtected(interaction, targetUser, 'warn')) return;

    const recorded = await logInfraction(interaction, targetUser, 'Warn', reason);
    if (!recorded) {
        return interaction.editReply('The warning could not be recorded, so it was not issued. The error has been logged — please try again.');
    }

    await sendModerationDm(interaction.guild, targetUser, 'warn', { reason, moderator: interaction.user });

    const replyEmbed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'success'))
        .setDescription(`Successfully warned ${targetUser.tag} for: ${reason}`);

    await interaction.editReply({ embeds: [replyEmbed] });
}

export async function handleClearInfractions(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const reason = await reasonOption(interaction);

    try {
        const [result] = await pool.execute(
            'DELETE FROM infractions WHERE guild_id = ? AND user_id = ?',
            [interaction.guild.id, targetUser.id]
        );

        if (result.affectedRows > 0) {
            await logInfraction(interaction, targetUser, 'ClearInfractions', reason);

            const replyEmbed = new EmbedBuilder()
                .setColor(themeColor(interaction.guildId, 'success'))
                .setDescription(`Successfully cleared all ${result.affectedRows} infractions for ${targetUser.tag}.`);

            await interaction.editReply({ embeds: [replyEmbed] });
        } else {
            await interaction.editReply(`${targetUser.tag} has no infractions to clear.`);
        }

    } catch (error) {
        logger.error('[Clear Infractions Command] Error', { error: error.message, stack: error.stack });
        await interaction.editReply('An error occurred while trying to clear this user\'s history.');
    }
}

export async function handleHistory(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');

    const [infractions] = await pool.execute(
        'SELECT id, moderator_id, type, reason, created_at FROM infractions WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 10',
        [interaction.guild.id, targetUser.id]
    );

    if (infractions.length === 0) {
        return interaction.editReply(`${targetUser.tag} has a clean record.`);
    }

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setAuthor({ name: `Moderation History for ${targetUser.tag}`, iconURL: targetUser.displayAvatarURL() })
        .setDescription(infractions.map(inf =>
            `**Case #${inf.id} | ${inf.type}** - <t:${Math.floor(new Date(inf.created_at).getTime() / 1000)}:R>\n` +
            `**Moderator:** <@${inf.moderator_id}>\n` +
            `**Reason:** ${inf.reason}`
        ).join('\n\n'));

    await interaction.editReply({ embeds: [embed] });
}

export async function handlePurge(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const amount = interaction.options.getInteger('amount');
    const filter = interaction.options.getString('filter');
    const targetUser = interaction.options.getUser('user');
    const searchText = interaction.options.getString('text');
    const channel = interaction.channel;

    if (!channel.isTextBased() || channel.isDMBased()) {
        return interaction.editReply('This command can only be used in text-based guild channels.');
    }

    if (filter === 'user' && !targetUser) {
        return interaction.editReply('You must specify a user when using the "User" filter.');
    }
    if (filter === 'text' && !searchText) {
        return interaction.editReply('You must specify text to search for when using the "Contains Text" filter.');
    }

    try {
        const fetchedMessages = await channel.messages.fetch({ limit: amount });
        let messagesToDelete;

        switch (filter) {
            case 'all':
                messagesToDelete = fetchedMessages;
                break;
            case 'user':
                messagesToDelete = fetchedMessages.filter(msg => msg.author.id === targetUser.id);
                break;
            case 'bots':
                messagesToDelete = fetchedMessages.filter(msg => msg.author.bot);
                break;
            case 'text':
                messagesToDelete = fetchedMessages.filter(msg => msg.content.toLowerCase().includes(searchText.toLowerCase()));
                break;
            case 'links':
                messagesToDelete = fetchedMessages.filter(msg => /https?:\/\/[^\s]+/g.test(msg.content));
                break;
            case 'files':
                messagesToDelete = fetchedMessages.filter(msg => msg.attachments.size > 0);
                break;
            default:
                messagesToDelete = fetchedMessages;
        }

        if (messagesToDelete.size === 0) {
            return interaction.editReply('No messages found matching the specified filter.');
        }

        const deleted = await channel.bulkDelete(messagesToDelete, true);
        void logFeatureEvent(() => (interaction.guild), 'moderation.purge', () => ({
            title: '🧹 Messages Purged',
            fields: [
                ['Channel', `<#${channel.id}>`],
                ['Deleted', String(deleted.size)],
                ['Filter', filter],
                ['Member', filter === 'user' && targetUser ? userLabel(targetUser) : null],
                ['Containing', filter === 'text' ? searchText : null],
                ['Moderator', userLabel(interaction.user)],
            ],
        }));

        const replyEmbed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setDescription(`Successfully cleaned **${deleted.size}** message(s) using the \`${filter}\` filter.`);

        await interaction.editReply({ embeds: [replyEmbed] });

    } catch (error) {
        logger.error('[Purge Command] Error', { error: error.message, stack: error.stack });
        await interaction.editReply('An error occurred. I may not have permission to delete messages, or the messages are older than 14 days.');
    }
}

export async function handleQuarantine(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const user = interaction.options.getUser('user');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    const enable = interaction.options.getBoolean('enable');
    const guildId = interaction.guild.id;

    if (!member) {
        return interaction.editReply({ content: 'That user is not in this server.' });
    }

    try {
        const [rows] = await pool.execute('SELECT is_enabled, quarantine_role_id FROM quarantine_config WHERE guild_id = ?', [guildId]);
        const quarantineConfig = rows[0];

        if (!quarantineConfig || !quarantineConfig.is_enabled) {
            return interaction.editReply({ content: 'The quarantine system is not enabled for this server.' });
        }

        const quarantineRoleId = quarantineConfig.quarantine_role_id;
        if (!quarantineRoleId) {
            return interaction.editReply({ content: 'No quarantine role is configured for this server. Please configure it in the dashboard.' });
        }

        const quarantineRole = interaction.guild.roles.cache.get(quarantineRoleId);
        if (!quarantineRole) {
            return interaction.editReply({ content: 'The configured quarantine role was not found in this server. Please check your dashboard settings.' });
        }

        const auditReason = `${enable ? 'Quarantined' : 'Released from quarantine'} by ${interaction.user.tag}`;

        if (enable) {
            // Everything except @everyone, managed roles (boosts/integrations — Discord won't let us
            // remove them) and the quarantine role itself.
            const rolesToRemove = member.roles.cache.filter(role =>
                !role.managed && role.id !== guildId && role.id !== quarantineRoleId);

            // Save the roles BEFORE stripping them, so a release (this command with enable:false, or
            // the dashboard's Release button) can give them back. If the member is already in
            // quarantine their roles are long gone, so keep what was saved then and add anything new.
            const [existing] = await pool.execute(
                'SELECT previous_roles FROM quarantined_users WHERE guild_id = ? AND user_id = ?',
                [guildId, user.id]
            );
            const savedBefore = existing.length > 0 ? parseRoleIds(existing[0].previous_roles) : [];
            const previousRoles = [...new Set([...savedBefore, ...rolesToRemove.keys()])];

            await pool.execute(
                `INSERT INTO quarantined_users (guild_id, user_id, previous_roles, reason, quarantined_by)
                 VALUES (?, ?, ?, NULL, ?)
                 ON DUPLICATE KEY UPDATE previous_roles = VALUES(previous_roles), quarantined_by = VALUES(quarantined_by)`,
                [guildId, user.id, JSON.stringify(previousRoles), interaction.user.id]
            );

            if (rolesToRemove.size > 0) {
                await member.roles.remove(rolesToRemove, auditReason);
            }
            await member.roles.add(quarantineRole, auditReason);
            void logFeatureEvent(() => (interaction.guild), 'moderation.quarantine', () => ({
                title: '🚧 Member Quarantined',
                fields: [
                    ['Member', userLabel(user)],
                    ['Moderator', userLabel(interaction.user)],
                    ['Quarantine role', `<@&${quarantineRoleId}>`],
                    ['Roles saved', String(previousRoles.length)],
                ],
            }));
            await interaction.editReply({
                content: `${user.tag} has been quarantined. ${previousRoles.length} role(s) were saved and will be given back on release.`
            });
        } else {
            const [rows] = await pool.execute(
                'SELECT previous_roles FROM quarantined_users WHERE guild_id = ? AND user_id = ?',
                [guildId, user.id]
            );
            const savedRoleIds = rows.length > 0 ? parseRoleIds(rows[0].previous_roles) : [];

            // Only roles that still exist and that the bot is allowed to hand out.
            const restorable = savedRoleIds
                .map(id => interaction.guild.roles.cache.get(id))
                .filter(role => role && !role.managed && role.id !== guildId && role.id !== quarantineRoleId && role.editable);

            if (restorable.length > 0) {
                await member.roles.add(restorable, auditReason);
            }
            if (member.roles.cache.has(quarantineRoleId)) {
                await member.roles.remove(quarantineRole, auditReason);
            }
            await pool.execute(
                'DELETE FROM quarantined_users WHERE guild_id = ? AND user_id = ?',
                [guildId, user.id]
            );

            const notRestored = savedRoleIds.length - restorable.length;
            void logFeatureEvent(() => (interaction.guild), 'moderation.release', () => ({
                title: '🔓 Released From Quarantine',
                fields: [
                    ['Member', userLabel(user)],
                    ['Moderator', userLabel(interaction.user)],
                    ['Roles restored', rows.length === 0 ? 'None on record' : String(restorable.length)],
                    ['Not restored', notRestored > 0 ? String(notRestored) : null],
                ],
            }));
            let content = `${user.tag} has been released from quarantine.`;
            if (rows.length === 0) {
                content += ' No saved roles were on record for them, so none were given back.';
            } else {
                content += ` ${restorable.length} role(s) restored.`;
                if (notRestored > 0) {
                    content += ` ${notRestored} could not be restored (deleted, managed, or above my highest role).`;
                }
            }
            await interaction.editReply({ content });
        }
    } catch (error) {
        logger.error('[Quarantine Command] Error', {
            guildId, userId: user.id, enable, code: error.code, error: error.message, stack: error.stack
        });
        await interaction.editReply({ content: 'An error occurred while trying to toggle quarantine for the user.' });
    }
}

export async function handleSlowmode(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const durationStr = interaction.options.getString('duration').toLowerCase();
    const reason = await reasonOption(interaction) || 'No reason provided.';
    const channel = interaction.channel;

    if (channel.type !== ChannelType.GuildText) {
        return interaction.editReply({ content: 'This command can only be used in text channels.' });
    }

    const seconds = parseTimeToSeconds(durationStr);

    if (seconds === null) {
        return interaction.editReply({ content: 'Invalid duration format. Use formats like `10s`, `5m`, or `off`.' });
    }

    if (seconds > 21600) {
        return interaction.editReply({ content: 'The maximum slowmode duration is 6 hours (6h).' });
    }

    try {
        await channel.setRateLimitPerUser(seconds, reason);
        void logFeatureEvent(() => (interaction.guild), () => (seconds > 0 ? 'moderation.slowmodeOn' : 'moderation.slowmodeOff'), () => ({
            title: seconds > 0 ? '🐢 Slowmode Enabled' : '🐇 Slowmode Disabled',
            fields: [
                ['Channel', `<#${channel.id}>`],
                ['Delay', seconds > 0 ? durationStr : null],
                ['Moderator', userLabel(interaction.user)],
                ['Reason', reason, false],
            ],
        }));

        const embed = new EmbedBuilder()
            .setColor(seconds > 0 ? '#E67E22' : '#2ECC71');

        if (seconds > 0) {
            embed.setTitle('Channel Slowmode Enabled')
                .setDescription(`Users must now wait **${durationStr}** between messages.`);
        } else {
            embed.setTitle('Channel Slowmode Disabled')
                .setDescription('The slowmode cooldown has been removed.');
        }

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        logger.error('[Slowmode Command] Error', { error: error.message, stack: error.stack });
        await interaction.editReply({ content: 'Failed to set the slowmode. Do I have the Manage Channels permission?' });
    }
}

export async function handleLock(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.channel;
    const givenReason = await reasonOption(interaction);
    const reason = givenReason || 'No reason provided.';

    if (channel.type !== ChannelType.GuildText) {
        return interaction.editReply({ content: 'This command can only be used in text channels.' });
    }

    try {
        // Records the channel's current @everyone Send Messages state BEFORE locking, so unlock can
        // restore exactly that (core/lockdown-manager.js).
        const result = await lockChannel(channel, interaction.user, givenReason);
        if (result.status === 'already_locked') {
            const at = Math.floor(new Date(result.row.locked_at).getTime() / 1000);
            return interaction.editReply({
                content: `This channel is already locked (by <@${result.row.locked_by}>, <t:${at}:R>). Use \`/admin mod unlock\` to reopen it.`,
            });
        }
        if (result.status === 'already_denied') {
            return interaction.editReply({ content: '@everyone already cannot send messages in this channel, so there is nothing to lock.' });
        }

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'danger'))
            .setTitle('Channel Locked')
            .setDescription('This channel has been locked by a moderator.')
            .addFields({ name: 'Reason', value: reason })
            .setTimestamp();

        await channel.send({ embeds: [embed] }).catch(e => logger.warn('[Lock Command] Could not post the lock notice', { channelId: channel.id, error: e.message }));
        await interaction.editReply({
            content: `Channel locked successfully. Unlocking will put @everyone's Send Messages back to: **${describeStateForHumans(result.previous)}**.`,
        });

    } catch (error) {
        logger.error('[Lock Command] Error', { guildId: interaction.guildId, channelId: channel.id, code: error.code, error: error.message, stack: error.stack });
        await interaction.editReply({ content: 'Failed to lock the channel. Do I have the Manage Channels and Manage Roles permissions here?' });
    }
}

export async function handleUnlock(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.channel;

    if (channel.type !== ChannelType.GuildText) {
        return interaction.editReply({ content: 'This command can only be used in text channels.' });
    }

    try {
        // Restores the state recorded by the lock; with no record, falls back to neutral as before.
        const result = await unlockChannel(channel, interaction.user);

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setTitle('Channel Unlocked')
            .setDescription('This channel has been unlocked. You may now send messages.')
            .setTimestamp();

        await channel.send({ embeds: [embed] }).catch(e => logger.warn('[Unlock Command] Could not post the unlock notice', { channelId: channel.id, error: e.message }));
        await interaction.editReply({
            content: result.hadRecord
                ? `Channel unlocked — @everyone's Send Messages is back to how it was before the lock: **${describeStateForHumans(result.restored)}**.`
                : "Channel unlocked — there was no record of how it was before, so @everyone's Send Messages was reset to inherit (not set).",
        });

    } catch (error) {
        logger.error('[Unlock Command] Error', { guildId: interaction.guildId, channelId: channel.id, code: error.code, error: error.message, stack: error.stack });
        await interaction.editReply({ content: 'Failed to unlock the channel. Do I have the Manage Channels and Manage Roles permissions here?' });
    }
}

/**
 * `/admin mod temprole` — give a role that is taken away again after a set time
 * (temp_roles; removed by jobs/timed-moderation-job.js). `duration: off` stops a running timer
 * and leaves the role in place.
 */
export async function handleTempRole(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const targetUser = interaction.options.getUser('user');
    const optionRole = interaction.options.getRole('role');
    const durationStr = interaction.options.getString('duration');
    const reason = await reasonOption(interaction) || null;

    // Role hand-outs are gated on Manage Roles and the hierarchy, like Discord's own role editor:
    // nobody can use the bot to give a role they could not give themselves.
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageRoles)) {
        return interaction.editReply('You need the **Manage Roles** permission to give temporary roles.');
    }
    const role = guild.roles.cache.get(optionRole.id);
    if (!role || role.id === guild.id || role.managed) {
        return interaction.editReply('That role cannot be given out (it is @everyone or managed by an integration).');
    }
    const actor = interaction.member;
    if (guild.ownerId !== interaction.user.id && actor?.roles?.highest && actor.roles.highest.comparePositionTo(role) <= 0) {
        return interaction.editReply(`You can only give roles below your own highest role, and **${role.name}** is not.`);
    }
    if (!role.editable) {
        return interaction.editReply(`I can't manage **${role.name}** — it is at or above my highest role (or I lack Manage Roles).`);
    }

    const member = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!member) return interaction.editReply('That user is not in this server.');

    if (/^(off|cancel|stop|none|permanent)$/i.test(String(durationStr).trim())) {
        const cancelled = await cancelTempRole(guild.id, member.id, role.id, `timer cancelled by ${interaction.user.tag}`);
        if (!cancelled) return interaction.editReply(`${member.user.tag} has no timer running for **${role.name}**.`);
        const modLogChannelId = await postModNote(guild, {
            kind: 'role_add',
            title: 'Temporary role made permanent',
            fields: [
                { name: 'Member', value: `${member.user.tag} (${member.id})`, inline: true },
                { name: 'Role', value: `${role.name} (${role.id})`, inline: true },
                { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
            ],
        });
        void logFeatureEvent(() => (guild), 'moderation.tempRoleEnded', () => ({
            title: '⌛ Temporary Role Made Permanent',
            fields: [
                ['Member', userLabel(member)],
                ['Role', `<@&${role.id}>`],
                ['Moderator', userLabel(interaction.user)],
                ['How', 'Cancelled — the timer was stopped and they keep the role'],
            ],
            avoidChannelIds: [modLogChannelId],
        }));
        return interaction.editReply(`Timer stopped — ${member.user.tag} keeps **${role.name}**.`);
    }

    const parsed = parseModerationDuration(durationStr, TEMP_ROLE_LIMITS);
    if (!parsed.ok) return interaction.editReply(`${parsed.error} (Use \`off\` to stop a running timer.)`);

    try {
        const result = await grantTempRole({ member, role, moderator: interaction.user, seconds: parsed.ms / 1000, reason });
        if (!result.ok) return interaction.editReply(result.error);

        const until = unixSeconds(Date.now() + parsed.ms);
        const modLogChannelId = await postModNote(guild, {
            kind: 'role_add',
            title: result.extended ? 'Temporary role timer reset' : 'Temporary role given',
            fields: [
                { name: 'Member', value: `${member.user.tag} (${member.id})`, inline: true },
                { name: 'Role', value: `${role.name} (${role.id})`, inline: true },
                { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
                { name: 'Removed', value: `<t:${until}:f> (<t:${until}:R>)` },
                { name: 'Reason', value: reason || 'No reason provided' },
            ],
        });
        void logFeatureEvent(() => (guild), 'moderation.tempRole', () => ({
            title: '⏳ Temporary Role Given',
            fields: [
                ['Member', userLabel(member)],
                ['Role', `<@&${role.id}>`],
                ['Moderator', userLabel(interaction.user)],
                ['Removed', `<t:${until}:f> (<t:${until}:R>)`],
                ['Timer', result.extended ? 'Reset — they already had it on a timer' : null],
                ['Reason', reason || 'No reason given', false],
            ],
            avoidChannelIds: [modLogChannelId],
        }));

        const replyEmbed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setDescription(result.extended
                ? `${member.user.tag} already had **${role.name}** on a timer — it now ends <t:${until}:f> (<t:${until}:R>).`
                : `Gave **${role.name}** to ${member.user.tag}. It will be removed <t:${until}:f> (<t:${until}:R>).`);
        await interaction.editReply({ embeds: [replyEmbed] });
    } catch (error) {
        logger.error('[TempRole Command] Error', { guildId: guild.id, userId: member.id, roleId: role.id, code: error.code, error: error.message, stack: error.stack });
        await interaction.editReply('Could not give the role. Check that I have Manage Roles and that the role is below my highest role.');
    }
}

export async function handleAnnounce(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const channel = interaction.options.getChannel('channel');
    const message = interaction.options.getString('message');
    const title = interaction.options.getString('title');
    let color = interaction.options.getString('color');
    const mentionRole = interaction.options.getRole('mention');

    if (color && !/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color)) {
        return interaction.editReply({ content: 'Invalid color format. Please use a valid hex color code (e.g., #3498DB).' });
    }

    try {
        const announcementContent = {
            content: mentionRole ? `${mentionRole}` : undefined,
        };

        if (title) {
            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(message)
                .setColor(color || '#5865F2')
                .setTimestamp();

            announcementContent.embeds = [embed];
        } else {
            announcementContent.content = `${announcementContent.content || ''} ${message}`.trim();
        }

        await channel.send(announcementContent);

        await interaction.editReply(`Announcement successfully sent to ${channel}.`);

    } catch (error) {
        logger.error('[Announce Command] Error', { error: error.message, stack: error.stack });
        await interaction.editReply('Failed to send the announcement. Please check my permissions for that channel.');
    }
}
