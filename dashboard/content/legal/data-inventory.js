/*
 * "Data we collect" (/legal/data), the legal hub list (/legal) and the CertiFried Studio facts the Studio pages state.
 *
 * Built from the schema and the retention table, not from memory (2026-11-19):
 *   - retention.table names a row of data_retention_policy (jobs/retention-sweeper.js deletes nightly at 04:20). The
 *     page shows the live value; `days` is the value read from the live table on 2026-11-19, used when the database
 *     cannot be read. tests/legal-studio-pages.test.js checks the stream bot rows against the migrations' RETENTION_ROWS.
 *   - retention.feature: the feature deletes the data itself (no data_retention_policy row); `text` says when.
 *   - retention.none: no time limit is set. `text` says honestly what keeps it and how it goes; open questions are
 *     register rows (docs/feature-health-register.md, H-765 to H-772).
 *   - Studio rows were checked in desktop/studio/src (config.js, local-key.js, logger.js, engine-client.js, main.js
 *     fitState, voice.js, updater.js, obs-config.js, vod-safe.js) and electron-updater 6.8.11's AppUpdater.js.
 * Text is plain; the template escapes it. `who` is who can see it, `remove` how it goes away early.
 */

/** The Studio facts the pages state; each is checked against the app's source by tests/legal-studio-pages.test.js. */
export const STUDIO_FACTS = Object.freeze({
    windows: 'Windows 10 or 11, 64-bit',
    obsWebsocket: '28',            // obs-websocket 5 ships inside OBS from 28.0
    obsDocks: '30',                // custom browser docks in user.ini (31+) or global.ini (30): obs-docks.js
    obsTheme: '30.2',              // variant themes (.ovt): obs-setup.js, design §5.10
    obsPort: 4455,                 // config.js DEFAULTS.obs.port
    dataDir: '%APPDATA%\\CertiFried Studio',
    screenshotsDir: 'Pictures\\CertiFried Studio',
    logMb: 1,                      // logger.js maxBytes
    logKeep: 5,                    // logger.js keep
    updateHours: 6,                // updater.js start(everyMs)
    deviceName: 'CertiFried Studio on <your PC name>',   // main.js defaultDeviceName()
    githubRepo: 'https://github.com/xXDeath420Xx/LiveBot',
    license: 'https://github.com/xXDeath420Xx/LiveBot/blob/dev/LICENSE',
    licenseName: 'GNU AGPL-3.0-or-later',
    dbad: 'https://github.com/xXDeath420Xx/LiveBot/blob/dev/DBAD.md',
});

/** Every policy, for /legal. `updated` is the date shown on the document. */
export const LEGAL_DOCS = Object.freeze([
    { href: '/terms', title: 'Terms of Service', updated: '2026-11-19', text: 'The rules for using CertiFried: the Discord bot, the dashboard, the stream bot, CertiFried Studio, song requests and Greenhouse Tycoon. Includes the $100 liability cap and how disputes are handled.' },
    { href: '/privacy', title: 'Privacy Policy', updated: '2026-11-19', text: 'What we collect, why, who we share it with, how long we keep it, and how to export or delete it.' },
    { href: '/legal/data', title: 'Data we collect', updated: '2026-11-19', text: 'The same, as one table per product: each kind of data, why we keep it, where, for how long, who can see it and how to remove it.' },
    { href: '/eula', title: 'End User License Agreement', updated: '2026-11-19', text: 'How the AGPL licence on the source code relates to using our hosted service and the CertiFried Studio builds we publish.' },
    { href: '/studio/privacy', title: 'CertiFried Studio privacy', updated: '2026-11-19', text: 'Exactly what the Windows app keeps on your PC, what it sends to CertiFried, and what never leaves your PC.' },
    { href: STUDIO_FACTS.license, title: 'GNU AGPL-3.0-or-later', updated: null, text: 'The licence for CertiFried\'s source code, Studio included. It is the binding one.' },
    { href: STUDIO_FACTS.dbad, title: 'Don\'t Be a Dick note', updated: null, text: 'A short, non-binding request from the author about using the code. The AGPL is what binds.' },
    { href: STUDIO_FACTS.githubRepo, title: 'Source code', updated: null, text: 'The full source of the bot, the dashboard, the stream bot and Studio. The AGPL asks us to offer it to everyone who uses the hosted service.' },
]);

const P = (table, days, after = '') => ({ table, days, after });          // data_retention_policy row
const F = (text) => ({ feature: true, text });                             // the feature deletes it
const N = (text) => ({ none: true, text });                                // no time limit set

const YOU_SUPPORT = 'You. CertiFried\'s operators when handling support.';
const STAFF = 'That server\'s staff, and CertiFried\'s operators when handling support.';
const PRIVACY_DELETE = '/privacy delete';

export const CATEGORIES = Object.freeze([
    {
        id: 'website',
        title: 'Website and dashboard',
        intro: 'Signing in with Discord and using certifriedmultitool.com.',
        rows: [
            { data: 'Discord sign-in: your user ID, username, avatar and the list of servers you are in', purpose: 'Sign you in and show the servers you can manage', where: 'Our database (session store)', retention: F('7 days, then the session expires'), who: 'You', remove: 'Sign out; the session is deleted when it expires' },
            { data: 'IP address and browser user agent of a session', purpose: 'Security monitoring and rate limits', where: 'Our database (session store) and our server\'s memory', retention: F('With the session (7 days)'), who: 'CertiFried\'s operators', remove: 'Expires with the session' },
            { data: 'Web requests to the site (IP address, page, time, browser)', purpose: 'Deliver and protect the site. All traffic passes through Cloudflare', where: 'Cloudflare, and our web server\'s logs', retention: N('Not set by CertiFried: Cloudflare and the web server keep request logs under their own settings'), who: 'Cloudflare; CertiFried\'s operators', remove: 'Ask us (see Contact on the Privacy Policy)' },
            { data: 'Your site preferences (theme, layout, pinned pages)', purpose: 'Remember how you like the site', where: 'Our database; signed out, only your browser\'s storage', retention: N('Kept until you change them'), who: 'You', remove: PRIVACY_DELETE },
            { data: 'Application and error logs', purpose: 'Find and fix faults', where: 'Our server', retention: F('30 days'), who: 'CertiFried\'s operators', remove: 'Deleted after 30 days' },
        ],
    },
    {
        id: 'discord-bot',
        title: 'Discord bot',
        intro: 'What the bot keeps about members of servers it is in. Each server\'s staff choose which features are on.',
        rows: [
            { data: 'Server settings, channel and role IDs', purpose: 'Run the features a server turned on', where: 'Our database', retention: N('Kept while the bot is in the server; removed after the bot leaves'), who: STAFF, remove: 'Remove the bot from the server' },
            { data: 'Copies of messages (for edited and deleted message logs)', purpose: 'Moderation context in servers that log messages', where: 'Our database', retention: P('message_logs', 90, '(a server can choose less)'), who: STAFF, remove: '/privacy opt-out stops it; /privacy delete removes your cached copies' },
            { data: 'Moderation and audit logs', purpose: 'Moderation evidence', where: 'Our database', retention: P('audit_logs', 365, '(a server can choose less)'), who: STAFF, remove: 'Kept for safety; ask that server\'s staff' },
            { data: 'Moderation records (warnings, bans, kicks, mutes)', purpose: 'Let moderators see repeat offences', where: 'Our database', retention: P('infractions', 730, '(warnings after one year)'), who: STAFF, remove: 'Not removed by /privacy delete; ask that server\'s staff' },
            { data: 'Support tickets, form answers and transcripts', purpose: 'Support in a server', where: 'Our database (transcripts encrypted)', retention: P('tickets', 365, 'after the ticket closes'), who: STAFF, remove: 'Ask that server\'s staff' },
            { data: 'Modmail conversations', purpose: 'Private messages between you and a server\'s staff', where: 'Our database', retention: P('modmail_threads', 365, 'after the conversation closes'), who: STAFF, remove: 'Ask that server\'s staff' },
            { data: 'Activity statistics (messages and voice per day)', purpose: 'Stats, activity checks and leaderboards', where: 'Our database', retention: P('activity_logs', 180), who: STAFF, remove: PRIVACY_DELETE },
            { data: 'Invite used to join a server', purpose: 'Invite tracking', where: 'Our database', retention: P('invite_tracker_logs', 180), who: STAFF, remove: 'Kept for safety; ask that server\'s staff' },
            { data: 'Server join history', purpose: 'A server\'s rejoin limit', where: 'Our database', retention: N('Kept with no time limit so the rejoin limit can count past joins'), who: STAFF, remove: 'That server\'s staff can reset your count' },
            { data: 'Commands you ran (which, where, when, whether it worked)', purpose: 'Usage figures and fault finding', where: 'Our database', retention: P('command_usage', 400), who: 'CertiFried\'s operators; a server\'s staff see their server\'s totals', remove: PRIVACY_DELETE },
            { data: 'Levels, economy, game progress, birthdays and other things you add', purpose: 'The features themselves', where: 'Our database', retention: N('Kept until you delete them or the server removes the bot'), who: 'You; other members where a feature shows it (leaderboards)', remove: PRIVACY_DELETE },
            { data: 'Values custom commands save ({db:...}, {sdb:...})', purpose: 'A server\'s custom commands', where: 'Our database', retention: P('custom_commands_kv', 400, 'without being read or written'), who: STAFF, remove: PRIVACY_DELETE },
            { data: 'Voice transcripts (servers that turn transcription on)', purpose: 'Transcription and voice moderation', where: 'Our database; audio is processed on our own servers and not kept', retention: F('30 days, or what the server sets (1 to 365 days)'), who: STAFF, remove: '/privacy delete, or /voice privacy opt-out' },
            { data: 'Who sent an anonymous confession', purpose: 'Handle abuse of confessions', where: 'Our database', retention: P('confession_senders', 30), who: 'That server\'s admins (each reveal is logged)', remove: 'Deleted after the period' },
            { data: 'AI chat memory (recent messages used as context)', purpose: 'AI replies', where: 'Our database; text sent to Google Gemini or our own language models', retention: P('chatgpt_memory', 1, '(24 hours)'), who: 'Nobody reads it; used by the AI reply', remove: PRIVACY_DELETE },
            { data: 'Music play history in Discord (song, voice channel, who asked or skipped)', purpose: 'Music history, stats and the AI DJ', where: 'Our database', retention: P('music_play_log', 365), who: STAFF, remove: '/privacy delete removes your name from it' },
            { data: 'Your Last.fm link: your Last.fm username and, if you verified it on last.fm, the verified name and when (the Last.fm session key is never stored)', purpose: 'The /music lastfm commands, and the Dedicated Scrobbler achievement, which counts only accounts verified as yours', where: 'Our database; your username is sent to Last.fm for each lookup', retention: N('Kept until you unlink it'), who: 'You; other members can look up your Last.fm stats through the bot', remove: '/music lastfm unlink, or /privacy delete' },
            { data: 'Voice channel recordings a server\'s staff start', purpose: 'Recordings a server asked for', where: 'Our server', retention: P('voice_recordings', 365), who: STAFF, remove: 'Ask that server\'s staff' },
        ],
    },
    {
        id: 'stream-alerts',
        title: 'Stream alerts and Twitch analytics',
        intro: 'Go-live alerts for tracked streamers, and the statistics a Twitch channel can connect to a server\'s dashboard.',
        rows: [
            { data: 'Stream history of tracked streamers (start and end times)', purpose: 'Go-live alerts and recaps', where: 'Our database', retention: P('stream_uptime', 730), who: STAFF, remove: 'Ask that server\'s staff to stop tracking the channel' },
            { data: 'Per-minute stream and chatter snapshots of a connected Twitch channel', purpose: 'Twitch analytics on the dashboard', where: 'Our database', retention: P('twitch_chatters_snapshots', 90), who: 'The channel\'s owner and that server\'s staff', remove: 'Disconnect the channel; data then ages out' },
            { data: 'Chat text of a connected Twitch channel (only with chat sampling on)', purpose: 'Chat analytics', where: 'Our database', retention: P('twitch_chat_message_samples', 90), who: 'The channel\'s owner and that server\'s staff', remove: 'Turn chat sampling off' },
            { data: 'Moderator actions and held AutoMod messages of a connected channel', purpose: 'Moderation analytics', where: 'Our database', retention: P('twitch_mod_actions', 180), who: 'The channel\'s owner and that server\'s staff', remove: 'Ages out' },
            { data: 'Bits and raids of a connected channel', purpose: 'Analytics', where: 'Our database', retention: P('twitch_bits_usage', 365), who: 'The channel\'s owner and that server\'s staff', remove: 'Ages out' },
            { data: 'Historical, no longer collected: the channels a connected broadcaster\'s Twitch account followed (read once on October 28, 2026 for two broadcasters, when the analytics grant still asked for the follows list)', purpose: 'Kept at the owner\'s choice; shown read-only to that channel\'s servers on Twitch analytics. CertiFried no longer asks Twitch for the follows list', where: 'Our database', retention: P('twitch_user_follows', 30, 'after the broadcaster has no Twitch connection to CertiFried left; kept while one remains'), who: 'The channel\'s owner and that server\'s staff', remove: '/privacy delete, or sign in with Twitch on /privacy/viewer' },
        ],
    },
    {
        id: 'stream-bot',
        title: 'Stream bot (as a streamer)',
        intro: 'The stream bot belongs to your CertiFried account, not to a Discord server. Everything here goes when you delete your stream bot data with /privacy delete.',
        rows: [
            { data: 'Your stream bot profile and settings, linked Twitch, Kick and YouTube channels', purpose: 'Run your automations on your channels', where: 'Our database', retention: N('Kept until you delete it'), who: YOU_SUPPORT, remove: PRIVACY_DELETE },
            { data: 'Twitch Stream bot grant (access and refresh tokens, scopes)', purpose: 'Read your channel\'s events and act on it (title, clips, polls and so on). No follows-list or revenue scopes', where: 'Our database, encrypted (AES-256-GCM)', retention: N('Kept until you disconnect or delete your data'), who: 'Nobody: never shown or exported', remove: 'Disconnect at twitch.tv/settings/connections, or /privacy delete' },
            { data: 'YouTube sign-in for the channel you linked (Google access and refresh tokens, and the one permission asked for: manage your YouTube chat, youtube.force-ssl)', purpose: 'Find your live broadcast, read its chat, Super Chats, Super Stickers, Jewels and memberships, and send, delete, time out or ban in your chat when your automations say so. CertiFried never handles money', where: 'Our database, encrypted (AES-256-GCM); the same record a YouTube multicast connection uses', retention: N('Kept until you unlink the YouTube channel (when no multicast destination uses the sign-in), remove CertiFried at myaccount.google.com/permissions, or delete your data'), who: 'Nobody: never shown or exported', remove: 'Unlink YouTube on Connections, myaccount.google.com/permissions, or /privacy delete' },
            { data: 'Twitch and Kick sign-ins from Connect on the multicast page (your account ID and name, access and refresh tokens; Twitch permission: read your stream key, channel:read:stream_key; Kick permission: user:read). The stream bot also reads the Kick one to confirm a Kick channel is yours', purpose: 'Fetch your Twitch stream key for a multicast destination, and link your Kick channel', where: 'Our database, encrypted (AES-256-GCM)', retention: N('Kept until you disconnect it on the multicast page or delete your data'), who: 'Nobody: never shown; exported without the tokens', remove: 'Disconnect on the multicast page, or /privacy delete (which also revokes the tokens at Twitch and Kick)' },
            { data: 'Multicast destinations made from one of those sign-ins (name, platform, the platform\'s ingest address and your stream key there, on or off, order)', purpose: 'Send your stream on to that platform', where: 'Our database', retention: N('Kept until you remove the destination or the sign-in, or delete your data'), who: 'You; the stream keys are never shown again or exported', remove: 'Remove it on the multicast page; /privacy delete removes it with the sign-in' },
            { data: 'YouTube live state: the current broadcast and chat IDs, where the chat reader got to, the title, start and end times and the last error. No viewer data', purpose: 'Carry on reading chat after a restart without repeating or missing messages', where: 'Our database', retention: N('Replaced at each broadcast; kept until you unlink the channel or delete your data'), who: YOU_SUPPORT, remove: PRIVACY_DELETE },
            { data: 'YouTube quota use: how many YouTube API units your channel used each day', purpose: 'Share Google\'s daily allowance between streamers and slow down before it runs out', where: 'Our database', retention: P('stream_bot_youtube_quota', 30), who: YOU_SUPPORT, remove: PRIVACY_DELETE },
            { data: 'Tip-service tokens (StreamElements, Streamlabs)', purpose: 'Receive tip notifications. CertiFried never handles money', where: 'Our database, encrypted', retention: N('Kept until you remove the source'), who: 'Nobody: never shown or exported', remove: 'Remove the source on Connections, or /privacy delete' },
            { data: 'Event log: follows, subs, cheers, raids, redemptions, tips, OBS events, voice phrases (each with the viewer\'s name and ID where there is one, the amount and message)', purpose: 'Run automations, the live feed and the Events page', where: 'Our database (the platform\'s raw notification is kept with it, up to 16 KB)', retention: P('stream_bot_events', 90), who: YOU_SUPPORT, remove: PRIVACY_DELETE },
            { data: 'Chat messages in the event log', purpose: 'Searching chat later. Off unless you turn on Keep chat in the event log', where: 'Our database', retention: P('stream_bot_events', 90), who: YOU_SUPPORT, remove: 'Turn the setting off; /privacy delete' },
            { data: 'Automations, timers, sounds you upload, overlays and alert media', purpose: 'Your setup', where: 'Our database; sound and media files on our server', retention: N('Kept until you delete them'), who: YOU_SUPPORT, remove: 'Delete them on the dashboard, or /privacy delete' },
            { data: 'Run history (what each automation did and why)', purpose: 'Run history page and fault finding', where: 'Our database', retention: P('stream_bot_runs', 30), who: YOU_SUPPORT, remove: PRIVACY_DELETE },
            { data: 'Actions sent to CertiFried Studio and overlays, with their results', purpose: 'Deliver actions and report back', where: 'Our database', retention: P('stream_bot_dispatch_queue', 7), who: YOU_SUPPORT, remove: PRIVACY_DELETE },
            { data: 'Paired devices: name, app version, last seen, a hash of the device token', purpose: 'Let Studio, docks and overlays connect', where: 'Our database (the token itself is never stored)', retention: P('stream_bot_devices', 30, 'after it is revoked; an active device is kept until you remove it or delete your data'), who: YOU_SUPPORT, remove: 'Remove on Devices (at once), Revoke (deleted 30 days later), or /privacy delete' },
            { data: 'Pairing codes (as hashes)', purpose: 'Pair a device; a code works once, for 10 minutes', where: 'Our database', retention: P('stream_bot_pairing_codes', 1), who: 'Nobody', remove: 'Deleted after a day' },
            { data: 'Values your automations store ({db:...}, {sdb:...})', purpose: 'Counters and per-viewer values', where: 'Our database', retention: P('stream_bot_variables', 400, 'without being changed'), who: YOU_SUPPORT, remove: PRIVACY_DELETE },
            { data: 'Firebot and Streamer.bot import runs and their reports (passwords and tokens are removed first)', purpose: 'Show what an import did and avoid duplicates', where: 'Our database', retention: P('stream_bot_imports', 400), who: YOU_SUPPORT, remove: PRIVACY_DELETE },
            { data: 'Viewer records of your channels (Viewers): each viewer\'s platform ID, login and display name, first and last seen, watch time, chat message count, points and rank, and follow, sub, gift, Bits, raid and tip counts and amounts (tracked from notifications; CertiFried never handles money), including what you imported from Firebot or Streamer.bot', purpose: 'Watch time, loyalty points, ranks, leaderboards and the points commands', where: 'Our database', retention: P('stream_bot_viewers', 400, 'after the viewer was last seen'), who: YOU_SUPPORT, remove: 'Delete a viewer on Viewers, turn tracking off, or /privacy delete' },
            { data: 'Point history of those viewers (bonuses, gifts, gambles, your changes, rank-ups)', purpose: 'The viewer page on Viewers', where: 'Our database', retention: P('stream_bot_viewer_history', 400), who: YOU_SUPPORT, remove: PRIVACY_DELETE },
            { data: 'What CertiFried Studio last reported about your OBS (scene, source, audio source and filter names, OBS version, sound names, VOD protection status) and your devices (light names, models, what they can do and their scene names; the Voicemeeter type, strip and bus labels and settings file names; whether the Stream Deck connection is on). No network addresses', purpose: 'Suggest names in the automation editor and on Devices; hold song requests while the VOD is not protected', where: 'Our database (your stream bot settings), replaced at most every 30 seconds', retention: N('Only the latest report is kept, until you delete your data'), who: YOU_SUPPORT, remove: PRIVACY_DELETE },
            { data: 'Govee and LIFX cloud keys you add for your lights, with the list of lights each service returned', purpose: 'Change those lights from your automations without CertiFried Studio', where: 'Our database, the key encrypted (AES-256-GCM); only its last 4 characters are shown', retention: N('Kept until you remove the key on Devices or delete your data'), who: 'Nobody: the key is never shown or exported. The light names: you', remove: 'Remove on Devices, Lights; /privacy delete' },
            { data: 'Light presets (which lights, colour, white and brightness)', purpose: 'Apply several lights at once', where: 'Our database (your stream bot settings)', retention: N('Kept until you delete them'), who: YOU_SUPPORT, remove: 'Delete on Devices; /privacy delete' },
        ],
    },
    {
        id: 'viewers',
        title: 'Viewers in a streamer\'s channel',
        intro: 'When you watch, chat, follow, cheer, tip or request songs in the channel of a streamer who uses the stream bot, the streamer\'s stream bot records it. You can export or delete it with /privacy if your Twitch, Kick or YouTube account is linked to CertiFried, or without an account by signing in with Twitch, Kick or YouTube on /privacy/viewer.',
        rows: [
            { data: 'Events about you (follow, sub, cheer, raid, redemption, tip): your platform ID, login, display name, amount and message', purpose: 'The streamer\'s automations and alerts', where: 'Our database', retention: P('stream_bot_events', 90), who: 'That streamer; CertiFried\'s operators when handling support', remove: '/privacy delete (linked accounts) or /privacy/viewer' },
            { data: 'Your chat messages', purpose: 'Only if the streamer turned on Keep chat in the event log; otherwise chat triggers automations and is not stored', where: 'Our database', retention: P('stream_bot_events', 90), who: 'That streamer', remove: '/privacy delete (linked accounts) or /privacy/viewer' },
            { data: 'On YouTube: your Super Chats, Super Stickers and Jewels gifts, memberships, membership milestones and gifted memberships (your channel ID, display name, the amount and currency, and your message), and whether a chat line was your first in that broadcast', purpose: 'The streamer\'s automations, alerts and viewer records. CertiFried only reads YouTube\'s notifications; it never handles money', where: 'Our database', retention: P('stream_bot_events', 90), who: 'That streamer; CertiFried\'s operators when handling support', remove: '/privacy delete (linked accounts) or /privacy/viewer' },
            { data: 'Song requests: what you typed, the song found, and its status', purpose: 'The queue, history and !topSongs / !myTopSongs', where: 'Our database', retention: P('stream_bot_music_requests', 365), who: 'That streamer and their moderators', remove: '/privacy delete or /privacy/viewer removes your ID, name and what you typed; the streamer keeps a nameless line' },
            { data: 'Songs you !like', purpose: 'Likes and stats', where: 'Our database', retention: P('stream_bot_music_likes', 400), who: 'That streamer', remove: PRIVACY_DELETE },
            { data: 'Per-viewer values (points, counts) a streamer\'s automations keep', purpose: 'The streamer\'s automations', where: 'Our database', retention: P('stream_bot_variables', 400, 'without being changed'), who: 'That streamer', remove: PRIVACY_DELETE },
            { data: 'Your viewer record in that channel: your platform ID, login and display name, when you were first and last seen, how long you watched (counted every 5 minutes while the stream is live: on Twitch from the list of people in chat, on Kick and otherwise from chat messages), how many chat messages you sent, your points and rank, and how many follows, subs, gift subs, Bits, raids and tips came from you', purpose: 'The streamer\'s loyalty points, ranks and leaderboards', where: 'Our database', retention: P('stream_bot_viewers', 400, 'after you were last seen in that channel'), who: 'That streamer; their chat sees what the points commands answer', remove: '/privacy delete (linked accounts) or /privacy/viewer' },
            { data: 'Changes to your points in that channel and your rank-ups', purpose: 'The streamer\'s viewer page', where: 'Our database', retention: P('stream_bot_viewer_history', 400), who: 'That streamer', remove: '/privacy delete (linked accounts) or /privacy/viewer' },
        ],
    },
    {
        id: 'music',
        title: 'Song requests and music lookups',
        intro: 'Song requests use CertiFried\'s own music service. Money is never involved.',
        rows: [
            { data: 'Song names and links typed in chat or on the Music page', purpose: 'Find the song. Text is looked up in Spotify\'s catalogue (CertiFried\'s own app, no user account) and on YouTube through our resolvers; SoundCloud and YouTube links are read directly', where: 'Sent to Spotify, YouTube and SoundCloud for the lookup; stored with the request', retention: P('stream_bot_music_requests', 365), who: 'The streamer', remove: PRIVACY_DELETE },
            { data: 'Stream plays (what played, when, how it was found)', purpose: 'Music history and stats', where: 'Our database (the music play log)', retention: P('music_play_log', 365), who: 'The streamer', remove: 'Deleted with the streamer\'s data' },
            { data: 'Banned songs and artists, CertiFried playlists', purpose: 'The streamer\'s rules and fallback music', where: 'Our database', retention: N('Kept until the streamer removes them'), who: 'The streamer', remove: 'Remove on the Music page, or /privacy delete' },
            { data: 'Spotify-direct (optional, off by default)', purpose: 'Play Spotify audio with the streamer\'s own linked Spotify account', where: 'The streamer\'s Spotify session on our server', retention: N('Kept while Spotify stays linked'), who: 'The streamer', remove: 'Unlink Spotify' },
        ],
    },
    {
        id: 'studio',
        title: 'CertiFried Studio (on your PC)',
        intro: 'Studio keeps its data in your Windows profile. The full detail, checked against the app\'s code, is on the Studio privacy page.',
        rows: [
            { data: 'Settings: server address, device name, OBS address and port, sound, hotkey, voice and app options', purpose: 'Run the app', where: 'Your PC (%APPDATA%\\CertiFried Studio\\settings.json)', retention: N('Kept until you delete the folder; uninstalling leaves it'), who: 'You', remove: 'Delete the folder' },
            { data: 'Device token and OBS WebSocket password', purpose: 'Connect to CertiFried and to OBS', where: 'Your PC, encrypted with Windows (DPAPI), or with a local key when DPAPI is not working', retention: N('Until you unpair or clear the password'), who: 'You (programs running as you could read it)', remove: 'Unpair in Studio; clear the OBS password' },
            { data: 'Logs (tokens, pairing codes and passwords removed)', purpose: 'Fault finding; you can send them to support yourself', where: 'Your PC (logs folder)', retention: F('Rotated: 1 MB files, the 5 newest old files kept'), who: 'You', remove: 'Delete the logs folder' },
            { data: 'Voice audio', purpose: 'Voice commands (microphone off by default)', where: 'Processed on your PC by Windows speech recognition; never recorded, never sent', retention: F('Not stored'), who: 'Nobody', remove: 'Nothing to remove' },
            { data: 'Update checks', purpose: 'Offer new versions', where: 'Sent to certifriedmultitool.com (through Cloudflare)', retention: N('CertiFried\'s code does not store them; see the website row above for request logs'), who: 'Cloudflare; CertiFried\'s operators', remove: 'Turn off Check for updates in Studio' },
        ],
    },
    {
        id: 'greenhouse',
        title: 'Greenhouse Tycoon',
        intro: 'The plant-growing game on the website, in the Twitch panel and in Discord. No purchases.',
        rows: [
            { data: 'Your save: sign-ins (Discord, Twitch, Kick), name, game progress', purpose: 'The game', where: 'Our database', retention: N('Kept while you play'), who: 'You; leaderboards show your name, level and score', remove: 'Delete my save in the game\'s Profile, or /privacy delete' },
            { data: 'Record of cash and item changes', purpose: 'Fair play', where: 'Our database', retention: P('gh_ledger', 180), who: 'CertiFried\'s operators', remove: 'Deleted with your save' },
            { data: 'Daily reward claims and sign-in link history', purpose: 'Stop double claims', where: 'Our database', retention: P('gh_daily_claims', 180), who: 'CertiFried\'s operators', remove: 'Deleted with your save' },
            { data: 'Quest progress', purpose: 'Quests and challenges', where: 'Our database', retention: P('gh_account_quests', 90), who: 'You', remove: 'Deleted with your save' },
            { data: 'Notifications', purpose: 'In-game messages', where: 'Our database', retention: P('gh_notifications', 30), who: 'You', remove: 'Deleted with your save' },
            { data: 'Sign-in token on the website', purpose: 'Keep you signed in', where: 'Your browser\'s local storage', retention: N('Until you sign out'), who: 'You', remove: 'Sign out' },
        ],
    },
    {
        id: 'activities',
        title: 'Discord Activities (Watch Together, Greenhouse Tycoon in Discord)',
        intro: 'CertiFried inside a Discord voice channel. Discord\'s Activity proxy carries every request, so we do not see your IP address there.',
        rows: [
            { data: 'Your Discord user ID, username, display name and avatar when you open the Activity', purpose: 'Know who you are and who hosts', where: 'Our server\'s memory, and the session record below', retention: F('Held while the Activity is open (at most 4 hours); Discord\'s access token is not stored'), who: 'People in the same Activity see your name and avatar', remove: 'Close the Activity' },
            { data: 'Watch Together session: server, voice channel, Activity ID, who hosted, the title, position and queue', purpose: 'Keep a film going through a restart; stop the stream when nobody watches', where: 'Our database', retention: P('activity_watch_sessions', 30, 'after the last change'), who: 'People in that session; CertiFried\'s operators', remove: '/privacy delete (sessions you hosted)' },
            { data: 'Who is watching now, and whether their video is still loading', purpose: 'The People list and handing over the host', where: 'Our server\'s memory only', retention: F('Gone when you leave the Activity'), who: 'People in that session', remove: 'Leave the Activity' },
            { data: 'Your Watch Together volume', purpose: 'Remember your volume', where: 'The Activity\'s local storage in your Discord app', retention: N('Until Discord clears it'), who: 'You', remove: 'Clear Discord\'s cache' },
        ],
    },
    {
        id: 'cards',
        title: 'Greeting cards',
        intro: 'Group birthday cards and standalone cards at /cards.',
        rows: [
            { data: 'Cards and signatures: names, messages, images, GIFs, voice recordings, guest email (optional)', purpose: 'The cards', where: 'Our database and server', retention: N('Kept until the card\'s creator or a server admin deletes it'), who: 'Everyone who can open the card', remove: 'The card\'s creator deletes the card or signature' },
            { data: 'Gift card codes', purpose: 'Attach a gift to a signature', where: 'Our database, encrypted (AES-256-GCM)', retention: N('Deleted with the signature or card'), who: 'Only the card\'s recipient and creator', remove: 'Delete the signature or card' },
            { data: 'AI cover prompts and images', purpose: 'Generate a cover (Google Gemini, or Hugging Face as a fallback)', where: 'Our database and server; the prompt is sent to the image service', retention: N('Deleted with the card; an unused cover after a day'), who: 'Everyone who can open the card', remove: 'Delete the card' },
        ],
    },
]);

/**
 * The retention to show for a row: { text, kind: 'policy' | 'written' | 'feature' | 'none' }.
 * live: Map(table -> { days, enabled }) from data_retention_policy, or null when it could not be read.
 */
export function retentionText(row, live) {
    const r = row?.retention || {};
    const days = (n) => (n === 1 ? '1 day' : `${n} days`);
    if (r.table) {
        const p = live ? live.get(r.table) : null;
        if (p && p.enabled && Number.isFinite(p.days)) return { text: `${days(p.days)}${r.after ? ` ${r.after}` : ''}`, kind: 'policy' };
        // The table could not be read, or has no enabled row for it: show the value written here.
        return { text: `${days(r.days)}${r.after ? ` ${r.after}` : ''}`, kind: 'written' };
    }
    if (r.feature) return { text: r.text, kind: 'feature' };
    return { text: r.text || 'No time limit set', kind: 'none' };
}

export default { CATEGORIES, LEGAL_DOCS, STUDIO_FACTS, retentionText };
