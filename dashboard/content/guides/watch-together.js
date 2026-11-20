// Checked against: dashboard/routes/activities/index.js, core/activities/ (config.js, watch/sessions.js,
// watch/guild-config.js, watch/jellyfin-media.js), frontend/activities/src/ (main.js, watch.js, watch-diag.js, sync.js),
// handlers/activities/launch.js (custom-bot servers: openItYourself), commands/media/movie.js, core/feature-config-spec.js (cinema), docs/activities.md.
export default {
    slug: 'watch-together',
    title: 'Watch Together',
    area: 'music',
    summary: 'Films and shows from your server\'s library, played in sync for everyone in a voice channel through a Discord Activity.',
    result: {
        image: 'watch-together-player',
        caption: 'A film playing in Watch Together, with the people watching it.',
    },
    steps: [
        {
            title: 'Switch it on for your server',
            text: [
                'On the dashboard, open **Music & voice**, then **Cinema**. Turn **Cinema** on, set **How films play** to **Watch Together (Discord Activity)** and pick the **Library** your server watches from.',
                'The **Playback control role** can control any film, not only one they started. The **Watch party** page\'s host role, if you set one, decides who may pick a film.',
            ],
            image: 'watch-together-setup',
        },
        {
            title: 'Start a film',
            text: [
                'Join a voice channel and type `/movie play` followed by a title. Pick the film, or a season and episode, choose the audio, and press **Start**: Watch Together opens in your voice channel with that title.',
                'You can also open it without a command: press the Activities button (the rocket) in the voice channel, choose CertiFried, then **Watch Together**, and pick from the **Library** tab. `/movie open` posts a button that does the same.',
            ],
            command: '/movie open',
        },
        {
            title: 'In a server with its own bot',
            text: [
                'Some servers run CertiFried under their own bot name. Watch Together still belongs to CertiFried, so there each member adds CertiFried to their Discord account once: [Add CertiFried to your account](/invite?account=1). It needs no server permissions.',
                'Then join a voice channel, press the Activities button (the rocket) and pick CertiFried. `/movie play` in that server saves your pick, and it starts when you open the Activity. The server\'s bot cannot open the Activity for you, so it tells you these steps instead.',
                'Server admins: members need the **Use Activities** permission in your voice channels, and **Use External Apps** lets apps they added to their own account post in the server. Both are allowed for everyone unless you changed them. The Cinema page says the same and has the link.',
            ],
        },
        {
            title: 'Watch together',
            text: [
                'Everyone in the voice channel joins with the Activity\'s **Join** button. People who join part-way start at the same moment as everyone else, and a player that falls behind catches up on its own.',
                'The host plays, pauses, jumps and picks what comes next. Everyone chooses their own volume and text subtitles under the player. The **People** tab shows who is watching and whose video is still loading.',
            ],
            image: 'watch-together-library',
        },
        {
            title: 'Episodes and the queue',
            text: [
                '**Play from here** on an episode plays it and the rest of the season in order. The **Queue** tab shows what comes next; the host can skip ahead or stop for everyone.',
            ],
        },
        {
            title: 'If you cannot hear it',
            text: [
                'Check your own volume slider under the player first. If **Tap for sound** shows on the video, tap it: some phones, Android ones in particular, only let a film start without sound until you tap.',
                'On Windows, the film\'s sound goes to the output Discord has in the Windows volume mixer, not the one picked in Discord\'s **Voice & Video** settings. If your Windows default output is one you do not listen to (a virtual audio cable, say), open **Settings**, **System**, **Sound**, **Volume mixer**, find Discord and set its output device and volume.',
                'On a phone, turn up the media volume with the volume buttons while the film plays. The player\'s **Can\'t hear anything?** line says the same.',
            ],
        },
        {
            title: 'Stopping',
            text: [
                'The host\'s **Stop for everyone** ends the film, and `/movie stop` does the same from chat. When everyone has left the Activity, it ends by itself after two minutes.',
                'If the host leaves, whoever has been watching longest becomes host after a minute.',
            ],
            command: '/movie stop',
        },
    ],
    notes: [
        'What your server plays is your server\'s responsibility: show only films and shows you have the right to show to the people in it.',
        'Films stream from the CertiFried film library through certifriedmultitool.com, and only a few play at once across every server. If they are all in use, Watch Together says so; try again when one finishes.',
        'Picture subtitles (the kind on Blu-ray discs) can only be drawn into the video, so the host picks them for everyone. Text subtitles are each person\'s own choice.',
        'Watch Together works in Discord on Windows, macOS, Linux, the web, iOS and Android.',
    ],
    related: ['music', 'greenhouse'],
};
