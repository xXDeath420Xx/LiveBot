const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
} = require('@discordjs/voice');
const ytdl = require('ytdl-core');
const ytSearch = require('yt-search');
const logger = require('../utils/logger');
const db = require('../utils/db');
const SpotifyWebApi = require('spotify-web-api-node');

const spotifyApi = new SpotifyWebApi({
  clientId: 'f38eed1a1d50412c9a8acf3fcc15793f',
  clientSecret: 'ae269626c4ba4f038c230273e0ac3fc5',
});

const queues = new Map();

async function getQueue(guildId) {
    let queue = queues.get(guildId);
    if (!queue) {
        const [[dbQueue]] = await db.execute('SELECT * FROM music_queues WHERE guild_id = ?', [guildId]);
        if (dbQueue) {
            queue = {
                voiceChannel: null,
                connection: null,
                player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } }),
                songs: JSON.parse(dbQueue.queue),
                isPlaying: dbQueue.is_playing,
                isPaused: dbQueue.is_paused,
                nowPlaying: JSON.parse(dbQueue.now_playing || null),
                loop: 'none', // 'none', 'song', 'queue'
            };
            queues.set(guildId, queue);
        }
    }
    return queue;
}

async function saveQueue(guildId) {
    const queue = queues.get(guildId);
    if (!queue) return;
    await db.execute(
        `INSERT INTO music_queues (guild_id, queue, is_playing, is_paused, now_playing) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE queue = VALUES(queue), is_playing = VALUES(is_playing), is_paused = VALUES(is_paused), now_playing = VALUES(now_playing)`,
        [
            guildId,
            JSON.stringify(queue.songs),
            queue.isPlaying,
            queue.isPaused,
            JSON.stringify(queue.nowPlaying)
        ]
    );
}

async function playSpotifyTrack(voiceChannel, query, user) {
  try {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body['access_token']);

    const trackIdMatch = query.match(/spotify\.com\/track\/([a-zA-Z0-9]+)/);
    if (!trackIdMatch) {
      throw new Error('Invalid Spotify track URL.');
    }
    const trackId = trackIdMatch[1];

    const trackData = await spotifyApi.getTrack(trackId);
    const trackName = trackData.body.name;
    const artistName = trackData.body.artists[0].name;
    const youtubeQuery = `${trackName} ${artistName} official audio`;

    return await play(voiceChannel, youtubeQuery, user);

  } catch (error) {
    logger.error('[MusicManager] Error playing Spotify track:', error);
    throw new Error('Could not play the Spotify track.');
  }
}

async function play(voiceChannel, query, user) {
  if (query.includes('spotify.com/track')) {
    return playSpotifyTrack(voiceChannel, query, user);
  }

  const song = await getSong(query, user);
  let queue = await getQueue(voiceChannel.guild.id);

  if (!queue) {
    queue = {
      voiceChannel: voiceChannel,
      connection: null,
      songs: [],
      player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } }),
      isPlaying: false,
      isPaused: false,
      nowPlaying: null,
      loop: 'none',
    };
    queues.set(voiceChannel.guild.id, queue);
  }
  
  queue.songs.push(song);

  if (!queue.isPlaying) {
    queue.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    queue.connection.on(VoiceConnectionStatus.Disconnected, () => {
      queues.delete(voiceChannel.guild.id);
      saveQueue(voiceChannel.guild.id);
    });

    queue.player.on(AudioPlayerStatus.Idle, () => {
        const oldSong = queue.songs.shift();
        if (queue.loop === 'song') {
            queue.songs.unshift(oldSong);
        } else if (queue.loop === 'queue') {
            queue.songs.push(oldSong);
        }

        if (queue.songs.length > 0) {
            playNext(voiceChannel.guild.id);
        } else {
            queue.isPlaying = false;
            queue.nowPlaying = null;
            queue.connection.destroy();
        }
        saveQueue(voiceChannel.guild.id);
    });
    
    queue.player.on('error', error => {
      logger.error('[MusicManager] Player Error:', { error });
      queue.songs.shift();
      playNext(voiceChannel.guild.id);
    });

    queue.connection.subscribe(queue.player);
    playNext(voiceChannel.guild.id);
  }

  await saveQueue(voiceChannel.guild.id);
  return { song, addedToQueue: queue.isPlaying };
}

function playNext(guildId) {
  const queue = queues.get(guildId);
  if (!queue || queue.songs.length === 0) {
    if (queue) {
      queue.isPlaying = false;
      queue.nowPlaying = null;
      if (queue.connection) queue.connection.destroy();
      queues.delete(guildId);
    }
    return;
  }

  queue.isPlaying = true;
  queue.isPaused = false;
  queue.nowPlaying = queue.songs[0];
  
  const stream = ytdl(queue.songs[0].url, { filter: 'audioonly', quality: 'highestaudio', highWaterMark: 1 << 25 });
  const resource = createAudioResource(stream);
  queue.player.play(resource);
}

async function getSong(query, user) {
  // ... (this function remains the same as before)
  // Placeholder for getSong function, assuming it exists in the original file
  // and handles fetching song details from YouTube.
  // For example:
  try {
    const videoResult = await ytSearch(query);
    if (!videoResult.videos.length) return null;

    const video = videoResult.videos[0];
    return {
      title: video.title,
      url: video.url,
      duration: video.timestamp,
      channel: video.author.name,
      thumbnail: video.thumbnail,
      requestedBy: user,
    };
  } catch (error) {
    logger.error(`[MusicManager] Error fetching song: ${error.message}`, { query });
    return null;
  }
}

function pause(guildId) {
    const queue = queues.get(guildId);
    if (queue && queue.isPlaying && !queue.isPaused) {
        queue.player.pause();
        queue.isPaused = true;
        saveQueue(guildId);
        return true;
    }
    return false;
}

function resume(guildId) {
    const queue = queues.get(guildId);
    if (queue && queue.isPaused) {
        queue.player.unpause();
        queue.isPaused = false;
        saveQueue(guildId);
        return true;
    }
    return false;
}

function setLoop(guildId, mode) {
    const queue = queues.get(guildId);
    if (queue) {
        queue.loop = mode;
        return true;
    }
    return false;
}

async function search(query) {
    const { videos } = await ytSearch(query);
    if (!videos.length) return [];
    return videos.slice(0, 5).map(v => ({
      title: v.title,
      url: v.url,
      duration: v.timestamp,
      author: v.author.name,
    }));
}

// Placeholder for skip and stop functions, assuming they exist in the original file.
async function skip(guildId) {
  const queue = queues.get(guildId);
  if (!queue || !queue.isPlaying) return false;

  queue.player.stop(); // This will trigger the 'idle' event and play the next song
  return true;
}

async function stop(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return false;

  queue.songs = [];
  queue.player.stop();
  if (queue.connection) queue.connection.destroy();
  queues.delete(guildId);
  await saveQueue(guildId);
  return true;
}

async function createPlaylist(userId, guildId, name) {
    await db.execute(
        'INSERT INTO music_playlists (user_id, guild_id, name) VALUES (?, ?, ?)',
        [userId, guildId, name]
    );
}

async function deletePlaylist(userId, guildId, name) {
    const [[playlist]] = await db.execute('SELECT id FROM music_playlists WHERE user_id = ? AND guild_id = ? AND name = ?', [userId, guildId, name]);
    if (!playlist) return false;
    await db.execute('DELETE FROM music_playlist_songs WHERE playlist_id = ?', [playlist.id]);
    await db.execute('DELETE FROM music_playlists WHERE id = ?', [playlist.id]);
    return true;
}

async function listPlaylists(userId, guildId) {
    const [playlists] = await db.execute(`
        SELECT p.name, COUNT(s.id) as song_count 
        FROM music_playlists p 
        LEFT JOIN music_playlist_songs s ON p.id = s.playlist_id 
        WHERE p.user_id = ? AND p.guild_id = ? 
        GROUP BY p.id`, 
        [userId, guildId]
    );
    return playlists;
}

async function addSongToPlaylist(userId, guildId, name, songQuery) {
    const [[playlist]] = await db.execute('SELECT id FROM music_playlists WHERE user_id = ? AND guild_id = ? AND name = ?', [userId, guildId, name]);
    if (!playlist) return { error: `Playlist "**${name}**" not found.` };

    const song = await getSong(songQuery, { tag: 'Playlist' });
    if (!song) return { error: 'Could not find a song with that query.' };

    await db.execute(
        'INSERT INTO music_playlist_songs (playlist_id, title, url, duration, channel, thumbnail) VALUES (?, ?, ?, ?, ?, ?)',
        [playlist.id, song.title, song.url, song.duration, song.channel, song.thumbnail]
    );
    return song;
}

async function viewPlaylist(userId, guildId, name) {
    const [[playlist]] = await db.execute('SELECT id FROM music_playlists WHERE user_id = ? AND guild_id = ? AND name = ?', [userId, guildId, name]);
    if (!playlist) return { error: `Playlist "**${name}**" not found.` };
    const [songs] = await db.execute('SELECT * FROM music_playlist_songs WHERE playlist_id = ?', [playlist.id]);
    return { songs };
}

async function loadPlaylist(user, guildId, name, voiceChannel) {
    const [[playlist]] = await db.execute('SELECT id FROM music_playlists WHERE user_id = ? AND guild_id = ? AND name = ?', [user.id, guildId, name]);
    if (!playlist) return { error: `Playlist "**${name}**" not found.` };
    const [songs] = await db.execute('SELECT * FROM music_playlist_songs WHERE playlist_id = ?', [playlist.id]);
    if (songs.length === 0) return { error: 'That playlist is empty.'};

    let queue = queues.get(guildId);
    if (!queue) {
        // If no queue, play the first song to start it
        await play(voiceChannel, songs[0].url, user);
        queue = queues.get(guildId);
        // Add the rest of the songs
        for (let i = 1; i < songs.length; i++) {
            const songData = { ...songs[i], requestedBy: user };
            queue.songs.push(songData);
        }
    } else {
        // If queue exists, just add all songs
        for (const song of songs) {
            const songData = { ...song, requestedBy: user };
            queue.songs.push(songData);
        }
    }
    await saveQueue(guildId);
    return { count: songs.length };
}

module.exports = { 
    play, skip, stop, getQueue, saveQueue, pause, resume, setLoop, search,
    createPlaylist, deletePlaylist, listPlaylists, addSongToPlaylist, viewPlaylist, loadPlaylist 
};