import { EmbedBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import { syncAllTeams } from '../../jobs/team-sync-scheduler.js';
import { syncTwitchTeam } from '../../core/team-sync.js';
import pool from '../../utils/db.js';

export async function handleAutocomplete(interaction) {
    const focusedValue = interaction.options.getFocused().toLowerCase();

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
            .setColor('#FFA500')
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
            .setColor('#FF0000')
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
                        .setColor('#FF0000')
                        .setTitle('Team Not Found')
                        .setDescription(`No team found with name: ${teamIdOrName}`)
                    ]
                });
                return;
            }
            teamId = teams[0].id;
        }

        const embed = new EmbedBuilder()
            .setColor('#FFA500')
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
            .setColor('#FF0000')
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
            .setColor('#5865F2')
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
