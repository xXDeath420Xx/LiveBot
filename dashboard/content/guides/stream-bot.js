// Checked against: dashboard/routes/stream-bot.js and views/stream-bot/*.ejs (pages, Test and Dry run, tip sources, settings),
// dashboard/routes/auth-twitch-streambot.js (the grant), dashboard/routes/stream-connect.js (?for=bot), core/stream-bot/scopes.js
// (scopes and what needs none), actions.js (actions, queueSeconds default 120, 25 steps), engine.js, conditions.js (cooldown per
// person), live.js (Kick chat needs Kick Defender), migrations/454_stream_bot.js (retention), commands/community/throne-handler.js.
// Song requests: routes/stream-bot-music.js, core/stream-bot/music (text.js commands, settings.js, player.js VOD gate), migration 457.
// Phase 2 (CertiFried Studio): routes/downloads.js (/downloads/studio), the Devices and Sounds pages, core/stream-bot/sounds.js
// (5 MB, 50 sounds, 100 MB), studio.js (OBS events, run from Studio), the Studio app in desktop/studio.
// Stream actions and timers (2026-11-19): actions.js (stream.*, chat.clear/delete, if, args.set; platforms), stream-actions.js,
// helix.js, kick-api.js (channel:write), stream-info.js (60 s), render.js ({stream.*}, {args.*}, {clip.url}), counters.js (depth 3),
// events.js (bits.used, variable.changed, studio.connected), scopes.js (REAPPROVE), timers.js and routes/stream-bot-timers.js.
// Overlays (Phase 3): routes/stream-bot-overlays.js, core/stream-bot/overlays (config.js kinds, alert types, limits; media.js 10 MB,
// 30 files; service.js queue, read aloud with Piper; actions.js), views/stream-bot/overlay*.ejs, Studio obs-overlays.js (0.2.5).
export default {
    slug: 'stream-bot',
    title: 'Stream bot: automations for your Twitch and Kick channels',
    area: 'streams',
    summary: 'Link your own channels and let follows, subs, cheers, raids, chat commands and tips run actions: chat replies, Discord posts, counters and webhooks.',
    result: {
        image: 'stream-bot-overview',
        caption: 'The Stream bot overview: your linked channels, today\'s events and the live feed.',
    },
    before: [
        'The stream bot belongs to you, not to a Discord server. Log in with Discord and open **Stream bot** from the account menu, or go to [/stream/bot](/stream/bot).',
        'You need a Twitch or Kick channel you can sign in to. A channel can be linked to one CertiFried account only.',
    ],
    steps: [
        {
            title: 'Connect Twitch',
            text: [
                'On **Connections**, choose **Connect Twitch** and approve the Stream bot grant. It covers follows, subs, bits, channel points, hype trains, polls, predictions, ad breaks and chat for your channel, plus stream management (title and category, raids, ads, clips, polls, predictions, announcements, shoutouts and clearing chat); the page lists each one. It never asks for who you follow or for your earnings.',
                'When Twitch sends you back, your channel is linked. Going live, going offline and raids need no extra permission.',
                'If you connected Twitch before clearing chat, deleting messages and shoutouts were added, Connections says **Re-approve to enable** with what is missing. Choose **Re-approve on Twitch** once; Twitch shows the same screen with them included.',
            ],
            image: 'stream-bot-connections',
        },
        {
            title: 'Link Kick (optional)',
            text: [
                'Choose **Sign in with Kick**. Your Kick channel is linked and subscribed to Kick\'s events. Chat replies on Kick are sent through [Kick Defender](/kick), so turn it on for that channel if you want them.',
            ],
        },
        {
            title: 'Add tip services (optional)',
            text: [
                'Under **Tip services**, add StreamElements or Streamlabs with your own token, Ko-fi or Fourthwall through a Discord server you manage where it is set up, Throne after `/creator throne link`, or Buy Me a Coffee after linking it on the [Buy Me a Coffee page](/buymeacoffee). Tips, memberships and orders then arrive as events. CertiFried only reads the notifications; it never handles money.',
            ],
        },
        {
            title: 'Make an automation: thank followers in chat',
            text: [
                'On **Automations**, choose **New automation**. Name it, set **When** to **Follow**, and under **Then** add **Send a chat message** with `Thanks for the follow, {user.name}!`.',
                'Add a **Cooldown** condition counted for each person, for example 3600 seconds, so someone who unfollows and follows again within the hour is thanked once. Choose **Save**.',
                'Other actions post in a channel of a Discord server you manage, wait, set or add to a counter, send a webhook to a host on your allow-list, run another automation, or pick one of several choices at random. The variable list below the editor shows every `{...}` you can use in a message.',
            ],
            image: 'stream-bot-editor',
        },
        {
            title: 'Test it',
            text: [
                'Under **Test**, leave **Dry run** on and choose **Test**: a made-up follow runs through the saved automation and each action shows what it would do, without sending anything. Turn **Dry run** off to send for real.',
                'Every run, tests included, is in **Run history** with each condition it checked and what each action did.',
            ],
        },
        {
            title: 'Run your stream from an automation',
            text: [
                'Under **Then**, the **Stream**, **Polls and predictions** and **Chat** groups change the title or the category (found by name, such as `Just Chatting`), create a clip, run an ad, start a raid, start or end a poll or a prediction, send a chat announcement in a colour, shout out a channel, clear chat, or delete the message that started the run.',
                'Actions marked **Twitch only** work on your Twitch channel through the Stream bot grant; Kick has no way to do them. On Kick, changing the title or category needs your Kick sign-in to include the `channel:write` permission, and deleting a message goes through Kick Defender. A shoutout on Kick posts the same line as the bot\'s `!so` command.',
                'The link of a new clip is there for later actions in the same run as `{clip.url}`, for example in a chat message.',
            ],
            image: 'stream-bot-editor-flow',
        },
        {
            title: 'Branch, and pass values between actions',
            text: [
                '**If ... then ... otherwise** checks the viewer\'s role, the amount, the message or an event detail, and runs one of two lists of actions. For an event detail, **is one of** takes several values separated by `|`, such as the OBS scenes `START|BRB|Stream Ending`.',
                '**Set an argument for later steps** keeps a value for the rest of the run. Call it `topic` and later actions can use `{args.topic}`; an If can check it as the detail `args.topic`. An automation started with **Run another automation** gets the arguments too.',
                'Messages can show your stream as it is now: `{stream.title}`, `{stream.category}`, `{stream.uptime}` and `{stream.viewers}`, read from Twitch or Kick and at most a minute old.',
            ],
        },
        {
            title: 'Power-ups, counters and Studio as triggers',
            text: [
                '**Power-up or Bits used** starts on any use of Bits on Twitch, cheers included, or only on one kind: a message effect, a celebration or a giant emote. Add an **Amount range** condition to react only to bigger ones. `{powerup}` says which one was used.',
                '**Counter or variable changed** starts when one of your stored values changes, for example a deaths counter that `{sdb:incr:deaths}` adds to. `{counter.name}`, `{counter.value}` and `{counter.old}` say what changed. If an automation like this changes the value again, it runs at most three times in a row.',
                '**CertiFried Studio connected** starts when Studio connects to your account, for example to set up your scenes before you go live.',
            ],
        },
        {
            title: 'Timers',
            text: [
                'On **Timers**, choose **Add a timer** for a message the bot posts every so many minutes in your Twitch chat, your Kick chat or both. On Twitch it comes from the CertiFried bot account; on Kick it goes through Kick Defender.',
                'Put several messages on separate lines and they take turns, or come in random order. **Only while live** and **Only after this many chat lines** hold a timer back until they are met, so it does not post into an empty chat. A timer can run one of your automations instead of posting a message.',
                'Timers you made on the Kick channel page are listed too and can use the same options. The chat line count starts again when CertiFried restarts.',
            ],
            image: 'stream-bot-timers',
        },
        {
            title: 'Install CertiFried Studio',
            text: [
                'OBS, sound and hotkey actions are carried out by CertiFried Studio, a free Windows app for your streaming PC. Download it from [Download CertiFried Studio](/downloads/studio): the installer updates itself; the portable app runs from any folder.',
                'Studio is not code-signed, so the first time you open it Windows SmartScreen shows **Windows protected your PC**. Click **More info**, then click **Run anyway**. The download page lists the SHA-256 of each file if you want to check it.',
            ],
        },
        {
            title: 'Pair Studio with your account',
            text: [
                'In Studio, choose **Sign in with CertiFried**. Your browser opens on certifriedmultitool.com; sign in if asked, check that the page shows the same four-character code as Studio, and choose **Approve**. Studio connects a moment later. The request works once and for 10 minutes.',
                'Or use a pairing code: on **Devices**, choose **Make a pairing code**, then type it into Studio under **Use a pairing code instead**, or choose **Open in CertiFried Studio** next to the code on the same PC.',
                'Studio then shows **Connected** and stays signed in. It reconnects by itself after a restart or a dropped connection. To remove it, choose **Revoke** on **Devices**.',
            ],
            image: 'studio-status',
        },
        {
            title: 'Connect OBS',
            text: [
                'In Studio, open **Settings** and choose **Use my OBS settings** under **OBS**. Studio reads the port and password from OBS on the same PC and connects; it only reads them when you click. If OBS asks Studio for a password, Studio offers the same button on its **Status** page.',
                'If Studio says the WebSocket server is off: in OBS open **Tools**, then **WebSocket Server Settings**, tick **Enable WebSocket server** and choose **Apply**. To enter things by hand instead, choose **Show Connect Info** there, type the port and password into Studio (it starts with `127.0.0.1` and port `4455`) and choose **Save and connect**. Studio keeps the password encrypted on your PC. If the Windows password protection is not working (it can stop after some Windows updates until a restart), Studio uses a key kept in your Windows profile instead and switches back by itself later; that key protects against other programs on the PC, but less well against someone who copies the whole disk.',
                'Once connected, the automation editor offers your OBS scenes, sources, audio sources and filters as suggestions. Actions can switch scenes, show or hide sources, mute audio, set volume, turn filters on or off, start or stop streaming, recording, the replay buffer and the virtual camera, take a screenshot, change text and browser sources, and trigger an OBS hotkey by name. OBS events such as **OBS: scene changed** or **OBS: stream started** can also start automations.',
            ],
        },
        {
            title: 'Sounds',
            text: [
                'Upload sounds on the **Sounds** tab (MP3, WAV, OGG, M4A or WebM, up to 5 MB each). Studio copies them to your PC. In a **Play a sound** action, type the sound\'s name.',
                'Studio also plays files you put in its own sounds folder (**Sounds**, **Open folder** in Studio), and https links. Pick the output device in Studio, for example a virtual cable that OBS captures. Choose **Play at the same time** or **Play after it** on the action, and use **Stop all sounds** to cut them off.',
            ],
        },
        {
            title: 'Hotkeys',
            text: [
                'In Studio, open **Hotkeys** and press a key combination, then pick what it does: run one of your automations now, or a local action such as stopping all sounds. A hotkey run skips the automation\'s trigger and conditions and shows in **Run history** as started by CertiFried Studio.',
                'The **Press a hotkey** action does the reverse: the dashboard tells Studio to press keys on your PC, for example to drive another app.',
            ],
            image: 'studio-hotkeys',
        },
        {
            title: 'Set up OBS with Studio',
            text: [
                'In Studio, open **Set up OBS**. Each step says what it changes and runs only when you click it.',
                '**Add CertiFried docks** puts three panels into OBS: Activity (your live events), Controls (run automations, see counters) and Chat (Twitch and Kick chat, read-only). OBS must be closed for this step, because OBS rewrites its settings when it exits; Studio backs up the settings file first and keeps your other docks. If you prefer, copy the three addresses and add them yourself under **Docks**, **Custom Browser Docks** in OBS. Each dock address carries a key that can only show your feed and run your automations; replace it from Studio or revoke it on **Devices**.',
                '**Install the CertiFried theme** copies the theme into OBS. Choose it yourself in OBS under **Settings**, **Appearance**. **Add starter scenes** creates Starting Soon, Be Right Back and Ending scenes if you do not have them.',
            ],
        },
        {
            title: 'Overlays: alerts, chat, goals and counters',
            text: [
                'Open the **Overlays** tab and add an overlay: an **Alert box**, **Chat** (Twitch and Kick together), **Recent events**, a **Goal bar**, a **Counter**, **Now playing** (the song request playing, as the music player shows it) or **Text and media** (an empty layer for automations). You can have several of each, up to 20.',
                'Each overlay has its own private address. Anyone with it can see the overlay, so keep it to OBS; **New address** on the overlay\'s page stops the old one at once. Overlays are 1920 × 1080 with a transparent background and load nothing from other sites, so they work the same on every PC.',
                'Chat shows badges and emotes and drops a message as soon as a moderator deletes it, times the viewer out or bans them (on Kick: when they are banned). Goals count follows, subs, Bits or tips from your events as they arrive, or you set them by hand. A counter shows a stream bot value, such as the `deaths` counter an imported Firebot `!death` command adds to, the moment it changes.',
            ],
            image: 'stream-bot-overlays',
        },
        {
            title: 'Style your alerts',
            text: [
                'On the alert box\'s page, each kind of alert has its own settings: Twitch follows, subs (by tier), resubs (by months), gift subs (by count), Bits, raids (by viewers), channel points, power-ups, tips from your tip services, hype trains, and Kick follows, subs and gifts. Pick the wording (variables such as `{user.name}` and `{amount}` work), a second line, whether to show the viewer\'s message, the layout, an image or video from **Images and videos**, a sound from the **Sounds** tab, and how long it stays.',
                '**Variations** show something else for bigger moments, for example a different image and sound from 1,000 Bits. The highest one reached wins. Alerts wait their turn and never overlap.',
                'For Bits and tips, **Read the message aloud** speaks the viewer\'s message with one of CertiFried\'s voices after the alert sound, from the amount you choose. Links are read as "a link".',
                'The **Test** buttons show an invented alert wherever the overlay is open, in OBS and in the preview on the page; type an amount first to try a variation.',
            ],
            image: 'stream-bot-overlay-alerts',
        },
        {
            title: 'Put overlays in OBS',
            text: [
                'In CertiFried Studio open **Set up OBS**, then **CertiFried overlays**, and choose **Show my overlays**. Each overlay says what its button will do, then **Add to scene** adds it to the scene on air as a browser source named after its kind (**CertiFried Alerts**, **CertiFried Chat** and so on). If you made a new address on the dashboard, the button updates the source instead.',
                'To add one by hand, add a **Browser** source in OBS with the overlay\'s address, width 1920 and height 1080.',
                'Alert sounds, videos and read-aloud messages play inside the browser source, so OBS decides where they go. Studio turns on **Control audio via OBS** for you; in **Advanced Audio Properties** you choose the source\'s tracks, for example to keep alert sounds off your Twitch VOD track. Studio\'s VOD check lists CertiFried Alerts with a **Keep out of VOD** button.',
            ],
            image: 'stream-bot-overlay-live',
        },
        {
            title: 'Show text and images from automations',
            text: [
                'Two actions put things on screen from any automation: **Show text on stream** (with variables, such as `Deaths: {sdb:get:deaths}`) and **Show an image or video on stream** (a file from Images and videos). Choose the overlay, where on screen, the size, how long and the animation. Without a chosen overlay they go to your Text and media overlay, or the alert box if you have none.',
                '**Change a goal** adds to or sets a goal bar, for example from a channel points reward. While no overlay is open in OBS these actions are marked **Needs an overlay** and wait like Studio actions do.',
            ],
        },
        {
            title: 'Voice commands',
            text: [
                'On **Automations**, pick the **Voice command** trigger and list the phrases that start it, one per line.',
                'In Studio, open **Voice**, turn the microphone on, pick the input device, and choose always listening or push-to-talk. Studio recognises your phrases on your PC with the speech recognition built into Windows; no audio is stored or leaves your PC, only the phrase it heard. Raise the confidence setting if it starts on the wrong words.',
            ],
        },
        {
            title: 'Song requests',
            text: [
                'Open the **Music** tab. Viewers request songs in Twitch or Kick chat with `!sr` and a song name or a Spotify, YouTube, YouTube Music or SoundCloud link; CertiFried finds the song through its own music service, so no Spotify app or Premium account is needed. Choose **Add commands** to create `!sr`, `!skip`, `!queue`, `!voteskip` and the rest as automations you can switch on, rename or give a cooldown on **Automations**.',
                'The music plays only in OBS, in the **CertiFried Music** browser source that CertiFried Studio adds for you, and only while Studio has kept it off your Twitch VOD track. Until then chat is told requests are paused. The Music page shows the player link if you prefer to add the source yourself.',
                'Under **Settings** on the Music page choose which requests need a moderator (`!pending`, `!approve`, `!deny`), how many songs each viewer may have waiting, the longest song, the votes `!voteskip` needs, and where requests may come from: only your own playlists or only SoundCloud, for example. Import a Spotify, YouTube or SoundCloud playlist to play when nobody has requested anything. Ban songs or artists there or with `!banSong`. Playing copyrighted music on stream can still lead to takedowns.',
                'If your Spotify is linked (Premium), turn on **Play Spotify requests with my Spotify** to play real Spotify audio instead of the YouTube Music match. Your Spotify plays in one place at a time: while requests play from it, your own Spotify app stops, and if the CertiFried music bot is using it in Discord that song plays from YouTube Music. Spotify\'s terms do not allow broadcasting its audio, so the choice is yours.',
                'The **Song changed** trigger and `{music.track}`, `{music.artist}`, `{music.url}` and `{music.requester}` let other automations react to the music, for example to update a text source in OBS.',
            ],
        },
        {
            title: 'Keep song requests out of your VODs',
            text: [
                'Studio plays song requests only through a CertiFried Music source in OBS and keeps that source off your Twitch VOD track, so viewers hear the music live but it is not saved in the VOD. This is always on. Studio turns on the Twitch VOD track in your OBS profile if it is off (only while you are not live, after saving a copy of the profile), and pauses music if you are live without it.',
                'The **Status** page in Studio lists other sources on the VOD track that look like music or sound effects, with a **Keep out of VOD** button for each; Studio never changes them unless you click. Desktop Audio on the VOD track means anything playing on your PC is saved.',
                'Some things it cannot cover: Twitch clips are cut from the live stream, so they contain the music. Kick has no VOD track, so music Kick receives live is in its VODs; with the obs-multi-rtmp plugin, give the Kick target its own audio encoder on the VOD track to keep music off Kick. Local recordings include the music unless you turn on **Record without music** in Studio.',
            ],
        },
    ],
    notes: [
        'Actions for OBS, sounds and hotkeys are carried out by CertiFried Studio, and the overlay actions by an overlay open in OBS. Lights come in a later update. While no device of the right kind is connected, these actions are marked **Needs CertiFried Studio** or **Needs an overlay** and wait for one for 2 minutes (or the time you set on the action) before they expire. Each action Studio carries out is reported back to **Run history**.',
        'Chat messages run automations and show in the live feed, but are only kept in the event log if you turn on **Keep chat in the event log** in the Connections settings.',
        'Events are kept for 90 days and runs for 30 days. You can have up to 200 automations with up to 25 actions each.',
        'Song requests are kept for a year and viewers\' likes for 400 days; `!topSongs` and `!myTopSongs` count from them. Deleting your data removes the songs you requested from other streamers\' lists by name.',
        'The stream bot is part of [your data](/privacy): exporting includes it and deleting removes it.',
        'What CertiFried Studio keeps on your PC and sends to CertiFried is listed on [Studio privacy](/studio/privacy); it has no analytics or telemetry, and microphone audio never leaves your PC. [How Studio works](/studio/how-it-works) explains what runs where and what Studio changes in OBS, and the [Studio questions](/studio/faq) cover SmartScreen and antivirus warnings.',
    ],
    related: ['go-live-alerts', 'kick-defender', 'schedules'],
};
