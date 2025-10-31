import { 
    EmbedBuilder, 
    ChatInputCommandInteraction, 
    Message, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    StringSelectMenuBuilder,
    User,
    TextChannel,
    Client,
    Guild,
    GuildMember,
    VoiceChannel,
    StageChannel,
    Collection
} from "discord.js";
import db from "../../utils/db";
import logger from "../../utils/logger";


/**
 * Handles fetching lyrics for the currently playing song
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleLyrics(interaction: any): Promise<any> {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
    }

    await interaction.deferReply();
    const track = queue.currentTrack;
    const trackTitle = track.title.replace(/\(official.*?\)/i, "").replace(/\(feat.*?\)/i, "").trim();

    try {
        const response = await axios.get(`https://api.lyrics.ovh/v1/${track.author}/${trackTitle}`);
        const lyrics = response.data.lyrics;

        if (!lyrics) {
            return interaction.editReply({ content: `❌ No lyrics found for **${track.title}**.` });
        }

        const embed = new EmbedBuilder()
            .setColor("#3498DB")
            .setAuthor({ name: `Lyrics for ${track.title}` })
            .setDescription(lyrics.length > 4096 ? lyrics.substring(0, 4093) + "..." : lyrics);

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        if (_error.response && _error.response.status === 404) {
            return interaction.editReply({ content: `❌ No lyrics found for **${track.title}**.` });
        }
        console.error(("[Lyrics Command Error]", error as any).message);
        await interaction.editReply({ content: `An _error occurred: ${_error.message}` });
    }
}

/**
 * Handles searching for songs and letting users choose from results
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleSearch(interaction: any): Promise<any> {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const query = interaction.options.getString("query");
    const { member } = interaction;

    if (!member.voice.channel) {
        return interaction.reply({ content: "You must be in a voice channel to search for music!", ephemeral: true });
    }

    await interaction.deferReply();

    try {
        const results = await interaction.client.player.search(query, { requestedBy: interaction.user });
        if (!results || !results.hasTracks()) {
            return interaction.editReply({ content: "No results found for your query." });
        }

        const tracks = results.tracks.slice(0, 10).filter(track => !track.url.includes('youtube.com/shorts'));
        if (tracks.length === 0) {
            return interaction.editReply({ content: "No valid results found (only YouTube Shorts, which are not supported)." });
        }

        const embed = new EmbedBuilder()
            .setColor("#3498DB")
            .setAuthor({ name: `Top ${tracks.length} Search Results for "${query}"` })
            .setDescription(tracks.map((track, i) => `**${i + 1}.** ${track.title} - \`${track.duration}\``).join("\n"))
            .setFooter({ text: "Type the number of the song you want to play. You have 30 seconds." });

        await interaction.editReply({ embeds: [embed] });

        const filter = m => m.author.id === interaction.user.id && parseInt(m.content) >= 1 && parseInt(m.content) <= tracks.length;
        const collector = interaction.channel.createMessageCollector({ filter, time: 30000, max: 1 });

        collector.on("collect", async m => {
            const choice = parseInt(m.content) - 1;
            const track = tracks[choice];
            await interaction.client.player.play(member.voice.channel, track, {
                nodeOptions: { metadata: { channelId: interaction.channel.id } }
            });
            m.delete().catch(() => {});
            interaction.editReply({ content: `✅ | Added **${track.title}** to the queue.` });
        });

        collector.on("end", (collected, reason) => {
            if (reason === "time") {
                interaction.editReply({ content: "❌ | You did not make a selection in time." });
            }
        });
    } catch (error) {
        console.error(("[Search Command Error]", error as any).message);
        return interaction.editReply({ content: `An _error occurred: ${_error.message}` });
    }
}

/**
 * Handles starting an AI DJ session
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleDJ(interaction: any): Promise<any> {
    const { member, guild, client } = interaction;
    const prompt = interaction.options.getString('prompt');
    const inputSong = interaction.options.getString('song');
    const inputArtist = interaction.options.getString('artist');
    const inputGenre = interaction.options.getString('genre');
    const playlistLink = interaction.options.getString('playlist_link');

    if (!member.voice.channel) {
        return interaction.reply({ content: "You must be in a voice channel to start a DJ session.", ephemeral: true });
    }

    const [musicConfigRows] = await db.execute("SELECT * FROM music_config WHERE guild_id = ?", [guild.id]);
    const musicConfig = musicConfigRows[0];

    if (!musicConfig || !musicConfig.dj_enabled) {
        return interaction.reply({ content: "The AI DJ is not enabled on this server. An admin can enable it in the dashboard.", ephemeral: true });
    }

    await interaction.deferReply();

    try {
        let queue = client.player.nodes.get(guild.id);
        const isQueueActive = queue && queue.isPlaying();

        if (!queue) {
            queue = client.player.nodes.create(guild.id, {
                metadata: {
                    channelId: interaction.channel.id,
                    djMode: true,
                    voiceChannelId: member.voice.channel.id,
                    playedTracks: [],
                    inputSong,
                    inputArtist,
                    inputGenre,
                    prompt,
                    djInitiatorId: interaction.user.id
                },
                selfDeaf: true,
                volume: 80,
                leaveOnEmpty: true,
                leaveOnEmptyCooldown: 300000,
                leaveOnEnd: false,
                leaveOnEndCooldown: 300000,
            });
        } else {
            queue.metadata.djMode = true;
            queue.leaveOnEnd = false;
            if (!queue.metadata.djInitiatorId) queue.metadata.djInitiatorId = interaction.user.id;
        }

        if (!queue.connection) await queue.connect(member.voice.channel.id);
        if (!queue.metadata.playedTracks) queue.metadata.playedTracks = [];

        let allPlaylistTracks = [];

        if (playlistLink) {
            const searchResult = await client.player.search(playlistLink, { requestedBy: interaction.user });
            if (!searchResult.hasTracks()) {
                return interaction.followUp({ content: `❌ | No tracks found for the provided playlist link.` });
            }
            allPlaylistTracks = searchResult.tracks.filter(track => !track.url.includes('youtube.com/shorts'));
        } else {
            const geminiRecommendedTracks = await geminiApi.generatePlaylistRecommendations(inputSong, inputArtist, inputGenre, queue.metadata.playedTracks, prompt);
            if (!geminiRecommendedTracks || geminiRecommendedTracks.length === 0) {
                return interaction.followUp({ content: `❌ | Gemini AI could not generate a playlist based on your request. Please try again with different inputs.` });
            }

            const trackPromises = geminiRecommendedTracks.map(async (recTrack) => {
                const query = `${recTrack.title} ${recTrack.artist}`;
                const searchResult = await client.player.search(query, { requestedBy: interaction.user, metadata: { artist: recTrack.artist } });
                if (searchResult.hasTracks()) {
                    const track = searchResult.tracks[0];
                    if (!track.url.includes('youtube.com/shorts')) return track;
                }
                return null;
            });

            allPlaylistTracks = (await Promise.all(trackPromises)).filter(track => track !== null);
        }

        if (allPlaylistTracks.length === 0) {
            return interaction.followUp({ content: `❌ | Could not find any playable tracks for the generated playlist.` });
        }

        queue.metadata.playedTracks.push(...allPlaylistTracks.map(t => t.title));

        await client.djManager.playPlaylistIntro(queue, allPlaylistTracks, isQueueActive);

        if (!isQueueActive) {
            await queue.node.play();
            return interaction.followUp({ content: `🎧 | Gemini AI DJ session started! An introductory commentary will play, followed by ${allPlaylistTracks.length} songs.` });
        } else {
            return interaction.followUp({ content: `✅ | Added ${allPlaylistTracks.length} songs to the queue. The new playlist will begin after the current one finishes.` });
        }
    } catch (e) {
        console.error("[DJ Command Error]", e.message);
        return interaction.followUp({ content: `An error occurred: ${e.message}` });
    }
}

/**
 * Handles recording audio in a voice channel
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleRecord(interaction: any): Promise<any> {
    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guild.id;
    const member = interaction.member;

    const [[recordConfig]] = await db.execute(
        "SELECT is_enabled, allowed_role_ids, output_channel_id FROM record_config WHERE guild_id = ?",
        [guildId]
    );

    if (!recordConfig || !recordConfig.is_enabled) {
        return interaction.editReply({ content: "Voice recording is not enabled for this server." });
    }

    const allowedRoleIds = recordConfig.allowed_role_ids ? JSON.parse(recordConfig.allowed_role_ids) : [];
    const outputChannelId = recordConfig.output_channel_id;
    const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
    const hasAllowedRole = allowedRoleIds.some(roleId => member.roles.cache.has(roleId));

    if (!isAdmin && !hasAllowedRole) {
        return interaction.editReply({ content: "You do not have permission to use this command." });
    }

    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
        return interaction.editReply({ content: "You must be in a voice channel to use this command." });
    }

    let outputChannel = null;
    if (outputChannelId) {
        try {
            outputChannel = await interaction.client.channels.fetch(outputChannelId);
        } catch (e) {
            console.error(`[Record Command] Could not fetch output channel ${outputChannelId} for guild ${guildId}:`, e.message);
        }
    }

    try {
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guildId,
            adapterCreator: interaction.guild.voiceAdapterCreator,
            selfDeaf: false
        });

        const receiver = connection.receiver;
        const audioStream = receiver.subscribe(member.id, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
        const recordingsDir = "./temp_audio";

        if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir);

        const filename = `${recordingsDir}/${Date.now()}-${member.user.username}.pcm`;
        const fileStream = fs.createWriteStream(filename);
        const pcmStream = audioStream.pipe(new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 }));
        pcmStream.pipe(fileStream);

        let recordingStartTime = Date.now();

        const startEmbed = new EmbedBuilder()
            .setColor("#00FF00")
            .setDescription(`🎙️ Recording started in ${voiceChannel.name} by ${member.user.tag}.`);

        if (outputChannel) {
            try {
                await outputChannel.send({ embeds: [startEmbed] });
            } catch (sendError) {
                console.error(`[Record Command] Failed to send start embed to output channel ${outputChannel.id}:`, sendError.message);
            }
        }

        await interaction.editReply({ content: `✅ Recording started. The recording will be saved.`, ephemeral: true });

        fileStream.on("finish", async () => {
            const durationSeconds = Math.floor((Date.now() - recordingStartTime) / 1000);
            const endEmbed = new EmbedBuilder()
                .setColor("#FF0000")
                .setDescription(`🔴 Recording stopped in ${voiceChannel.name}. Duration: ${durationSeconds} seconds.`);

            if (outputChannel) {
                try {
                    await outputChannel.send({ embeds: [endEmbed] });
                } catch (sendError) {
                    console.error(`[Record Command] Failed to send end embed to output channel ${outputChannel.id}:`, sendError.message);
                }
            }

            console.log(` Recording for ${member.user.tag} in ${voiceChannel.name} finished. Saved to ${filename}`);
        });

        connection.on("stateChange", (oldState, newState) => {
            if (newState.status === "disconnected") {
                fileStream.end();
                console.log(` Voice connection disconnected for ${member.user.tag}.`);
            }
        });
    } catch (error) {
        console.error(("[Record Command Error]", error as any).message);
        return interaction.editReply({ content: "An _error occurred while trying to start the recording." });
    }
}

module.exports = {
    handleLyrics,
    handleSearch,
    handleDJ,
    handleRecord,
};
