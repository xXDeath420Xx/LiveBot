import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import { checkMusicPermissions, getLeaveOptions, getMusicConfig } from '../../utils/music_helpers.js';

/** Per-server limits from the dashboard's Music page (music_config); null = no limit. */
async function playlistLimits(guildId) {
    const config = await getMusicConfig(guildId).catch(() => null);
    const positive = (v) => (Number(v) > 0 ? Number(v) : null);
    return { maxPlaylists: positive(config?.max_playlists_per_user), maxSongs: positive(config?.max_songs_per_playlist) };
}

/**
 * Handles creating a new playlist
 */
export async function handleCreate(interaction) {
    const name = interaction.options.getString("name");
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    try {
        const { maxPlaylists } = await playlistLimits(guildId);
        if (maxPlaylists) {
            const [[{ count }]] = await pool.execute(
                "SELECT COUNT(*) AS count FROM user_playlists WHERE guild_id = ? AND user_id = ?",
                [guildId, userId]
            );
            if (Number(count) >= maxPlaylists) {
                return interaction.reply({ content: `You can have at most **${maxPlaylists}** playlists on this server. Delete one first.`, ephemeral: true });
            }
        }
        await pool.execute(
            "INSERT INTO user_playlists (guild_id, user_id, name, songs) VALUES (?,?,?,?)",
            [guildId, userId, name, "[]"]
        );
        return interaction.reply({ content: `Playlist **${name}** created.`, ephemeral: true });
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            return interaction.reply({ content: `You already have a playlist named **${name}**.`, ephemeral: true });
        }
        console.error("[Playlist Create Error]", error.message);
        return interaction.reply({ content: "An error occurred while creating the playlist.", ephemeral: true });
    }
}

/**
 * Handles deleting a playlist
 */
export async function handleDelete(interaction) {
    const name = interaction.options.getString("name");
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    try {
        const [result] = await pool.execute(
            "DELETE FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?",
            [guildId, userId, name]
        );

        if (result.affectedRows > 0) {
            return interaction.reply({ content: `Playlist **${name}** deleted.`, ephemeral: true });
        } else {
            return interaction.reply({ content: `You don't have a playlist named **${name}**.`, ephemeral: true });
        }
    } catch (error) {
        console.error("[Playlist Delete Error]", error.message);
        return interaction.reply({ content: "An error occurred while deleting the playlist.", ephemeral: true });
    }
}

/**
 * Handles adding the current song to a playlist
 */
export async function handleAdd(interaction) {
    const name = interaction.options.getString("name");
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    const queue = interaction.client.player.nodes.get(guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing to add!", ephemeral: true });
    }

    const currentTrack = queue.currentTrack;

    try {
        const [playlists] = await pool.execute(
            "SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?",
            [guildId, userId, name]
        );

        if (playlists.length === 0) {
            return interaction.reply({ content: `You don't have a playlist named **${name}**.`, ephemeral: true });
        }

        const playlist = playlists[0];
        const songs = JSON.parse(playlist.songs || "[]");
        const { maxSongs } = await playlistLimits(guildId);
        if (maxSongs && songs.length >= maxSongs) {
            return interaction.reply({ content: `**${name}** is full (${maxSongs} songs max on this server).`, ephemeral: true });
        }
        songs.push({ title: currentTrack.title, url: currentTrack.url });

        await pool.execute(
            "UPDATE user_playlists SET songs = ? WHERE playlist_id = ?",
            [JSON.stringify(songs), playlist.playlist_id]
        );

        return interaction.reply({ content: `Added **${currentTrack.title}** to the **${name}** playlist.`, ephemeral: true });
    } catch (error) {
        console.error("[Playlist Add Error]", error.message);
        return interaction.reply({ content: "An error occurred while adding to the playlist.", ephemeral: true });
    }
}

/**
 * Handles removing a song from a playlist
 */
export async function handleRemove(interaction) {
    const name = interaction.options.getString("name");
    const position = interaction.options.getInteger("position") - 1;
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    try {
        const [playlists] = await pool.execute(
            "SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?",
            [guildId, userId, name]
        );

        if (playlists.length === 0) {
            return interaction.reply({ content: `You don't have a playlist named **${name}**.`, ephemeral: true });
        }

        const playlist = playlists[0];
        const songs = JSON.parse(playlist.songs || "[]");
        if (position < 0 || position >= songs.length) {
            return interaction.reply({ content: "Invalid song position.", ephemeral: true });
        }

        const removedSong = songs.splice(position, 1)[0];

        await pool.execute(
            "UPDATE user_playlists SET songs = ? WHERE playlist_id = ?",
            [JSON.stringify(songs), playlist.playlist_id]
        );

        return interaction.reply({ content: `Removed **${removedSong.title}** from the **${name}** playlist.`, ephemeral: true });
    } catch (error) {
        console.error("[Playlist Remove Error]", error.message);
        return interaction.reply({ content: "An error occurred while removing from the playlist.", ephemeral: true });
    }
}

/**
 * Handles listing all playlists
 */
export async function handleList(interaction) {
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    try {
        const [playlists] = await pool.execute(
            "SELECT name FROM user_playlists WHERE guild_id = ? AND user_id = ?",
            [guildId, userId]
        );

        if (playlists.length === 0) {
            return interaction.reply({ content: "You don't have any playlists yet.", ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setColor("#3498DB")
            .setAuthor({ name: "Your Playlists" })
            .setDescription(playlists.map(p => `${p.name}`).join("\n"));

        return interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
        console.error("[Playlist List Error]", error.message);
        return interaction.reply({ content: "An error occurred while listing playlists.", ephemeral: true });
    }
}

/**
 * Handles showing songs in a playlist
 */
export async function handleShow(interaction) {
    const name = interaction.options.getString("name");
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    try {
        const [playlists] = await pool.execute(
            "SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?",
            [guildId, userId, name]
        );

        if (playlists.length === 0) {
            return interaction.reply({ content: `You don't have a playlist named **${name}**.`, ephemeral: true });
        }

        const playlist = playlists[0];
        const songs = JSON.parse(playlist.songs || "[]");
        const embed = new EmbedBuilder()
            .setColor("#3498DB")
            .setAuthor({ name: `Playlist: ${name}` })
            .setDescription(songs.length > 0 ? songs.map((s, i) => `**${i + 1}.** ${s.title}`).join("\n") : "This playlist is empty.");

        return interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
        console.error("[Playlist Show Error]", error.message);
        return interaction.reply({ content: "An error occurred while showing the playlist.", ephemeral: true });
    }
}

/**
 * Handles playing a playlist
 */
export async function handlePlay(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    if (!interaction.member.voice.channel) {
        return interaction.reply({ content: "You must be in a voice channel to play music!", ephemeral: true });
    }

    const name = interaction.options.getString("name");
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    try {
        const [playlists] = await pool.execute(
            "SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?",
            [guildId, userId, name]
        );

        if (playlists.length === 0) {
            return interaction.reply({ content: `You don't have a playlist named **${name}**.`, ephemeral: true });
        }

        const playlist = playlists[0];
        const songs = JSON.parse(playlist.songs || "[]");
        if (songs.length === 0) {
            return interaction.reply({ content: `The **${name}** playlist is empty.`, ephemeral: true });
        }

        await interaction.deferReply();

        try {
            // Resolve each saved song on its own — joining the URLs into one query string made a
            // single nonsense search that queued (at most) one wrong track.
            const player = interaction.client.player;
            const tracks = [];
            for (const song of songs) {
                const result = await player.search(song.url, { requestedBy: interaction.user }).catch(() => null);
                if (result?.tracks?.length) tracks.push(result.tracks[0]);
            }
            if (tracks.length === 0) {
                return interaction.followUp({ content: `None of the songs in **${name}** could be found.` });
            }

            const { queue } = await player.play(interaction.member.voice.channel, tracks[0], {
                requestedBy: interaction.user,
                nodeOptions: {
                    metadata: { channelId: interaction.channel.id },
                    ...(await getLeaveOptions(interaction.guildId))
                }
            });
            if (tracks.length > 1) queue.addTrack(tracks.slice(1));

            const skipped = songs.length - tracks.length;
            return interaction.followUp({ content: `Now playing the **${name}** playlist (${tracks.length} song${tracks.length !== 1 ? 's' : ''}${skipped ? `, ${skipped} unavailable` : ''}).` });
        } catch (e) {
            console.error("[Playlist Play Error]", e.message);
            return interaction.followUp({ content: `An error occurred while trying to play the playlist: ${e.message}` });
        }
    } catch (error) {
        console.error("[Playlist Play Error]", error.message);
        return interaction.reply({ content: "An error occurred while playing the playlist.", ephemeral: true });
    }
}
