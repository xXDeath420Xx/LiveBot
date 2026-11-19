import {
    SlashCommandBuilder,
    EmbedBuilder,
    UserFlags,
    ApplicationIntegrationType,
    InteractionContextType,
} from 'discord.js';
import { getFlagHistory, getFirstFlaggedAt, getLastSeenCleanAt, FLAG_BITS } from '../../core/user-flag-observations.js';
import logger from '../../utils/logger.js';
import { displayNameFor } from '../../utils/display-name.js';
import { themeColor } from '../../core/guild-theme.js';

export default {
    category: 'info',
    data: new SlashCommandBuilder()
        .setName('user')
        .setDescription('User profiles, avatars & emoji statistics')
        // User-install enabled: /user profile info and /user profile avatar work
        // in any server (even one CertiFried isn't in), in DMs, and in group DMs.
        // Emoji-stats subcommands silently require a guild context themselves.
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)

        // ── Profile Group ──
        .addSubcommandGroup(group =>
            group.setName('profile')
                .setDescription('User profile information')
                .addSubcommand(sub =>
                    sub.setName('avatar')
                        .setDescription('Display a user\'s avatar')
                        .addUserOption(opt => opt.setName('user').setDescription('The user whose avatar to display (defaults to you)')))
                .addSubcommand(sub =>
                    sub.setName('info')
                        .setDescription('Display information about a user')
                        .addUserOption(opt => opt.setName('user').setDescription('The user to get info about (defaults to you)'))))

        // ── Emoji Stats Group ──
        .addSubcommandGroup(group =>
            group.setName('emojistats')
                .setDescription('View emoji usage statistics')
                .addSubcommand(sub =>
                    sub.setName('top')
                        .setDescription('View most used emojis')
                        .addIntegerOption(opt => opt.setName('days').setDescription('Number of days to analyze (default: 7)').setMinValue(1).setMaxValue(90))
                        .addBooleanOption(opt => opt.setName('custom').setDescription('Show only custom server emojis')))
                .addSubcommand(sub =>
                    sub.setName('user')
                        .setDescription('View a user\'s most used emojis')
                        .addUserOption(opt => opt.setName('target').setDescription('User to check (default: you)'))
                        .addIntegerOption(opt => opt.setName('days').setDescription('Number of days to analyze (default: 30)').setMinValue(1).setMaxValue(90)))
                .addSubcommand(sub =>
                    sub.setName('topusers')
                        .setDescription('View users who use emojis the most')
                        .addIntegerOption(opt => opt.setName('days').setDescription('Number of days to analyze (default: 7)').setMinValue(1).setMaxValue(30)))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        try {
            if (group === 'profile') {
                if (subcommand === 'avatar') {
                    return await handleAvatar(interaction);
                } else if (subcommand === 'info') {
                    return await handleUserInfo(interaction);
                }
            } else if (group === 'emojistats') {
                return await handleEmojiStats(interaction, subcommand);
            }
        } catch (error) {
            logger.error('[User Command] Error:', { error: error.message, group, subcommand, stack: error.stack });

            const reply = { content: `Error: ${error.message}`, ephemeral: true };
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(reply);
            } else {
                await interaction.reply(reply);
            }
        }
    }
};

// ── Avatar Handler ──
async function handleAvatar(interaction) {
    const user = interaction.options.getUser('user') || interaction.user;

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle(`${user.tag}'s Avatar`)
        .setImage(user.displayAvatarURL({ size: 1024, dynamic: true }))
        .setDescription(`[Download PNG](${user.displayAvatarURL({ extension: 'png', size: 1024 })}) | [Download JPG](${user.displayAvatarURL({ extension: 'jpg', size: 1024 })}) | [Download WEBP](${user.displayAvatarURL({ extension: 'webp', size: 1024 })})`)
        .setFooter({ text: `Requested by ${interaction.user.tag}` })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ── User Info Handler ──
export async function handleUserInfo(interaction) {
    await interaction.deferReply();

    const rawTarget = interaction.options.getUser('user') || interaction.user;
    // Force-refetch so `collectibles` (nameplate etc.) is populated from the live
    // user object — Discord does not include it in message or interaction payloads.
    const targetUser = await interaction.client.users.fetch(rawTarget.id, { force: true }).catch(() => rawTarget);

    // In a user-install DM context there's no `interaction.guild`; skip the
    // guild-local member lookup and go straight to the cross-guild fallback.
    let member = interaction.guild
        ? await interaction.guild.members.fetch(targetUser.id).catch(() => null)
        : null;
    let crossGuild = null;

    // If not in this guild, search all guilds the bot shares with this user
    if (!member) {
        for (const [, guild] of interaction.client.guilds.cache) {
            if (interaction.guild && guild.id === interaction.guild.id) continue;
            const found = await guild.members.fetch(targetUser.id).catch(() => null);
            if (found) {
                member = found;
                crossGuild = guild;
                break;
            }
        }
    }

    // If found as a member somewhere, show full card
    if (member) {
        const roles = member.roles.cache
            .sort((a, b) => b.position - a.position)
            .map(role => role.toString())
            .slice(0, -1);

        const embed = new EmbedBuilder()
            .setColor(member.displayHexColor || '#95A5A6')
            .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
            .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
            .addFields(
                { name: 'User', value: `${member.user} (${member.id})`, inline: false },
                { name: 'Nickname', value: member.nickname || 'None', inline: true },
                { name: 'Bot Account', value: member.user.bot ? 'Yes' : 'No', inline: true },
                { name: 'Joined Server', value: `<t:${Math.floor((member.joinedTimestamp || 0) / 1000)}:R>`, inline: true },
                { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
                { name: `Roles [${roles.length}]`, value: roles.length > 0 ? roles.join(', ').substring(0, 1024) : 'None', inline: false }
            )
            .setFooter({ text: crossGuild ? `Via ${crossGuild.name} • Requested by ${interaction.user.tag}` : `Requested by ${interaction.user.tag}` })
            .setTimestamp();

        if (crossGuild) {
            embed.addFields({ name: 'Shared Server', value: crossGuild.name, inline: true });
        }

        if (member.presence) {
            const statusEmojis = {
                online: '🟢 Online', idle: '🟡 Idle',
                dnd: '🔴 Do Not Disturb', offline: '⚫ Offline'
            };
            embed.addFields({ name: 'Status', value: statusEmojis[member.presence.status] || 'Unknown', inline: true });
        }

        const memberFlagsLine = buildMemberFlagsLine(member);
        if (memberFlagsLine) {
            embed.addFields({ name: 'Member flags', value: memberFlagsLine, inline: false });
        }

        const flagField = await buildFlagHistoryField(member.user);
        if (flagField) embed.addFields(flagField);

        const nameplateField = buildNameplateField(member.user);
        if (nameplateField) embed.addFields(nameplateField);

        return interaction.editReply({ embeds: [embed] });
    }

    // Not in any shared guild — show basic user info from the resolved User object
    const embed = new EmbedBuilder()
        .setColor('#95A5A6')
        .setAuthor({ name: targetUser.tag, iconURL: targetUser.displayAvatarURL() })
        .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
        .addFields(
            { name: 'User', value: `${targetUser} (${targetUser.id})`, inline: false },
            { name: 'Bot Account', value: targetUser.bot ? 'Yes' : 'No', inline: true },
            { name: 'Account Created', value: `<t:${Math.floor(targetUser.createdTimestamp / 1000)}:R>`, inline: true }
        )
        .setFooter({ text: `No shared servers • Requested by ${interaction.user.tag}` })
        .setTimestamp();

    const flagField = await buildFlagHistoryField(targetUser);
    if (flagField) embed.addFields(flagField);

    const nameplateField = buildNameplateField(targetUser);
    if (nameplateField) embed.addFields(nameplateField);

    return interaction.editReply({ embeds: [embed] });
}

/**
 * Build a one-line summary of GuildMemberFlags that mods actually care about.
 * Discord added several bits in 2024-2026 covering onboarding progress, raid
 * suspicion, and manual verification bypass — surfacing them here means a mod
 * can look up a suspicious member without opening a separate audit tool.
 *
 * Flag bits (from discord.js's GuildMemberFlagsBitField):
 *   DidRejoin                      1 << 0   previously left and came back
 *   CompletedOnboarding            1 << 1   finished Discord's onboarding
 *   BypassesVerification           1 << 2   admin manually bypassed verification
 *   StartedOnboarding              1 << 3   began onboarding but didn't finish
 *   IsGuest                        1 << 4   joined via a guest invite
 *   StartedHomeActions             1 << 5   started tasks in the server guide
 *   CompletedHomeActions           1 << 6   finished every server-guide task
 *   AutomodQuarantinedUsername     1 << 7   automod quarantined their name
 *   DmSettingsUpsellAcknowledged   1 << 9   dismissed a DM-settings upsell
 */
function buildMemberFlagsLine(member) {
    const bits = member?.flags?.bitfield;
    if (bits == null || bits === 0) return null;
    const labels = [];
    const check = (bit, label) => { if ((bits & bit) === bit) labels.push(label); };
    check(1 << 0, '🔁 Did rejoin');
    check(1 << 1, '✅ Completed onboarding');
    check(1 << 2, '⚡ Bypasses verification');
    check(1 << 3, '🏁 Started onboarding');
    check(1 << 4, '👤 Guest');
    check(1 << 5, '📘 Started home actions');
    check(1 << 6, '📗 Completed home actions');
    check(1 << 7, '⚠️ AutoMod-quarantined username');
    return labels.length ? labels.join(' · ') : null;
}

/**
 * Build a "Nameplate" field from the user's collectibles bundle. Discord
 * returns `collectibles.nameplate = { sku_id, asset, label, palette }` on
 * accounts that have equipped one; non-equipped accounts return no key at
 * all. The nameplate asset is a static image on Discord's CDN keyed by its
 * `asset` prefix — hotlinked read-only, never written back.
 *
 * Returns null when the user has no equipped nameplate so callers can skip
 * the field cleanly.
 */
function buildNameplateField(user) {
    // discord.js exposes this as `user.collectibles` on recent builds; older
    // builds leave the raw payload reachable via internal getter. Guard both.
    const col = user?.collectibles ?? user?._rawData?.collectibles ?? null;
    const plate = col?.nameplate;
    if (!plate || !plate.asset) return null;

    const label = plate.label ? String(plate.label) : null;
    const palette = plate.palette ? String(plate.palette) : null;
    const sku = plate.sku_id || plate.skuId || null;

    const parts = [];
    if (label) parts.push(`**${label}**`);
    if (palette) parts.push(`Palette: \`${palette}\``);
    if (sku) parts.push(`SKU: \`${sku}\``);
    parts.push(`Asset: \`${plate.asset}\``);

    return { name: 'Nameplate', value: parts.join(' · '), inline: false };
}

/** Build the "Discord flag history" field for /user profile info. Returns null when there's
 *  nothing to say (no observations and no current flag bits). */
async function buildFlagHistoryField(user) {
    // Decode current flag bits to readable names.
    const currentBits = BigInt(user.flags?.bitfield ?? 0);
    const flagNames = [];
    if (user.flags) {
        for (const [name, bit] of Object.entries(UserFlags.Flags || {})) {
            if (typeof bit !== 'number' && typeof bit !== 'bigint') continue;
            if (currentBits & BigInt(bit)) flagNames.push(name);
        }
    }

    // Our best "when first flagged" bound comes from observing SPAMMER specifically.
    let firstFlagged = null, lastClean = null, history = [];
    try {
        [firstFlagged, lastClean, history] = await Promise.all([
            getFirstFlaggedAt(user.id, FLAG_BITS.SPAMMER),
            getLastSeenCleanAt(user.id, FLAG_BITS.SPAMMER),
            getFlagHistory(user.id),
        ]);
    } catch { /* fall through — show whatever we have */ }

    const lines = [];
    if (flagNames.length) {
        lines.push(`**Current:** ${flagNames.join(', ')}`);
    }
    if (firstFlagged) {
        const ts = Math.floor(new Date(firstFlagged).getTime() / 1000);
        lines.push(`**Spammer flag first observed:** <t:${ts}:F> (<t:${ts}:R>)`);
    }
    if (lastClean && firstFlagged && new Date(lastClean) < new Date(firstFlagged)) {
        const ts = Math.floor(new Date(lastClean).getTime() / 1000);
        lines.push(`**Last observed clean:** <t:${ts}:F> — Discord flagged them in that window`);
    }
    if (!lines.length && history.length) {
        lines.push(`**Observations:** ${history.length} tuple(s) recorded, no SPAMMER bit`);
    }
    if (!lines.length) return null;
    return { name: 'Discord flag history', value: lines.join('\n'), inline: false };
}

// ── Emoji Stats Handler ──
async function handleEmojiStats(interaction, subcommand) {
    const emojiStatsManager = interaction.client.emojiStatsManager;

    if (!emojiStatsManager) {
        return interaction.reply({ content: 'Emoji statistics system is not available.', ephemeral: true });
    }

    // Emoji stats are per-guild — bail out when invoked user-install style
    // in a DM/group DM where there's no guild to report on.
    if (!interaction.guild) {
        return interaction.reply({
            content: 'Emoji stats are server-specific. Run this inside a server where CertiFried is installed.',
            ephemeral: true,
        });
    }

    await interaction.deferReply();

    if (subcommand === 'top') {
        const days = interaction.options.getInteger('days') || 7;
        const customOnly = interaction.options.getBoolean('custom') || false;

        const topEmojis = await emojiStatsManager.getTopEmojis(interaction.guild.id, days, 15, customOnly);

        if (topEmojis.length === 0) {
            return interaction.editReply({
                content: customOnly ? 'No custom emoji usage data available yet.' : 'No emoji usage data available yet.'
            });
        }

        const embed = new EmbedBuilder()
            .setColor('#FEE75C')
            .setTitle(`${customOnly ? '🎨 Top Custom Emojis' : '😀 Top Emojis'} (Last ${days} Days)`)
            .setTimestamp();

        const emojiList = topEmojis.map((emoji, index) => {
            const emojiDisplay = emojiStatsManager.formatEmoji(emoji);
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**${index + 1}.**`;
            return `${medal} ${emojiDisplay} \`${emoji.emoji_name}\`\n└ ${emoji.total_uses.toLocaleString()} uses | ${emoji.unique_users} ${emoji.unique_users === 1 ? 'user' : 'users'}`;
        }).join('\n\n');

        embed.setDescription(emojiList);
        return interaction.editReply({ embeds: [embed] });

    } else if (subcommand === 'user') {
        const targetUser = interaction.options.getUser('target') || interaction.user;
        const days = interaction.options.getInteger('days') || 30;
        const isOwnProfile = targetUser.id === interaction.user.id;

        const topEmojis = await emojiStatsManager.getUserTopEmojis(interaction.guild.id, targetUser.id, days, 10);

        if (topEmojis.length === 0) {
            return interaction.editReply({
                content: `${isOwnProfile ? 'You haven\'t' : `${displayNameFor(targetUser, interaction.guild)} hasn't`} used any emojis in the last ${days} days.`
            });
        }

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle(`${isOwnProfile ? 'Your' : `${displayNameFor(targetUser, interaction.guild)}'s`} Favorite Emojis`)
            .setDescription(`Most used emojis in the last ${days} days`)
            .setThumbnail(targetUser.displayAvatarURL())
            .setTimestamp();

        const emojiList = topEmojis.map((emoji, index) => {
            const emojiDisplay = emojiStatsManager.formatEmoji(emoji);
            return `**${index + 1}.** ${emojiDisplay} \`${emoji.emoji_name}\` - ${emoji.total_uses.toLocaleString()} ${emoji.total_uses === 1 ? 'use' : 'uses'}`;
        }).join('\n');

        embed.addFields({ name: 'Top Emojis', value: emojiList });
        return interaction.editReply({ embeds: [embed] });

    } else if (subcommand === 'topusers') {
        const days = interaction.options.getInteger('days') || 7;

        const topUsers = await emojiStatsManager.getTopEmojiUsers(interaction.guild.id, days, 10);

        if (topUsers.length === 0) {
            return interaction.editReply({ content: 'No emoji usage data available yet.' });
        }

        const embed = new EmbedBuilder()
            .setColor('#EB459E')
            .setTitle(`👥 Top Emoji Users (Last ${days} Days)`)
            .setDescription('Users who love emojis the most!')
            .setTimestamp();

        const userList = await Promise.all(
            topUsers.map(async (userData, index) => {
                const user = await interaction.client.users.fetch(userData.user_id).catch(() => null);
                const username = displayNameFor(user, interaction.guild);
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**${index + 1}.**`;
                return `${medal} **${username}**\n└ ${userData.total_emojis.toLocaleString()} emojis | ${userData.unique_emojis} different emojis`;
            })
        );

        embed.setDescription(userList.join('\n\n'));
        return interaction.editReply({ embeds: [embed] });
    }
}
