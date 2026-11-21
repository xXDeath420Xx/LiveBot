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
// Viewers (H-747): routes/stream-bot-viewers.js, core/stream-bot/viewers (settings.js periods and limits, service.js 5-minute sample,
// 10-minute active chatters, Kick has no viewer list, commands; seed.js six commands off; register.js actions, conditions, variables),
// scopes.js (moderator:read:chatters), import/apply.js importViewers (400-day cut), migrations/464_stream_bot_viewers.js (retention).
// YouTube Live (H-741): routes/stream-connect.js (?for=bot, youtube.force-ssl), core/stream-bot/youtube (config.js switch and scope,
// service.js 10-minute check and hints, streamList chat, quota.js levels, register.js chat.timeout / chat.ban), migration 470.
export default {
    slug: 'stream-bot',
    title: 'Stream bot: automations for your Twitch, Kick and YouTube channels',
    area: 'streams',
    summary: 'Link your own channels and let follows, subs, cheers, raids, chat commands and tips run actions: chat replies, Discord posts, counters and webhooks.',
    result: {
        image: 'stream-bot-overview',
        caption: 'The Stream bot overview: your linked channels, today\'s events and the live feed.',
    },
    before: [
        'The stream bot belongs to you, not to a Discord server. Log in with Discord and open **Stream bot** from the account menu, or go to [/stream/bot](/stream/bot).',
        'You need a Twitch, Kick or YouTube channel you can sign in to. A channel can be linked to one CertiFried account only.',
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
            title: 'Link YouTube (optional)',
            text: [
                'Under **Add a channel**, choose **Link YouTube** and sign in with the Google account that owns the channel. CertiFried asks Google for one permission, to manage your YouTube chat, and uses it to find your live broadcast, read its chat, and send, delete, time out or ban when an automation says so. If the button says **Not available yet**, YouTube is not switched on for CertiFried yet; **In review with Google** means linking is paused while Google reviews CertiFried and will open after approval.',
                'YouTube viewers do not earn or spend points. YouTube\'s API rules do not allow rewards for subscribing, joining or chatting, so points, the loyalty store, raffles, points games and media share are for Twitch and Kick. Alerts, thank-you messages and the viewer record still work on YouTube, and data that came from YouTube is deleted after 30 days.',
                'A YouTube chat exists only while you are live. CertiFried looks for a live broadcast every 10 minutes, and at once when you go live on Twitch or Kick or start streaming from CertiFried Studio; **Look for a live broadcast now** on your YouTube channel checks straight away.',
                'YouTube events use the same triggers as Twitch and Kick: **Chat message** (with the YouTube viewer\'s first line of a broadcast marked, so `firstWords` in a Metadata condition gives you first-time greetings), **Tip or Super Chat** for Super Chats, Super Stickers and Jewels (tracked, never processed), **Membership** for new members, milestones and gifted memberships, **Gift subs** for someone gifting memberships, and **Stream went live** and **Stream ended**. Add YouTube to a trigger\'s platforms to use them.',
                'Google gives CertiFried a daily allowance for YouTube that all streamers share. Your YouTube channel on **Connections** shows how much is used today; when it runs low, chat is read in bursts, and bans and time-outs (the most expensive calls) wait until it resets at midnight Pacific time.',
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
            title: 'Viewers and points',
            text: [
                'The **Viewers** tab lists everyone who watched or chatted on your linked channels: how long they watched, how many messages they sent, their points and their rank. Search by name, show one platform or a time range, sort by any column, open a viewer, or download everything with **Export CSV**.',
                'Watch time is counted every 5 minutes while you are live. On Twitch it counts everyone in your chat, lurkers too, once the Stream bot grant includes the chatters list: if you connected Twitch before, Connections says **Re-approve to enable** and lists **Watch time for viewers who do not chat**. Until then, and on Kick and YouTube, which have no list of viewers, it counts people who chatted in the last 10 minutes. YouTube viewers get watch time and messages but no points.',
                'On a viewer\'s page you can add, remove or set their points with a note, see their subs, gift subs, Bits and tips, and read the history of bonuses, gifts, gambles and rank-ups. If the same person watches on Twitch and Kick, link the two accounts there: their points are added together. Only you can link accounts. A YouTube account can be linked too, but it holds no points.',
            ],
            image: 'stream-bot-viewers',
        },
        {
            title: 'Points, ranks and the chat commands',
            text: [
                'Open **Viewers**, **Settings** to name your points (a one-word name such as coins also answers to `!coins`), choose how many viewers earn for watching and how often, give subscribers more, and set bonuses for follows, subs, each gifted sub, every 100 Bits and raids. Points are a tally for fun: nobody can buy them and CertiFried never handles money.',
                'Add ranks by hours watched or by points. When a viewer reaches a new rank, the **Viewer reached a new rank** trigger starts, with `{rank.name}` and `{rank.previous}`, so an automation can congratulate them.',
                'Choose **Add the chat commands** to create `!points`, `!top`, `!give`, `!gamble`, `!addpoints` and `!removepoints` as automations, switched off. Turn on the ones you want on **Automations**. `!addpoints` and `!removepoints` are for moderators and you; gambling also has to be turned on in the settings.',
                'Any automation can use `{user.points}`, `{user.watchtime}`, `{user.messages}`, `{user.rank}` and `{points.name}`, the conditions **Has at least N points**, **Watch time at least** and **Message count at least**, and the actions **Give points to a viewer**, **Take points from a viewer** and **Set a viewer\'s points**, for example to make a channel point reward or a command cost points. Give and Set are skipped for YouTube viewers, and an import leaves them out of automations that only YouTube starts.',
                'Coming from Firebot or Streamer.bot? On **Import**, tick **Viewer stats**: Firebot brings watch time, messages, points and its currency and rank settings; Streamer.bot brings names and when it last saw each viewer. Importing again does not count anything twice. Viewers neither program has seen for over 400 days are left out, because records that old are deleted.',
            ],
            image: 'stream-bot-viewers-settings',
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
                'Open the **Overlays** tab and add an overlay: an **Alert box**, **Chat** (Twitch and Kick together), **Recent events**, a **Goal bar**, a **Counter**, **Now playing** (the song request playing, as the music player shows it), **Text and media** (an empty layer for automations) or a **Scene screen** (a full-screen starting soon, be right back, chatting or ending screen with your artwork, a title, a scrolling line, a countdown, glows, embers, rain and fog). You can have several of each, up to 20.',
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
            title: 'Switching over from Firebot or Streamer.bot',
            text: [
                'Everything you import arrives switched off, so your old bot and CertiFried never both answer chat. When the import looks right, open **Import** and choose **Review the switchover**, or go straight to [Switch over](/stream/bot/import/switchover). The page reads your setup fresh and lists what one click will do before anything changes.',
                'It turns on your imported automations, chat commands and timers, and your song request commands. Anything you changed after the import, and anything already on, is left as it is. Items that need a look stay off unless you tick them, with the reason: for example an automation that stops your stream, an image that is not in your overlay media yet, an OBS source that no longer exists, or a voice phrase that had to be guessed.',
                'In OBS, through CertiFried Studio, each CertiFried overlay source is shown where the source it replaces is showing, and the old one is hidden. Sound Alerts and Blerp are never touched. To get CertiFried sources next to your old ones, Studio 0.2.7 adds them hidden, in the same scenes and with the same position, size and crop, so switching is only show and hide. Tick **Close Firebot and Streamer.bot** to have Studio ask them to close (it never closes OBS), or quit them yourself from the Windows tray.',
                '**Undo the last switchover** turns off exactly what it turned on and puts every OBS source back as it was. Apps it closed are not reopened. Switch over before you go live; Studio refuses to add sources while OBS is streaming or recording.',
            ],
        },
        {
            title: 'Lights',
            text: [
                'In CertiFried Studio open **Lights** and choose **Find lights**. Studio looks on your network for Govee lights (switch on **LAN Control** for each one in the Govee Home app first), Philips Hue bridges, LIFX, Nanoleaf panels and Elgato Key Light and Light Strip, and on USB for Logitech Litra Glow, Beam and Beam LX. It only searches after you choose Find lights, then each time it starts.',
                'A Hue bridge needs pairing once: choose **Pair** and press the round button on the bridge within 30 seconds. A Nanoleaf: choose **Pair**, then hold its power button for 5 to 7 seconds until the lights flash. **Test** flashes a light in CertiFried green. A light Studio did not find can be added by its address.',
                'Govee and LIFX can also work through their cloud, without Studio: on **Devices**, under **Lights**, paste your Govee API key (Govee Home app, Profile, Settings, Apply for API key) or a LIFX personal access token (cloud.lifx.com). CertiFried stores it encrypted and shows only its last 4 characters. Govee allows 10 changes a minute per light, so use LAN control for fast flashing.',
            ],
            image: 'stream-bot-devices',
        },
        {
            title: 'Light actions and presets',
            text: [
                'In an automation, the **Lights** actions set a colour and brightness, set a white (warm 2700 K to daylight 5600 K), change brightness, turn lights on or off, start a scene or effect the light has (Hue scenes, Nanoleaf effects, Govee and LIFX cloud scenes), and **Flash a light, then put it back**. Leave **Light** on **All lights**, or pick one. Give any of them a **For (ms)** to change the light for a while and then put it back as it was.',
                '**Set a light to a colour from text** takes the colour from a variable, so `!color` can work for viewers: use `{arg1}` and it accepts `#ff8800`, colour names such as `tomato`, or a white such as `3200K`; anything else fails the step instead of guessing.',
                'Under **Light presets** on **Devices**, save how several lights should look, such as **Live** or **Be right back**, and use **Apply a light preset** in automations or on a Stream Deck key.',
            ],
        },
        {
            title: 'Voicemeeter',
            text: [
                'In Studio open **Audio** and turn on **Control Voicemeeter from CertiFried**. Studio finds Voicemeeter, Banana or Potato and shows its strips and buses with their names. It never starts Voicemeeter for you.',
                'The **Voicemeeter** actions mute or unmute a strip or bus, set or raise and lower its gain (with an optional fade), load a settings file you saved in Voicemeeter into `Documents\\Voicemeeter`, and press a Macro Buttons button.',
            ],
        },
        {
            title: 'Stream Deck',
            text: [
                'In Studio open **Settings**, turn on **Stream Deck**, and choose **Install the Stream Deck plugin** (the Elgato Stream Deck app must be installed). The plugin is also on the [download page](/downloads/studio#stream-deck).',
                'Drag a **CertiFried** key onto your Stream Deck, choose **Copy token** in Studio and paste it into the key once. Keys can run an automation, switch scene, show or hide a source, mute an input, change a counter (the key shows its value), play a sound and apply a light preset. Scene, mute and source keys light up to show what is on. The plugin talks only to Studio on the same PC; **New token** in Studio disconnects every key until it gets the new one.',
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
                'The music plays only in OBS, in the **CertiFried Music** browser source that CertiFried Studio adds for you once a song request command is switched on, and only while Studio has kept it off your Twitch VOD track. Until then chat is told requests are paused. The Music page shows the player link if you prefer to add the source yourself.',
                'Under **Settings** on the Music page choose which requests need a moderator (`!pending`, `!approve`, `!deny`), how many songs each viewer may have waiting, the longest song, the votes `!voteskip` needs, and where requests may come from: only your own playlists or only SoundCloud, for example. Import a Spotify, YouTube or SoundCloud playlist to play when nobody has requested anything. Ban songs or artists there or with `!banSong`. Playing copyrighted music on stream can still lead to takedowns.',
                'If your Spotify is linked (Premium), turn on **Play Spotify requests with my Spotify** to play real Spotify audio instead of the YouTube Music match. Your Spotify plays in one place at a time: while requests play from it, your own Spotify app stops, and if the CertiFried music bot is using it in Discord that song plays from YouTube Music. Spotify\'s terms do not allow broadcasting its audio, so the choice is yours.',
                'The **Song changed** trigger and `{music.track}`, `{music.artist}`, `{music.url}` and `{music.requester}` let other automations react to the music, for example to update a text source in OBS.',
            ],
        },
        {
            title: 'Keep song requests out of your VODs',
            text: [
                'Studio plays song requests only through a CertiFried Music source in OBS and keeps that source off your Twitch VOD track, so viewers hear the music live but it is not saved in the VOD. It does this while a song request command is switched on: it turns on the Twitch VOD track in your OBS profile if it is off (only while you are not live, after saving a copy of the profile), and pauses music if you are live without it. If you do not use song requests, Studio changes nothing in OBS for music. Switch them off later and the source stays until you choose **Remove the CertiFried Music source** in Studio.',
                'The **Status** page in Studio lists other sources on the VOD track that look like music or sound effects, with a **Keep out of VOD** button for each; Studio never changes them unless you click. Desktop Audio on the VOD track means anything playing on your PC is saved.',
                'Some things it cannot cover: Twitch clips are cut from the live stream, so they contain the music. Kick has no VOD track, so music Kick receives live is in its VODs; with the obs-multi-rtmp plugin, give the Kick target its own audio encoder on the VOD track to keep music off Kick. Local recordings include the music unless you turn on **Record without music** in Studio.',
            ],
        },
    ],
    notes: [
        'Actions for OBS, sounds, hotkeys, lights on your network and Voicemeeter are carried out by CertiFried Studio, Govee and LIFX cloud lights by CertiFried, and the overlay actions by an overlay open in OBS. While no device of the right kind is connected, these actions are marked **Needs CertiFried Studio** or **Needs an overlay** and wait for one for 2 minutes (or the time you set on the action) before they expire. Each action Studio carries out is reported back to **Run history**.',
        'Chat messages run automations and show in the live feed, but are only kept in the event log if you turn on **Keep chat in the event log** in the Connections settings.',
        'Events are kept for 90 days and runs for 30 days. You can have up to 200 automations with up to 25 actions each.',
        'A viewer\'s record is deleted 400 days after they were last seen, and point history after 400 days. Viewers can download or delete their own records on [Your viewer data](/privacy/viewer).',
        'Song requests are kept for a year and viewers\' likes for 400 days; `!topSongs` and `!myTopSongs` count from them. Deleting your data removes the songs you requested from other streamers\' lists by name.',
        'The stream bot is part of [your data](/privacy): exporting includes it and deleting removes it.',
        'What CertiFried Studio keeps on your PC and sends to CertiFried is listed on [Studio privacy](/studio/privacy); it has no analytics or telemetry, and microphone audio never leaves your PC. [How Studio works](/studio/how-it-works) explains what runs where and what Studio changes in OBS, and the [Studio questions](/studio/faq) cover SmartScreen and antivirus warnings.',
    ],
    related: ['go-live-alerts', 'kick-defender', 'schedules'],
};
