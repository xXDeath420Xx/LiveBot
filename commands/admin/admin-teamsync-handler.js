import { EmbedBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import { syncAllTeams } from '../../jobs/team-sync-scheduler.js';
import {
    syncTwitchTeam, addTeamExclusion, removeTeamExclusion, listTeamExclusions,
} from '../../core/team-sync.js';
import { normaliseLogin } from '../../core/team-sync-exclusions.js';
import { getTwitchUser } from '../../utils/platforms/twitch.js';
import pool from '../../utils/db.js';
import { themeColor } from '../../core/guild-theme.js';

export async function handleAutocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'streamer') return autocompleteStreamer(interaction, String(focused.value || '').toLowerCase());

    const focusedValue = String(focused.value || '').toLowerCase();

    try {
        const [teams] = await pool.execute(
            'SELECT id, team_name FROM twitch_teams WHERE team_name LIKE ? LIMIT 25',
            [`%${focusedValue}%`]
        );

        await interaction.respond(
            teams.map(team => ({
                name: team.team_name,
                value: team.id.toString()
            }))
        );
    } catch (error) {
        logger.error('[TeamSync Command] Autocomplete error:', { error: error.message });
        await interaction.respond([]);
    }
}

export async function handleAll(interaction) {
    await interaction.deferReply();

    try {
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'warning'))
            .setTitle('Team Sync In Progress')
            .setDescription('Synchronizing all teams across all bots...\nThis may take a moment.')
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        const result = await syncAllTeams();

        const resultEmbed = new EmbedBuilder()
            .setColor(result.success ? '#00FF00' : '#FF0000')
            .setTitle(result.success ? 'Team Sync Complete' : 'Team Sync Failed')
            .setDescription(result.message)
            .setTimestamp();

        if (result.results && result.results.length > 0) {
            const successBots = result.results.filter(r => r.success).map(r => r.botId);
            const failedBots = result.results.filter(r => !r.success);

            if (successBots.length > 0) {
                resultEmbed.addFields({
                    name: 'Successfully Synced',
                    value: successBots.join(', ') || 'None',
                    inline: true
                });
            }

            if (failedBots.length > 0) {
                resultEmbed.addFields({
                    name: 'Failed',
                    value: failedBots.map(r => `${r.botId}: ${r.error}`).join('\n') || 'None',
                    inline: true
                });
            }
        }

        await interaction.editReply({ embeds: [resultEmbed] });

    } catch (error) {
        logger.error('[TeamSync Command] Error during sync all:', { error: error.message });

        const errorEmbed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'danger'))
            .setTitle('Team Sync Error')
            .setDescription(`An error occurred: ${error.message}`)
            .setTimestamp();

        await interaction.editReply({ embeds: [errorEmbed] });
    }
}

export async function handleTeam(interaction) {
    await interaction.deferReply();

    const teamIdOrName = interaction.options.getString('team_name');

    try {
        let teamId = parseInt(teamIdOrName);

        if (isNaN(teamId)) {
            const [teams] = await pool.execute(
                'SELECT id FROM twitch_teams WHERE team_name = ?',
                [teamIdOrName]
            );
            if (teams.length === 0) {
                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setColor(themeColor(interaction.guildId, 'danger'))
                        .setTitle('Team Not Found')
                        .setDescription(`No team found with name: ${teamIdOrName}`)
                    ]
                });
                return;
            }
            teamId = teams[0].id;
        }

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'warning'))
            .setTitle('Syncing Team')
            .setDescription(`Synchronizing team ID ${teamId}...`)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        const result = await syncTwitchTeam(teamId, interaction.client);

        const resultEmbed = new EmbedBuilder()
            .setColor(result.success ? '#00FF00' : '#FF0000')
            .setTitle(result.success ? 'Team Sync Complete' : 'Team Sync Failed')
            .setDescription(result.message)
            .setTimestamp();

        await interaction.editReply({ embeds: [resultEmbed] });

    } catch (error) {
        logger.error('[TeamSync Command] Error syncing team:', { error: error.message });

        const errorEmbed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'danger'))
            .setTitle('Team Sync Error')
            .setDescription(`An error occurred: ${error.message}`)
            .setTimestamp();

        await interaction.editReply({ embeds: [errorEmbed] });
    }
}

export async function handleStatus(interaction) {
    try {
        const [teams] = await pool.execute('SELECT COUNT(*) as count FROM twitch_teams');
        const [members] = await pool.execute(`
            SELECT COUNT(DISTINCT s.streamer_id) as count
            FROM subscriptions sub
            JOIN streamers s ON sub.streamer_id = s.streamer_id
            WHERE sub.team_subscription_id IS NOT NULL
        `);

        const now = new Date();
        const nextRun = new Date(now);
        nextRun.setMinutes(0, 0, 0);
        nextRun.setHours(nextRun.getHours() + 1);

        let botCount = 1;
        if (global.botManager?.clients) {
            botCount = global.botManager.clients.size;
        }

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle('Team Sync Status')
            .addFields(
                { name: 'Tracked Teams', value: teams[0].count.toString(), inline: true },
                { name: 'Team Members', value: members[0].count.toString(), inline: true },
                { name: 'Active Bots', value: botCount.toString(), inline: true },
                { name: 'Schedule', value: 'Every hour at :00', inline: true },
                { name: 'Next Run', value: `<t:${Math.floor(nextRun.getTime() / 1000)}:R>`, inline: true }
            )
            .setFooter({ text: 'Use /admin teamsync all to manually trigger a sync' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });

    } catch (error) {
        logger.error('[TeamSync Command] Error getting status:', { error: error.message });
        await interaction.reply({
            content: `Error getting status: ${error.message}`,
            ephemeral: true
        });
    }
}

/**
 * `streamer` autocomplete: for `exclude`, the team members this server currently tracks; for
 * `include`, this server's own exclusions.
 */
async function autocompleteStreamer(interaction, typed) {
    try {
        const sub = interaction.options.getSubcommand(false);
        let names;
        if (sub === 'include') {
            const [rows] = await pool.execute(
                `SELECT username FROM blacklisted_users
                  WHERE guild_id = ? AND platform = 'twitch' AND username LIKE ?
                  ORDER BY username LIMIT 25`,
                [interaction.guildId, `%${typed}%`]
            );
            names = rows.map(r => r.username);
        } else {
            const [rows] = await pool.execute(
                `SELECT DISTINCT s.username
                   FROM subscriptions sub
                   JOIN streamers s ON s.streamer_id = sub.streamer_id
                   JOIN twitch_teams t ON t.id = sub.team_subscription_id
                  WHERE t.guild_id = ? AND sub.guild_id = ? AND s.platform = 'twitch' AND s.username LIKE ?
                  ORDER BY s.username LIMIT 25`,
                [interaction.guildId, interaction.guildId, `%${typed}%`]
            );
            names = rows.map(r => r.username);
        }
        await interaction.respond(names.map(n => ({ name: n, value: n })));
    } catch (error) {
        logger.error('[TeamSync Command] Streamer autocomplete error:', { error: error.message });
        await interaction.respond([]).catch(() => {});
    }
}

/**
 * /admin teamsync exclude streamer:<login> [reason]
 * Stops every team sync in this server from (re-)adding the streamer, and releases the
 * subscriptions the team sync holds for them here now.
 */
export async function handleExclude(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const raw = interaction.options.getString('streamer', true);
    const reason = interaction.options.getString('reason');
    const login = normaliseLogin(raw);
    if (!login) {
        return interaction.editReply({ content: `\`${raw.slice(0, 50)}\` is not a valid Twitch username.` });
    }

    try {
        // Resolve the permanent Twitch id so a later rename does not undo the exclusion. When the
        // API is unavailable, fall back to what streamers already knows, then to the login itself.
        let platformUserId = null;
        let discordUserId = null;
        const twitchUser = await getTwitchUser(login).catch(() => null);
        if (twitchUser?.id) platformUserId = String(twitchUser.id);
        const [known] = await pool.execute(
            `SELECT platform_user_id, discord_user_id FROM streamers WHERE platform = 'twitch' AND LOWER(username) = ? LIMIT 1`,
            [login]
        );
        if (!platformUserId && known.length) platformUserId = known[0].platform_user_id;
        if (known.length && known[0].discord_user_id) discordUserId = known[0].discord_user_id;

        const result = await addTeamExclusion({
            guildId: interaction.guildId, login, platformUserId, discordUserId, reason, addedBy: interaction.user.id,
        });
        if (!result.ok) return interaction.editReply({ content: result.error });

        const released = result.deleted + result.detached;
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setTitle(result.alreadyExcluded ? `${login} was already excluded` : `Excluded ${login} from team sync`)
            .setDescription([
                'The hourly team sync will no longer add this streamer to any team in this server, even while they stay on the Twitch team.',
                released
                    ? `Released ${released} team subscription(s) here: ${result.deleted} removed, ${result.detached} kept as this server's own tracking.`
                    : 'They had no team subscriptions in this server.',
                platformUserId ? null : '⚠️ Twitch did not confirm this account; the exclusion matches the username only.',
            ].filter(Boolean).join('\n\n'))
            .setFooter({ text: 'Undo with /admin teamsync include' })
            .setTimestamp();
        if (reason) embed.addFields({ name: 'Reason', value: reason.slice(0, 255) });
        return interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[TeamSync Command] Exclude failed', { guildId: interaction.guildId, login, error: error.message });
        return interaction.editReply({ content: 'Could not save the exclusion. Please try again.' });
    }
}

/** /admin teamsync include streamer:<login> — lift this server's exclusion. */
export async function handleInclude(interaction) {
    const raw = interaction.options.getString('streamer', true);
    try {
        const result = await removeTeamExclusion(interaction.guildId, raw, interaction.user.id);
        if (result.invalid) {
            return interaction.reply({ content: `\`${raw.slice(0, 50)}\` is not a valid Twitch username.`, ephemeral: true });
        }
        if (!result.removed) {
            return interaction.reply({
                content: result.globalOnly
                    ? `**${normaliseLogin(raw)}** is excluded bot-wide, not just here — only the bot owner can lift that.`
                    : `**${normaliseLogin(raw)}** is not excluded in this server. See \`/admin teamsync excluded\`.`,
                ephemeral: true
            });
        }
        return interaction.reply({
            content: `**${normaliseLogin(raw)}** can be synced again. They will be re-added at the next hourly sync if they are still on the team (or run \`/admin teamsync team\` now).`,
            ephemeral: true
        });
    } catch (error) {
        logger.error('[TeamSync Command] Include failed', { guildId: interaction.guildId, error: error.message });
        return interaction.reply({ content: 'Could not remove the exclusion. Please try again.', ephemeral: true });
    }
}

/** /admin teamsync excluded — this server's exclusions plus bot-wide ones. */
export async function handleExcluded(interaction) {
    try {
        const rows = await listTeamExclusions(interaction.guildId);
        if (!rows.length) {
            return interaction.reply({ content: 'No streamers are excluded from team sync in this server.', ephemeral: true });
        }
        const lines = rows.slice(0, 40).map(r => {
            const scope = r.guild_id ? '' : ' *(bot-wide)*';
            const when = r.blacklisted_at ? ` · <t:${Math.floor(new Date(r.blacklisted_at).getTime() / 1000)}:d>` : '';
            const why = r.reason ? ` — ${String(r.reason).slice(0, 80)}` : '';
            return `• **${r.username}** (${r.platform})${scope}${when}${why}`;
        });
        if (rows.length > 40) lines.push(`…and ${rows.length - 40} more`);
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle(`Excluded from team sync (${rows.length})`)
            .setDescription(lines.join('\n').slice(0, 4000))
            .setFooter({ text: '/admin teamsync include streamer:<name> lifts a server exclusion' });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
        logger.error('[TeamSync Command] Excluded list failed', { guildId: interaction.guildId, error: error.message });
        return interaction.reply({ content: 'Could not load the exclusion list.', ephemeral: true });
    }
}
