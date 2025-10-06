const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const musicManager = require('../core/music-manager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playlist')
        .setDescription('Manage your personal music playlists.')
        .addSubcommand(sub => sub.setName('create').setDescription('Creates a new playlist.').addStringOption(opt => opt.setName('name').setDescription('The name of the new playlist.').setRequired(true)))
        .addSubcommand(sub => sub.setName('delete').setDescription('Deletes one of your playlists.').addStringOption(opt => opt.setName('name').setDescription('The name of the playlist to delete.').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('list').setDescription('Lists all of your playlists in this server.'))
        .addSubcommand(sub => sub.setName('add').setDescription('Adds a song to a playlist.').addStringOption(opt => opt.setName('playlist').setDescription('The name of the playlist.').setRequired(true).setAutocomplete(true)).addStringOption(opt => opt.setName('song').setDescription('The YouTube URL or search query for the song.').setRequired(true)))
        .addSubcommand(sub => sub.setName('view').setDescription('Shows the songs in a playlist.').addStringOption(opt => opt.setName('name').setDescription('The name of the playlist to view.').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('load').setDescription('Adds all songs from a playlist to the queue.').addStringOption(opt => opt.setName('name').setDescription('The name of the playlist to load.').setRequired(true).setAutocomplete(true))),

    async autocomplete(interaction) {
        const focusedValue = interaction.options.getFocused();
        const [playlists] = await db.execute('SELECT name FROM music_playlists WHERE guild_id = ? AND user_id = ? AND name LIKE ?', [interaction.guild.id, interaction.user.id, `${focusedValue}%`]);
        await interaction.respond(playlists.map(p => ({ name: p.name, value: p.name })));
    },

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const subcommand = interaction.options.getSubcommand();
        const name = interaction.options.getString('name') || interaction.options.getString('playlist');
        const user = interaction.user;
        const guildId = interaction.guild.id;

        try {
            if (subcommand === 'create') {
                await musicManager.createPlaylist(user.id, guildId, name);
                await interaction.editReply(`✅ Playlist "**${name}**" created!`);
            } else if (subcommand === 'delete') {
                const deleted = await musicManager.deletePlaylist(user.id, guildId, name);
                if (deleted) {
                    await interaction.editReply(`🗑️ Playlist "**${name}**" has been deleted.`);
                } else {
                    await interaction.editReply(`❌ Playlist "**${name}**" not found.`);
                }
            } else if (subcommand === 'list') {
                const playlists = await musicManager.listPlaylists(user.id, guildId);
                if (playlists.length === 0) return interaction.editReply("You don't have any playlists in this server.");
                const embed = new EmbedBuilder().setTitle(`${user.username}'s Playlists`).setColor('#3498DB').setDescription(playlists.map(p => `• **${p.name}** (${p.song_count} songs)`).join('\n'));
                await interaction.editReply({ embeds: [embed] });
            } else if (subcommand === 'add') {
                const songQuery = interaction.options.getString('song');
                const song = await musicManager.addSongToPlaylist(user.id, guildId, name, songQuery);
                if (song.error) return interaction.editReply(`❌ ${song.error}`);
                await interaction.editReply(`✅ Added **${song.title}** to the "**${name}**" playlist.`);
            } else if (subcommand === 'view') {
                const playlist = await musicManager.viewPlaylist(user.id, guildId, name);
                if (playlist.error) return interaction.editReply(`❌ ${playlist.error}`);
                const embed = new EmbedBuilder().setTitle(`🎵 Songs in "${name}"`).setColor('#3498DB').setDescription(playlist.songs.map((s, i) => `${i + 1}. [${s.title}](${s.url}) \`${s.duration}\``).join('\n').substring(0, 4000) || 'This playlist is empty.');
                await interaction.editReply({ embeds: [embed] });
            } else if (subcommand === 'load') {
                if (!interaction.member.voice.channel) return interaction.editReply('You must be in a voice channel to load a playlist!');
                const result = await musicManager.loadPlaylist(user, guildId, name, interaction.member.voice.channel);
                if (result.error) return interaction.editReply(`❌ ${result.error}`);
                await interaction.editReply(`✅ Loaded **${result.count}** songs from the "**${name}**" playlist into the queue.`);
            }
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                return interaction.editReply(`❌ A playlist with the name "**${name}**" already exists.`);
            }
            console.error('[Playlist Command Error]', error);
            await interaction.editReply('An error occurred while managing your playlists.');
        }
    },
};