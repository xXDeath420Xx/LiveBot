const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, PermissionsBitField } = require('discord.js');
const db = require('../utils/db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('removestreamer')
        .setDescription('Removes a streamer and all their subscriptions from this server.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    async execute(interaction) {
        const guildId = interaction.guild.id;

        const [streamers] = await db.execute(
            `SELECT s.streamer_id, s.username, s.platform 
             FROM streamers s 
             JOIN subscriptions sub ON s.streamer_id = sub.streamer_id 
             WHERE sub.guild_id = ? 
             GROUP BY s.streamer_id`, 
            [guildId]
        );

        if (streamers.length === 0) {
            return interaction.reply({ content: 'There are no streamers configured for this server.', ephemeral: true });
        }

        const options = streamers.map(s => ({
            label: `${s.username} on ${s.platform.charAt(0).toUpperCase() + s.platform.slice(1)}`,
            value: s.streamer_id.toString(),
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('remove_streamer_select')
            .setPlaceholder('Select streamers to remove')
            .setMinValues(1)
            .setMaxValues(options.length)
            .addOptions(options);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        await interaction.reply({ content: 'Please select the streamer(s) you want to remove:', components: [row], ephemeral: true });

        const filter = i => i.customId === 'remove_streamer_select' && i.user.id === interaction.user.id;
        const collector = interaction.channel.createMessageComponentCollector({ filter, time: 60000 });

        collector.on('collect', async i => {
            await i.deferUpdate();
            const streamerIdsToRemove = i.values;

            if (!streamerIdsToRemove || streamerIdsToRemove.length === 0) {
                await i.editReply({ content: 'No streamers selected. Operation cancelled.', components: [] });
                return;
            }

            try {
                // Begin transaction
                await db.query('START TRANSACTION');

                // 1. Delete from announcements
                const [announcementsResult] = await db.query(
                    'DELETE FROM announcements WHERE streamer_id IN (?)', 
                    [streamerIdsToRemove]
                );

                // 2. Delete from subscriptions
                const [subscriptionsResult] = await db.query(
                    'DELETE FROM subscriptions WHERE streamer_id IN (?) AND guild_id = ?', 
                    [streamerIdsToRemove, guildId]
                );

                // 3. Optionally, delete from streamers if they have no other subscriptions in any other guild
                for (const streamerId of streamerIdsToRemove) {
                    const [[subCount]] = await db.query('SELECT COUNT(*) as count FROM subscriptions WHERE streamer_id = ?', [streamerId]);
                    if (subCount.count === 0) {
                        await db.query('DELETE FROM streamers WHERE streamer_id = ?', [streamerId]);
                    }
                }

                // Commit transaction
                await db.query('COMMIT');

                const removedCount = subscriptionsResult.affectedRows;
                await i.editReply({ content: `Successfully removed ${removedCount} subscription(s) for the selected streamer(s) from this server.`, components: [] });

            } catch (error) {
                await db.query('ROLLBACK'); // Rollback on error
                console.error('[RemoveStreamer Error]', error);
                await i.editReply({ content: 'An error occurred while removing the streamer(s). The operation has been cancelled.', components: [] });
            } finally {
                collector.stop();
            }
        });

        collector.on('end', collected => {
            if (collected.size === 0) {
                interaction.editReply({ content: 'Time has run out, no streamers were removed.', components: [] });
            }
        });
    },
};