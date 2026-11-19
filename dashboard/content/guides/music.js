// Checked against: commands/music/music.js, handlers/music/*.js (player, controls, features), utils/music_helpers.js,
// core/dj-manager.cjs, core/music-panel.js, index.js (extractors), dashboard/views/partials/manage/music.ejs,
// core/feature-config-spec.js ('ai-dj').
export default {
    slug: 'music',
    title: 'Music and the AI DJ',
    area: 'music',
    summary: 'Play music in a voice channel from YouTube, Spotify and SoundCloud links and searches, or let the AI DJ pick songs and talk between them.',
    result: {
        image: 'music-discord',
        caption: 'Starting the AI DJ from a prompt, then /music nowplaying.',
    },
    before: [
        'Music is off until an admin turns it on. Members need to be in a voice channel the bot can join.',
    ],
    steps: [
        {
            title: 'Turn on music',
            text: [
                'On the dashboard, open **Music & voice**, then **Music**, and switch **Music** on. A **DJ role** is optional: once it is set, only members with that role, admins, or someone alone in the voice channel can control playback or start the AI DJ. Anyone listening can still start a vote to skip.',
            ],
            image: 'music-page',
        },
        {
            title: 'Play something',
            text: [
                'Join a voice channel and use `/music play` with a song name, or a YouTube, Spotify or SoundCloud link. `/music queue` shows what is next; `skip`, `pause`, `resume`, `stop`, `volume`, `loop`, `shuffle` and `lyrics` do what they say.',
            ],
            command: '/music play query:lanterns over the hollow',
        },
        {
            title: 'Start the AI DJ',
            text: [
                'Switch on **AI DJ** on the Music page (it is the same switch as on the **AI DJ** page, and Music has to be on too) and pick a **DJ voice**. Then start a session with a prompt, a song, an artist, a genre or a playlist link. The DJ builds a playlist, keeps it topped up, and talks between tracks in the chosen voice.',
                'The **AI DJ** page sets a default mood, genres, seed artists and how adventurous the picks are. `/music stop` ends the session.',
            ],
            command: '/music dj prompt:rainy evening lo-fi',
        },
        {
            title: 'Set playback rules',
            text: [
                'On the Music page: **Stay in voice (24/7)** and **Autoplay** are off by default. **Vote to skip** is off; when you turn it on, **Votes needed** starts at 50 percent. **Playlists per member** and **Songs per playlist** limit saved playlists (leave them empty for no limit), and **Audio filters** chooses which filters members may use.',
            ],
        },
        {
            title: 'Post a player panel',
            text: [
                '`/music panel create` posts a player with buttons for pause, skip, stop, shuffle, loop, volume and the queue, plus a menu to add a song or start the DJ. It needs Manage Server.',
            ],
            command: '/music panel create',
        },
    ],
    notes: [
        'SoundCloud links play SoundCloud\'s own audio. A track SoundCloud only offers with DRM (most major-label releases) or as a 30-second Go+ preview plays the same song from YouTube instead, matched by title, artist and length, and the reply says so.',
        'Members save playlists with `/music playlist create name:` and play them with `/music playlist play name:`.',
        '`/music forceskip` needs the DJ role or Administrator.',
    ],
    related: ['economy', 'community', 'getting-started'],
};
