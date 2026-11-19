/**
 * "What this does" help for every manage page, and the values its "Recommended settings" button
 * fills in.
 *
 * Keyed by the page key core/manage-nav.js uses (?page=<key>). The manage route passes
 * pageHelp(page) to the template, which renders partials/kit/_help.ejs at the top of the page;
 * dashboard/public/js/cf-settings.js does the filling. tests/pages-kit.test.js keeps this file in
 * step with the pages: every nav page has a help sentence, and every recommended value names a
 * field that is on its page and is a value that field accepts.
 *
 * help         one or two plain sentences: what the page is for, in the admin's words. No
 *              emoji, no exclamation marks, no marketing.
 * recommended  optional. { note, values } where values maps a field to what to fill in:
 *                key    the control's id, or its name when it has no id (checkbox groups,
 *                       radio groups). Generated pages (feature-config) use fc-f-<spec key>.
 *                value  true/false for a switch or checkbox; a string or number for inputs and
 *                       selects; an array for a checkbox group or multi-select (those values are
 *                       turned ON, nothing is turned off);
 *                       { pick: ['mod-log', 'logs'] } for a channel/role select: the first
 *                       option whose name contains one of these, tried in order, else left alone;
 *                       { value, ifEmpty: true } only fills a text box that is empty, so a
 *                       message someone already wrote is never replaced.
 *              Filling never saves: the page's own Save button does, and the sticky "Unsaved
 *              changes" bar shows which section changed. Only fields that are saved by a Save
 *              button are listed (never a control that acts the moment it changes). A
 *              recommendation may say what happens to someone who fails a check, but it never
 *              switches on a feature that removes people (verification itself, auto-prune, the
 *              inactivity rules): that stays the admin's decision.
 */
import { PAGE_ALIASES } from './manage-nav.js';

const pick = (...names) => ({ pick: names });

export const PAGE_HELP = Object.freeze({
    // ---------------------------------------------------------------- setup
    initialize: { help: 'Checks the bot\'s permissions, then walks a new server through logging, moderation and raid protection, then welcome messages and other recommended features. Each step links to its page, and a few can be switched on here.' },
    catalog: { help: 'Every feature the bot has, grouped the same way as the menu, with the ones already switched on marked. Use it to find a feature when you do not know its name.' },
    takeover: { help: 'Scans the other bots in your server and lists which of their jobs this bot can do. You can move their settings over and retire them one at a time.' },
    core: { help: 'The server\'s timezone, which scheduled posts, clocks and countdowns use, and the chat-command prefix with its clean-up options.' },
    appearance: { help: 'How the bot looks in this server: its nickname, the avatar on its go-live alerts and the layout of moderation logs. You can also run your own branded copy of the bot here.' },
    theme: { help: 'The colours most of the bot\'s embeds use in this server, named by meaning. The footer is saved and shown on the test message, but other embeds do not add it yet.' },
    language: { help: 'The language the bot replies in on this server. Members still see Discord itself in their own language.' },
    commands: { help: 'Turn individual commands on or off, and limit where or by whom they can be used.' },
    'command-center': { help: 'Chat-command prefixes, shortcuts that run any command from a short word, a list of every command members can type, and your own custom commands.' },
    permissions: { help: 'Allow or block single commands for particular roles and channels. The same rules are edited per command on the Commands page.' },
    'emoji-manager': { help: 'Upload, rename and delete this server\'s emoji and stickers, and make new emoji: drawn from a description, cut from an emote sheet or animated from a still one.' },
    backups: { help: 'Snapshots of your roles, channels and settings that you can restore if something is deleted or a raid wrecks the server.' },
    csv: { help: 'Adds the streamers in a spreadsheet to this server\'s live alerts, and downloads the ones it already follows as a file you can edit and import again.' },
    webhooks: { help: 'The webhooks this bot has created or looks after in your server, and whether it may create new ones.' },

    // ---------------------------------------------------------------- protection
    'protection-settings': { help: 'Who the automatic protections never act on, which roles may configure the bot, and a single switch that pauses every protection at once.' },
    security: { help: 'Anti-nuke stops one person deleting channels or roles, or banning members, in bulk. The account age gate, Discord\'s spammer flag and network intel screen accounts as they join.' },
    'advanced-protection': { help: 'Spots raids from waves of new accounts joining and can lock the server down until they pass. Also catches self-bots, spam that slips past fixed filters, and Discord invite links.' },
    quarantine: { help: 'Takes a suspicious member\'s roles away and holds them in a restricted role until a moderator reviews them.' },
    'global-ban': { help: 'A ban list shared between servers that use this bot. Known scammers and raiders can be banned before they cause trouble here.' },
    'name-filters': { help: 'Catches members whose names copy your staff or match known scam patterns, and renames, kicks or queues them for review.' },
    'avatar-protection': { help: 'Catches members using a copy of a staff member\'s avatar or a known scam profile picture.' },
    'nsfw-protection': { help: 'Checks avatars and posted images for adult content and either removes them or holds them for a moderator to review.' },
    'message-threats': { help: 'Looks inside messages for disguised scam links, mass mentions, QR codes and text hidden in images.' },
    phishing: { help: 'Deletes messages that link to known phishing and scam sites, using a list that updates on its own.' },
    'link-filter': { help: 'Controls which links members may post: allow the sites you trust, block the rest, and approve new ones from a queue.' },
    'domain-reports': { help: 'Report a phishing site the filters missed, or dispute a block on a site that is safe. Reviewed reports update the shared list.' },

    // ---------------------------------------------------------------- moderation
    moderation: {
        help: 'Where moderation actions are logged, the role used to mute people, and what happens automatically to repeat offenders. Also lists recent warnings, timeouts, kicks and bans.',
        recommended: {
            note: 'Picks a log channel and mute role by name when it finds them, and fills in a common escalation rule: three infractions in a day means a one-hour timeout. Press Add rule to keep the rule.',
            values: {
                'f-moderation-mod_log_channel_id': pick('mod-log', 'modlog', 'mod-logs', 'moderation', 'staff-log', 'logs'),
                'f-moderation-muted_role_id': pick('muted', 'mute'),
                'f-moderation-infraction_count': 3,
                'f-moderation-time_period_hours': 24,
                'f-moderation-action': 'timeout',
                'f-moderation-action_duration_minutes': 60,
            },
        },
    },
    automod: {
        help: 'Rules that delete or punish messages automatically: banned words, mass mentions, shouting in capitals and message spam.',
        recommended: {
            note: 'Fills in a message spam rule: the same message five times in ten seconds mutes the sender for ten minutes. Press Add rule to create it.',
            values: {
                'filter-type-select': 'antiSpam',
                'action-select': 'mute',
                'f-automod-action_duration_minutes': 10,
                'f-automod-config_antispam_message_limit': 5,
                'f-automod-config_antispam_time_period': 10,
            },
        },
    },
    'invite-policy': { help: 'Makes new invite links single-use with an expiry. Other invites are deleted, and staff or chosen roles get a replacement link by DM.' },
    'commission-filter': { help: 'Removes "commissions open" and self-promotion adverts from channels where they are not wanted, with a log and an undo for anything it removes by mistake.' },
    mass: { help: 'Act on a list of members at once by user ID: give or take away a role, kick or ban. Also exports and imports a channel\'s streamer alerts as a CSV file.' },
    'automod-heat': { help: 'Gives each rule break a score that cools down over time, and acts once someone\'s score gets too high. Repeated small offences add up; a one-off does not.' },
    'automod-spam': {
        help: 'Limits on how fast members can post and how many mentions, emoji or repeated characters one message may contain.',
        recommended: {
            note: 'The usual limits, with a mute rather than a kick for anyone who goes over them.',
            values: {
                'fc-f-enabled': true,
                'fc-f-max_messages': 5,
                'fc-f-time_window': 10,
                'fc-f-max_mentions': 5,
                'fc-f-max_emojis': 15,
                'fc-f-max_repeated_chars': 10,
                'fc-f-action': 'mute',
            },
        },
    },

    // ---------------------------------------------------------------- joining
    verification: {
        help: 'New members prove they are real before they can see the server, either with an "I agree" button or a CAPTCHA. Auto-prune and the inactivity prune clear out accounts that never take part.',
        recommended: {
            note: 'A CAPTCHA with three tries and an hour to finish, and a kick (with a DM saying why) for anyone who fails. For the inactivity prune it fills in only the safety limits; it does not switch either rule on.',
            values: {
                vfMode: 'captcha',
                vfAttempts: 3,
                vfWindow: 60,
                vfFail: 'kick',
                vfTimeout: 60,
                vfDm: true,
                inWarn: 3,
                inMinDays: 14,
                inPerSweep: 10,
                inPerDay: 50,
                inStaff: true,
                inBoosters: true,
            },
        },
    },
    welcome: {
        help: 'Posts a message or embed, with an optional banner image, when someone joins, leaves or is banned, and can send new members a DM.',
        recommended: {
            note: 'Picks a welcome channel by name when it finds one, writes a short greeting if you have none, and turns the banner on.',
            values: {
                'f-welcome-channel_id': pick('welcome', 'arrivals', 'introductions', 'general'),
                'f-welcome-message': { value: 'Welcome to {server}, {user}. You are member number {memberCount}.', ifEmpty: true },
                banner_enabled: true,
            },
        },
    },
    'discord-native': { help: "Sets up Discord's own server features from here: the welcome screen, onboarding questions, soundboard and scheduled events." },
    'messages': { help: "Log entries and welcome, leave and ban messages the bot has posted, with their text editable in place, so a mistake can be fixed without posting a new message." },
    'channel-post-rules': { help: "Limits what can be posted in a channel and by whom: images only, blocked link sites, a minimum level or time in the server, and a cooldown between posts." },
    'network-intel': { help: "Scam DMs your members report, and the blacklist shared between every server the bot is in, so a known scammer is spotted everywhere." },
    'role-sync': { help: "Gives Discord roles to the VIPs and moderators of a linked Twitch channel, and takes them away when that ends. Subscriber roles come from Discord's own Twitch integration, not from here." },
    'schedule-calendar': { help: "Fill in a month of streams yourself, or sync it from Twitch, and post it as a calendar image." },
    'holidays': { help: "Keeps a \"days until\" countdown message up to date for holidays you choose, and gives each one a link you can share." },
    'scheduled-messages': { help: 'Posts a message to a channel on a schedule you set: every few hours, on chosen days at a set time, once a month, or once. Each message can include an embed and ping a role, and can stop on a date or after a number of posts.' },
    'join-requests': { help: 'Applications from people asking to join, and a record of which moderator approved or rejected each one.' },
    rejoin: { help: 'Acts on members who keep leaving and rejoining, a common way to dodge timeouts or spam the join log.' },
    orientation: { help: 'A guide message that lists the bot features this server has set up and how to set up the rest. Pick the channel it lives in; refresh it with /systems orientation update after you change features.' },

    // ---------------------------------------------------------------- roles
    'role-manager': { help: 'Edit, reorder and assign roles, see who has each one, and give a member back the roles they had before they left.' },
    'reaction-roles': { help: 'Panels where members pick their own roles with buttons, menus or reactions.' },
    'bulk-roles': { help: 'Create many roles at once from a list, with the same colour and permissions.' },
    'stat-roles': { help: 'Gives roles automatically based on a member\'s stats, such as level, messages sent or time in the server.' },
    'channel-access': { help: 'Turns a channel\'s one-person-at-a-time permission overrides into a single role, which is easier to manage.' },
    colorroles: { help: 'Lets members pick a name colour for themselves, and set an AFK status that others see when they mention them.' },
    'sticky-roles': {
        help: 'Remembers a member\'s roles when they leave and gives them back if they rejoin, so leaving cannot be used to shed a mute.',
        recommended: {
            note: 'Turns it on and remembers roles for 30 days.',
            values: { 'fc-f-sticky_roles_enabled': true, 'fc-f-sticky_roles_retention_days': 30 },
        },
    },

    // ---------------------------------------------------------------- engagement
    leveling: {
        help: 'Members earn XP for chatting and level up over time. Levels can unlock roles, and channels or roles can be left out.',
        recommended: {
            note: 'The standard pace of 15 XP a message (plus a small random bonus) at most once a minute, with bot and command channels left out when it finds them.',
            values: {
                leveling_enabled: true,
                'f-leveling-leveling_xp_rate': 15,
                'f-leveling-leveling_xp_cooldown': 60,
                'f-leveling-leveling_ignored_channels': pick('bot-commands', 'bot-spam', 'commands', 'bots', 'spam'),
            },
        },
    },
    achievements: { help: 'Badges members unlock for milestones such as messages sent, time in voice, casino wins and RPG quests. Some pay coins or XP where the economy or leveling is on.' },
    starboard: { help: 'Reposts messages that get enough of a chosen reaction to a highlights channel. You can run several boards, each with its own channel, emoji, threshold and channel rules.' },
    birthday: { help: 'Members save their birthday and the bot announces it on the day, with an optional card and role.' },
    confessions: { help: 'Members send a confession to the bot and it posts it without their name. Members never see who sent one; server admins can reveal the sender on this page for 30 days to deal with abuse, and every reveal is written to the audit log.' },
    cannabis: { help: 'Community features for cannabis servers: smoke circles, a strain database, trivia and stats. An age gate can limit them to adults.' },
    communitygoals: { help: 'Server-wide goals with a deadline, such as a message or member count, with live progress and an announcement at each milestone.' },
    grow: { help: 'Tools for growers: calculators, a strain database, grow journals, timers and competitions. An age gate can limit them to adults.' },
    qotd: { help: 'Posts a question every day or on chosen days from your decks, optionally in its own thread, to get conversation going.' },
    rankcard: { help: 'Defaults and limits for the rank card members see with the rank command, including whether they may upload their own background.' },
    selfcare: { help: 'Tools for habits, mood tracking, breathing exercises, tasks and daily challenges. Mood tracking is always private; with private replies on, the typed commands such as /habit answer by DM.' },

    // ---------------------------------------------------------------- events
    giveaways: { help: 'Start a giveaway in a channel, end one early or draw new winners, post the Create giveaway panel and choose which roles may start one from it.' },
    polls: { help: 'Create polls with a button for each answer, see how many members voted, and edit or end the ones still open.' },
    suggestions: { help: 'Members post suggestions that others vote on, or that wait for staff approval first if you require it. Staff approve, reject, tag or mark them implemented, and the author is told by DM.' },
    'event-reminders': {
        help: 'Reminds members who clicked Interested on a Discord server event before it starts, and can announce the start in a channel.',
        recommended: {
            note: 'DM reminders 30 minutes before the start. Members can opt out from the DM itself.',
            values: { 'fc-f-dm_reminders_enabled': true, 'fc-f-reminder_minutes': 30 },
        },
    },
    tournaments: { help: 'Run brackets with sign-ups: single or double elimination, or round robin.' },

    // ---------------------------------------------------------------- games
    games: { help: 'Your own trivia questions and hangman words, mixed in with the built-in ones when members play.' },
    counting: { help: 'Channels where members count up one number at a time, and what happens when someone gets it wrong.' },
    minigames: { help: 'Small games that run in the background: Cat Bot, Grow a Tree and timezone conversion.' },
    owo: { help: 'An animal-collecting game with hunting, a zoo, teams, weapons and battles.' },
    rpg: { help: 'A text adventure with characters, quests and battles that members play in chat.' },
    cah: { help: 'Rules and defaults for Cards Against Humanity games started with /cah start: points to win, rounds, the turn timer, blank cards, and whether NSFW decks are allowed.' },
    emojihunt: { help: 'The bot hides an emoji on recent messages and the first member to react finds it, for points, coins or XP.' },
    fishing: { help: 'A fishing game with gear to buy, an aquarium to fill and tournaments.' },
    sprites: { help: 'Links a Fortnite Sprite Tracker collection to Discord so members can show and compare theirs.' },
    fun: { help: 'Jokes, memes, trivia, tarot, icebreakers and random generators, and the channels they may be used in.' },
    arcade: { help: 'Looking-for-group posts that expire on their own, and a music quiz members can play together.' },
    pokemon: { help: 'Pokemon that appear in chat as people talk, to catch, battle and trade.' },
    digimon: { help: 'A partner Digimon members raise from an egg, wild Digimon to tame in chat, battles, and a daily quiz. Off until you turn it on.' },
    greenhouse: { help: 'Greenhouse Tycoon, the plant-breeding game on the website, the Twitch panel and Discord: which members of this server play, the running 30-day season and its weekly challenge, and the link to share. One world for everyone, so standings are not per server.' },
    windrose: { help: 'Status, join details and admin controls for the CertiFried Windrose game server.' },
    wordgames: { help: 'Word games played in chat: Last Letter, Story Chain, Coordle and Word Seek.' },

    // ---------------------------------------------------------------- economy
    economy: { help: 'The server currency: how members earn it, the shop where they spend it, and balances and transactions.' },
    gambling: { help: 'Casino games that use the server currency, with limits on how much can be bet.' },
    trading: { help: 'Trades members make with /economy trade offer and card swaps from the card game: the offers still open, which you can cancel, and the last 50 that finished.' },
    loyalty: { help: 'Points for being active every day, with a bonus for streaks, that members spend on roles and rewards.' },
    marketplace: {
        help: 'Deletes posts from brand-new accounts in marketplace and trading channels, a common route for scams.',
        recommended: {
            note: 'Accounts must be at least 30 days old to post in marketplace channels; members with a trader or trusted role skip the check.',
            values: { 'fc-f-account_age_filter': true, 'fc-f-min_account_age_days': 30, 'fc-f-trader_role_bypass': true },
        },
    },

    // ---------------------------------------------------------------- game news
    'free-games': { help: 'Posts free game offers from Epic, Steam, GOG and Prime Gaming in a channel you choose.' },
    'game-news': { help: 'Patch notes and update posts for the games your community plays: pick from a catalogue of 75 games, or add any RSS feed, Steam app or X account.' },
    'steam-library': { help: 'Members link their Steam accounts so you can see who owns which games when planning a game night.' },
    deals: { help: 'Look up game prices, historical lows and current giveaways, in your region\'s currency.' },
    'steam-watch': { help: 'Follows Steam games for updates and news, with prices in the currency you choose.' },

    // ---------------------------------------------------------------- streams
    streamers: { help: 'The streamers this server follows and the go-live alerts posted when they start, on Twitch, Kick, YouTube, TikTok and Rumble.' },
    teams: { help: 'Follow a whole Twitch team so every member\'s stream is announced without adding them one by one.' },
    announcements: { help: 'The server-wide defaults for go-live posts: the channel, the live role, the message, roles that are never announced, and the style each post is drawn in.' },
    'stream-ended': { help: 'What happens to a go-live post when the stream ends: edit it to show the stream is over, delete it, or leave it as it was.' },
    'auto-track': { help: 'Adds a member as a streamer the first time Discord shows them streaming on Twitch, if they have the role you pick (or any member), skipping anyone already tracked. Also sends alerts to other channels by role.' },
    'twitch-schedules': { help: 'Posts a streamer\'s Twitch schedule in a channel as an image and keeps it up to date, with a choice of layouts and backdrops.' },
    'twitch-clips': { help: 'Posts new Twitch clips from the channels you choose.' },
    tiktok: { help: 'Alerts when TikTok creators go live or post a new video.' },
    'event-schedule': { help: 'Events members add with /engage events add, or bring in from their Twitch schedule with /engage events twitch-sync, posted in one channel as a weekly timetable image.' },
    'self-promo': { help: 'Notices streamers posting their links in self-promo channels and can add them to the tracked list.' },
    'stream-signup': { help: 'Members post their stream link in a signup channel and are added as a streamer once they reach the level you set. If leveling resets are on, each reset also pauses the tracked streamers who are below that level until they reach it again.' },

    // ---------------------------------------------------------------- creators
    feeds: { help: 'Posts new uploads from YouTube channels, new posts from X and Bluesky accounts, and new items from RSS feeds such as blogs and podcasts, into channels you pick. Reddit feeds are paused because Reddit no longer lets bots read subreddits.' },
    'community-support': { help: 'Raids, shoutouts and a leaderboard of the members who support other streamers most.' },
    throne: { help: 'Announces gifts, contributions and wishlist changes for the Throne creators you track.' },
    kofi: { help: 'Gives roles to people who tip or subscribe on Ko-fi, and announces their support if you want.' },
    shoutout: { help: 'Announces the streams of your top community supporters each month, and of streamers added with /alerts shoutout add.' },
    buymeacoffee: { help: 'Announces new Buy Me a Coffee supporters for creators who link their account.' },
    showcase: { help: 'Members share music and video that others can play but not download.' },
    fourthwall: { help: 'Watches Fourthwall shops and posts new products, price changes and stock changes.' },

    // ---------------------------------------------------------------- media
    music: { help: 'The music player: who controls it, the DJ role, and the voices used for spoken announcements.' },
    soundboard: { help: 'Upload short sound clips and play them in a voice channel.' },
    'ai-dj': { help: 'Plays music picked by AI to a mood, genre or prompt you set, with a voice DJ between songs.' },
    cinema: { help: 'Watch films together: shared playback in a voice channel, controlled by the role you choose.' },
    tts: { help: 'Reads messages aloud in voice for members who cannot or would rather not speak.' },
    'vc-sounds': { help: 'Plays a random sound clip in busy voice channels now and then, on an interval or schedule you set.' },
    'voice-reader': { help: 'Reads a text channel aloud in a voice channel, for members who are listening rather than reading.' },
    'voice-recording': { help: 'Lets staff record the voice channel they are in. Everyone in the channel is told, and the bot shows that it is recording.' },
    'voice-transcription': { help: 'Live captions of what is said in voice, and a written transcript afterwards.' },
    jellyfin: { help: 'Streams a film or episode from your Jellyfin library into a voice channel for a watch party.' },

    // ---------------------------------------------------------------- replies
    'custom-commands': { help: 'Commands you write yourself: a name and the reply the bot sends when someone uses it.' },
    autoresponders: { help: 'Replies sent automatically when a message contains a word or phrase you choose.' },
    tags: { help: 'Saved snippets of text that members can post by name, for answers you give often.' },
    'ai-assistant': { help: 'Answers questions when someone mentions the bot, in the channels you allow, with a daily limit.' },
    imagine: { help: 'Members generate an image from a text description with /imagine generate. You can limit it to one channel and set how long each member waits between requests.' },
    'context-menus': { help: 'Actions in Discord\'s right-click menu on members and messages, such as User Info, Report Message and Forward Message. Turn each one off or limit it to some roles, or turn them all off in this server.' },
    knowledge: { help: 'Lookup commands: facts, a dictionary, NASA pictures, crypto prices, GitHub, recipes and jokes.' },

    // ---------------------------------------------------------------- automation
    announce: { help: 'Write and post an announcement, with an image, to any channel.' },
    'custom-embeds': { help: 'Build embed messages such as rules or information posts, preview them, and post or edit them later.' },
    schedule: { help: 'Plans events such as marathons: each event has a schedule for every day or block, and each schedule a list of runs you start and mark done as they happen.' },
    reminders: { help: 'Reminders posted in a channel, once or on repeat, and when each one posts next. Add one here; reminders members get by direct message stay private and are not listed.' },
    timecapsules: { help: 'Messages that are sealed now and delivered on a future date.' },
    weather: { help: 'Sends members a direct message when the US National Weather Service issues a severe weather alert for the ZIP code they saved.' },
    automemes: { help: 'Posted memes from Reddit on a schedule. Paused: Reddit no longer allows bots to read subreddits.' },
    sticky: { help: 'Keeps a message at the bottom of a channel by reposting it after new messages arrive.' },
    'auto-purge': { help: 'Clears a channel on a schedule, such as every night at midnight.' },
    'smart-purge': { help: 'Deletes messages once they reach a certain age, or only certain kinds of message such as links or uploads.' },
    utilities: { help: 'Roles given to everyone who joins, temporary voice channels that appear when needed, and automatic publishing of announcement posts.' },
    forums: { help: 'Forums set up with /admin forum setup: one switch for all their rules, and the archive and lock-on-archive defaults they fall back on. The rules themselves (a required tag, slowmode, a reaction on new posts) are set with the command.' },

    // ---------------------------------------------------------------- logging
    logging: {
        help: 'Records what happens in the server, such as deleted messages, joins, bans and role changes, in the channels you choose.',
        recommended: {
            note: 'Picks a log channel by name when it finds one and switches on the events most servers want: deleted and edited messages, joins and leaves, moderation, roles, channels, invites and integrations. Nothing already on is switched off.',
            values: {
                'log-channel-id': pick('server-log', 'server-logs', 'audit-log', 'logs', 'log', 'mod-log'),
                enabled_logs: [
                    'messageDelete', 'messageUpdate', 'memberJoin', 'memberLeave', 'memberUpdate', 'memberKick', 'memberTimeout',
                    'ban', 'unban', 'channelCreate', 'channelDelete', 'roleCreate', 'roleDelete', 'roleUpdate',
                    'inviteCreate', 'webhookUpdate', 'integrationUpdate', 'automod', 'automodAction', 'moderation', 'join-gate',
                ],
                joinInsightOn: true,
                joinInsightDays: 7,
            },
        },
    },
    'action-log': { help: 'What the bot recorded in this server, newest first: role, nickname, voice, channel, invite and moderation events and command use, with the full before and after values. Kept for 365 days, or less if you set it on Log retention.' },
    analytics: { help: 'Charts of members joining and leaving, and message activity over time.' },
    'activity-audit': { help: 'Who is active and who is not, by messages sent and time in voice, to find members who have gone quiet.' },
    serverstats: { help: 'Messages, joins and leaves, voice time and command use for the last 7, 30 or 90 days, with the most active members, channels and hours.' },
    'stat-displays': { help: 'Voice channels whose names show stats, the time or the date, updated automatically.' },
    emojistats: { help: 'Which of your server\'s emoji are used most, and which are never used.' },
    'message-evidence': { help: 'Keeps copies of images from deleted messages so moderators still have the evidence after Discord removes the originals.' },
    'log-retention': { help: 'Deletes this server\'s stored message and moderation logs sooner than the default, for servers that want to keep less.' },

    // ---------------------------------------------------------------- support
    tickets: { help: 'Support tickets: the panels members open them from, who can see them, and the open queue. Closed tickets and their transcripts are kept for a year.' },
    forms: { help: 'Applications and surveys members fill in from Discord, with the answers collected here for review.' },
    todo: { help: 'Task lists posted as embeds that update as items are added and ticked off.' },
    bugs: { help: 'Bug reports sent by members, where to post them and who triages them.' },
    modmail: { help: 'Members message the bot privately to open a thread that only staff can see, and staff reply from Discord.' },
    'staff-contact': { help: 'A pinned panel where members can contact staff or file a report without knowing who to ask.' },
});

/** The help entry for a page (aliases resolved), or null. Returned as plain data for the template. */
export function pageHelp(page) {
    const key = PAGE_ALIASES[page] || page;
    const entry = PAGE_HELP[key];
    if (!entry) return null;
    const rec = entry.recommended && entry.recommended.values && Object.keys(entry.recommended.values).length
        ? { note: entry.recommended.note || '', values: entry.recommended.values }
        : null;
    return { page: key, help: entry.help, recommended: rec };
}

/** Pages in `nav` (buildManageNav()) with no help entry. */
export function missingHelp(nav) {
    const out = [];
    for (const sec of nav || []) for (const it of sec.items || []) if (!PAGE_HELP[it.page]) out.push(it.page);
    return out;
}

export default { PAGE_HELP, pageHelp, missingHelp };
