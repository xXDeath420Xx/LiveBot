/**
 * Manage-page navigation: the one list of every dashboard feature page and the
 * section it is filed under.
 *
 * The overview's grouped lists, the sub-page sidebar, the search index and the
 * "recently visited" icons are all rendered from this, so a page is registered
 * for navigation in exactly one place. `pageMap` in manage-tailwind.ejs still
 * decides what a page RENDERS; tests/manage-nav.test.js asserts that every
 * pageMap key appears here exactly once (aliases excepted) and that every
 * entry here has a pageMap key.
 *
 * Generated feature-config pages (core/feature-config-spec.js) are filed by
 * buildManageNav(): by SPEC_OVERRIDES when listed, otherwise by their spec
 * category. A spec page whose category maps to nothing lands in a visible
 * "Other" section rather than disappearing.
 *
 * SECTIONS keys double as the saved section-order keys in
 * core/user-preferences.js, which imports them from here, and as the
 * data-sec / data-category hooks that give each section its colour
 * (cf-manage.css). Sections are named for what an admin is trying to do
 * (2026-10-13: the eleven broad sections were too vague; seventeen specific
 * ones replaced them, so orders saved under the old keys fall back to the
 * shipped order).
 */

export const SECTIONS = Object.freeze([
    { key: 'setup', label: "Bot & server setup", icon: 'fa-sliders', desc: "Setup wizard, bot identity, commands, permissions, emoji and backups" },
    { key: 'protection', label: "Protection & anti-raid", icon: 'fa-shield-halved', desc: "Raids, nukes, impersonators, scam accounts and scam links" },
    { key: 'moderation', label: "Moderation & AutoMod", icon: 'fa-gavel', desc: "Mod log, infractions, AutoMod rules and spam limits" },
    { key: 'joining', label: "Verification & joining", icon: 'fa-door-open', desc: "Verification gate, welcome messages, join applications and rejoins" },
    { key: 'roles', label: "Roles", icon: 'fa-user-tag', desc: "Role editor, self-assign panels, colour roles and roles that stick" },
    { key: 'engagement', label: "Levels & engagement", icon: 'fa-trophy', desc: "XP and rank cards, achievements, starboard, birthdays and daily prompts" },
    { key: 'events', label: "Events, polls & giveaways", icon: 'fa-calendar-check', desc: "Giveaways, polls, suggestions, server events and tournaments" },
    { key: 'games', label: "Games", icon: 'fa-gamepad', desc: "Chat games, collecting games, party games and game servers" },
    { key: 'economy', label: "Economy & trading", icon: 'fa-coins', desc: "Currency and shop, gambling, loyalty points and member trades" },
    { key: 'gamenews', label: "Game news & deals", icon: 'fa-newspaper', desc: "Free games, patch notes, Steam tracking and price lookups" },
    { key: 'streams', label: "Stream alerts", icon: 'fa-tower-broadcast', desc: "Go-live alerts for Twitch, Kick, YouTube and TikTok, clips and schedules" },
    { key: 'creators', label: "Social feeds & creators", icon: 'fa-rss', desc: "Social feeds, shoutouts, supporter platforms and creator showcases" },
    { key: 'media', label: "Music & voice", icon: 'fa-headphones', desc: "Music, AI DJ, soundboard, text to speech, captions and watch parties" },
    { key: 'replies', label: "Custom commands & AI", icon: 'fa-terminal', desc: "Your own commands, auto-replies, tags, the AI assistant and lookups" },
    { key: 'automation', label: "Scheduling & automation", icon: 'fa-clock-rotate-left', desc: "Announcements, scheduled posts, sticky messages and channel clean-up" },
    { key: 'logging', label: "Logs & stats", icon: 'fa-chart-line', desc: "Event logs and retention, analytics, activity and stat channels" },
    { key: 'support', label: "Tickets, forms & support", icon: 'fa-life-ring', desc: "Tickets, modmail, staff contact, forms, bug reports and task lists" },
]);

/** Pages that render another entry's page and need no entry of their own. */
export const PAGE_ALIASES = Object.freeze({ streaming: 'streamers', 'digimon-quiz': 'digimon', 'digimon-odds': 'digimon', cfx: 'greenhouse' });

/** Hand-registered pages, in display order within each section. */
export const PAGES = Object.freeze([
    // setup
    { page: 'initialize', section: 'setup', title: "Setup wizard", desc: "Step-by-step setup for a new server", icon: 'fas fa-wand-magic-sparkles', tags: "setup wizard initialize onboarding guide start getting started first time" },
    { page: 'catalog', section: 'setup', title: "Feature catalog", desc: "Every feature, and which ones are already on", icon: 'fas fa-compass', tags: "catalog features browse discover everything all what can this bot do" },
    { page: 'takeover', section: 'setup', title: "Replace other bots", desc: "Scan for bots this one can replace and retire them", icon: 'fas fa-crosshairs', tags: "takeover migrate replace scan audit bots retire remove mee6 carl dyno parity" },
    { page: 'core', section: 'setup', title: "General settings", desc: "Timezone, prefix and command clean-up", icon: 'fas fa-sliders-h', tags: "prefix timezone language settings configuration" },
    { page: 'appearance', section: 'setup', title: "Bot appearance", desc: "Nickname, alert avatar, modlog layout and custom bot", icon: 'fas fa-paint-brush', tags: "nickname avatar color embed custom bot instance token branding" },
    { page: 'theme', section: 'setup', title: "Embed theme", desc: "Embed colours by meaning", icon: 'fas fa-palette', tags: "theme colour color branding embed palette white label custom" },
    { page: 'language', section: 'setup', title: "Language", desc: "Language the bot replies in on this server", icon: 'fas fa-language', tags: "language locale translation i18n internationalization espa\u00f1ol portugu\u00eas fran\u00e7ais deutsch" },
    { page: 'commands', section: 'setup', title: "Commands", desc: "Turn commands on or off and restrict where they run", icon: 'fas fa-terminal', tags: "commands enable disable slash permissions restrictions" },
    { page: 'command-center', section: 'setup', title: "Prefixes and aliases", desc: "Chat-command prefixes, aliases and bridging", icon: 'fas fa-keyboard', tags: "command center prefix alias aliases custom prefixes bridge universal" },
    { page: 'permissions', section: 'setup', title: "Bot permissions", desc: "Per-role and per-channel command overrides", icon: 'fas fa-user-lock', tags: "permissions override roles access" },
    { page: 'emoji-manager', section: 'setup', title: "Emoji manager", desc: "Upload, make and manage emoji and stickers", icon: 'fas fa-icons', tags: "emoji sticker upload manage delete rename custom emotes" },
    { page: 'backups', section: 'setup', title: "Backups", desc: "Server backups and restore", icon: 'fas fa-save', tags: "backups restore save snapshot" },
    { page: 'csv', section: 'setup', title: "Import and export", desc: "Import and export your streamers as CSV", icon: 'fas fa-file-csv', tags: "csv import export data spreadsheet" },
    // protection
    { page: 'protection-settings', section: 'protection', title: "Protection settings", desc: "Allowlist, bot-manager roles and pause switch", icon: 'fas fa-user-shield', tags: "protection allowlist whitelist exempt trusted bot manager managers roles pause resume kill switch" },
    { page: 'security', section: 'protection', title: "Join gate and anti-nuke", desc: "Anti-nuke, account age gate, flagged spammers and network intel", icon: 'fas fa-lock', tags: "security anti-raid anti-nuke join-gate verification lockdown alert" },
    { page: 'advanced-protection', section: 'protection', title: "Raid lockdown", desc: "Raid detection and lockdown, self-bots, adaptive spam and invite links", icon: 'fas fa-shield-virus', tags: "raid detection lockdown anti-raid auto-trigger same-name flood invites dms disable pause incident selfbot adaptive spam protection" },
    { page: 'quarantine', section: 'protection', title: "Quarantine", desc: "Isolate suspicious accounts", icon: 'fas fa-user-shield', tags: "quarantine suspicious isolate restrict" },
    { page: 'global-ban', section: 'protection', title: "Global ban", desc: "Shared cross-server ban list", icon: 'fas fa-globe', tags: "global ban shared cross-server database" },
    { page: 'name-filters', section: 'protection', title: "Name filters", desc: "Impersonator and scam names, cleanse and templates", icon: 'fas fa-id-badge', tags: "name filter filters nickname username display impersonation impersonator scam regex phrase cleanse template auto-pilot autopilot staff names generated usernames fuzzy homoglyph" },
    { page: 'avatar-protection', section: 'protection', title: "Avatar protection", desc: "Copied staff avatars and known scam avatars", icon: 'fas fa-user-secret', tags: "avatar pfp profile picture impersonation impersonator staff avatar server icon scam black transparent protected image review cleanse auto-pilot autopilot" },
    { page: 'nsfw-protection', section: 'protection', title: "NSFW protection", desc: "NSFW avatars and images, with a review queue", icon: 'fas fa-eye-slash', tags: "nsfw adult explicit porn nudity pfp avatar profile picture chat images attachments model classifier review overturn scan cap usage" },
    { page: 'message-threats', section: 'protection', title: "Message threats", desc: "Obfuscated links, mass mentions, QR codes and image text", icon: 'fas fa-user-ninja', tags: "message threats obfuscated url link scam fake support ticket automod escalation circuit breaker everyone here mention webhook qr code image text ocr rules url check checkurl ignore channels categories" },
    { page: 'phishing', section: 'protection', title: "Phishing links", desc: "Block known phishing and scam domains", icon: 'fas fa-link', tags: "phishing scam link detection domain" },
    { page: 'link-filter', section: 'protection', title: "Link filter", desc: "Default-deny link policy with an approval queue", icon: 'fas fa-link', tags: "link filter url domain allowlist blocklist advertising shortener default deny verification approve social platform" },
    { page: 'network-intel', section: 'protection', title: "Network intel", desc: "Scam DM reports and the shared network blacklist", icon: 'fas fa-satellite-dish', tags: "network intel scam dm reports blacklist shared ban list cross server" },
    { page: 'domain-reports', section: 'protection', title: "Domain reports", desc: "Report phishing domains or dispute a block", icon: 'fas fa-flag', tags: "domain report dispute phishing url link false positive block unblock allow brand protection checkurl review pending blocked resolved rejected" },
    // moderation
    { page: 'moderation', section: 'moderation', title: "Moderation", desc: "Mod log, mute role, infractions and escalation", icon: 'fas fa-gavel', tags: "moderation ban kick mute warn timeout infractions escalation" },
    { page: 'messages', section: 'moderation', title: "Messages", desc: "Edit log entries and welcome messages the bot already posted", icon: 'fas fa-pen-to-square', tags: "messages edit template bot message retroactive log embed welcome announcement" },
    { page: 'channel-post-rules', section: 'moderation', title: "Channel post rules", desc: "Images only, blocked link sites, level and age gates per channel", icon: 'fas fa-filter', tags: "channel post rules images only media only art showcase link block level gate cooldown new members restrict posting" },
    { page: 'automod', section: 'moderation', title: "AutoMod", desc: "Filtered words, spam, mention and caps rules", icon: 'fas fa-robot', tags: "automod filter spam links caps profanity word" },
    { page: 'discord-native', section: 'setup', title: "Discord native features", desc: "Welcome screen, onboarding, soundboard and scheduled events", icon: 'fab fa-discord', tags: "discord native welcome screen onboarding scheduled events soundboard application emojis clyde" },
    { page: 'commission-filter', section: 'moderation', title: "Commission filter", desc: "Remove commission and self-promo advertising", icon: 'fas fa-broom', tags: "commission sales filter self-promo advertising gfx vtuber artist spam dm for info soft-sell portfolio removals log undo false positive exemptions review queue" },
    { page: 'mass', section: 'moderation', title: "Mass actions", desc: "Give or remove a role, kick or ban a list of members", icon: 'fas fa-users-cog', tags: "mass actions bulk role channel management" },
    // joining
    { page: 'verification', section: 'joining', title: "Verification", desc: "CAPTCHA or rules gate, auto-prune and inactivity prune", icon: 'fas fa-user-lock', tags: "verification verify captcha code keypad i agree rules gate unverified verified role lock channels setup wizard undo auto prune autoprune kick idle no role bypass queue stats rate inactive inactivity dormant quiet lurkers never active voice messages warning" },
    { page: 'welcome', section: 'joining', title: "Welcome messages", desc: "Join, leave and ban messages, and a DM for new members", icon: 'fas fa-hand-sparkles', tags: "welcome join message dm greeting autorole member" },
    { page: 'join-requests', section: 'joining', title: "Join applications", desc: "Applicants, and who approved or rejected each", icon: 'fas fa-user-check', tags: "join applications apply to join approve approved rejected accepted who let in approver member verification requests invite history" },
    { page: 'rejoin', section: 'joining', title: "Rejoin limit", desc: "Act on members who keep leaving and rejoining", icon: 'fas fa-repeat', tags: "rejoin repeat join leave history ban evasion join-gate" },
    // roles
    { page: 'role-manager', section: 'roles', title: "Roles", desc: "Edit and assign roles, restore a member's roles", icon: 'fas fa-user-tag', tags: "roles role manager hierarchy members assign give remove restore history left rejoin edit delete reorder permissions" },
    { page: 'reaction-roles', section: 'roles', title: "Reaction roles", desc: "Self-assignable role panels", icon: 'fas fa-smile-beam', tags: "reaction roles self-assign emoji panel dropdown" },
    { page: 'bulk-roles', section: 'roles', title: "Bulk roles", desc: "Create many roles from a list", icon: 'fas fa-layer-group', tags: "roles bulk create mass role names list permissions color hierarchy hoist" },
    { page: 'stat-roles', section: 'roles', title: "Stat roles", desc: "Roles granted from member stats", icon: 'fas fa-chart-pie', tags: "stat roles dynamic automatic" },
    { page: 'channel-access', section: 'roles', title: "Channel access", desc: "Convert per-user channel overwrites into a role", icon: 'fas fa-users-cog', tags: "channel access whitelist per-user overwrite role convert private members" },
    // engagement
    { page: 'leveling', section: 'engagement', title: "Leveling", desc: "XP, level-up messages and role rewards", icon: 'fas fa-trophy', tags: "xp level rank card rewards roles leaderboard" },
    { page: 'achievements', section: 'engagement', title: "Achievements", desc: "Badges members unlock", icon: 'fas fa-medal', tags: "achievements badge milestone unlock xp" },
    { page: 'starboard', section: 'engagement', title: "Starboard", desc: "Repost messages that get enough reactions", icon: 'fas fa-star', tags: "starboard star popular highlight reaction" },
    { page: 'birthday', section: 'engagement', title: "Birthdays", desc: "Birthday announcements and cards", icon: 'fas fa-birthday-cake', tags: "birthday celebration announce date card" },
    { page: 'confessions', section: 'engagement', title: "Confessions", desc: "Anonymous confession channel", icon: 'fas fa-user-secret', tags: "confessions anonymous secret message" },
    // events
    { page: 'giveaways', section: 'events', title: "Giveaways", desc: "Run and manage giveaways", icon: 'fas fa-gift', tags: "giveaway raffle prize winner" },
    { page: 'polls', section: 'events', title: "Polls", desc: "Create, edit and end polls", icon: 'fas fa-poll', tags: "poll vote survey feedback" },
    { page: 'suggestions', section: 'events', title: "Suggestions", desc: "Member suggestions with voting and review", icon: 'fas fa-lightbulb', tags: "suggestion idea feedback vote approve deny" },
    // games
    { page: 'games', section: 'games', title: "Trivia and hangman", desc: "Question and word lists for chat games", icon: 'fas fa-gamepad', tags: "games trivia hangman counting mini-game" },
    { page: 'counting', section: 'games', title: "Counting", desc: "Counting channels and what happens on a wrong number", icon: 'fas fa-sort-numeric-up', tags: "counting count numbers game channel streak reset delete" },
    { page: 'minigames', section: 'games', title: "Minigames", desc: "Cat Bot, Grow a Tree and timezone conversion", icon: 'fas fa-dice', tags: "minigames cat catbot tree grow timezone games spawn fun" },
    { page: 'digimon', section: 'games', title: "Digimon", desc: "Partners, wild spawns, trades, the market and the daily quiz", icon: 'fas fa-dragon', tags: "digimon digivolve partner tame evolve quiz trade market battle" },
    // Greenhouse Tycoon (v2, phase 4) replaces the old game's page; ?page=cfx is an alias of it (PAGE_ALIASES).
    { page: 'greenhouse', section: 'economy', title: "Greenhouse Tycoon", desc: "Members who play, the season and where to play", icon: 'fas fa-seedling', tags: "greenhouse tycoon certifried cfx plants garden breeding hybrids idle season leaderboard standings weekly challenge quests twitch panel extension web game arcade" },
    { page: 'owo', section: 'games', title: "Critters", desc: "The /owo game: hunting, teams, weapons and battles", icon: 'fas fa-paw', tags: "owo critters hunt zoo animals catch mini-game rarity pet collection legendary weapon battle quest acorns" },
    { page: 'rpg', section: 'games', title: "RPG", desc: "Characters, quests and battles", icon: 'fas fa-dragon', tags: "rpg character quest battle adventure" },
    // economy
    { page: 'economy', section: 'economy', title: "Economy", desc: "Currency, shop and transactions", icon: 'fas fa-coins', tags: "economy currency coins shop balance transfer" },
    { page: 'gambling', section: 'economy', title: "Gambling", desc: "Casino games and bet limits", icon: 'fas fa-dice', tags: "gambling casino dice slots bet" },
    { page: 'trading', section: 'economy', title: "Trading", desc: "Member trades and card swaps", icon: 'fas fa-handshake', tags: "trading trade vouch reputation dispute marketplace escrow" },
    // gamenews
    { page: 'free-games', section: 'gamenews', title: "Free games", desc: "Free game alerts from Epic, Steam, GOG and Prime", icon: 'fas fa-gift', tags: "free games epic steam gog prime gaming notifications" },
    { page: 'game-news', section: 'gamenews', title: "Game news", desc: "Patch notes and updates for 75+ games", icon: 'fas fa-newspaper', tags: "game news patch notes updates patchbot rss steam fortnite call of duty announcements" },
    { page: 'steam-library', section: 'gamenews', title: "Steam library", desc: "Who owns which game, for game nights", icon: 'fab fa-steam', tags: "steam library who owns games game night common games in common owned tally planning lfg multiplayer" },
    // streams
    { page: 'streamers', section: 'streams', title: "Streamers", desc: "Tracked streamers and go-live alerts", icon: 'fas fa-broadcast-tower', tags: "twitch kick youtube tiktok freshtok live notifications go-live stream-ended vod embed delete edit webhook teams subscribe announce" },
    { page: 'role-sync', section: 'streams', title: "Twitch role sync", desc: "Give Discord roles to your Twitch VIPs and moderators", icon: 'fas fa-arrows-rotate', tags: "twitch role sync subscriber sub vip moderator roles link broadcaster" },
    { page: 'teams', section: 'streams', title: "Stream teams", desc: "Follow a whole Twitch team", icon: 'fas fa-users', tags: "stream teams twitch team members follow" },
    { page: 'announcements', section: 'streams', title: "Live alert style", desc: "How go-live posts look", icon: 'fas fa-paintbrush', tags: "live alert appearance embed style go-live message template" },
    { page: 'stream-ended', section: 'streams', title: "When a stream ends", desc: "Edit or delete the go-live post afterwards", icon: 'fas fa-circle-stop', tags: "stream ended vod edit delete go-live post offline" },
    { page: 'auto-track', section: 'streams', title: "Auto-track", desc: "Track members who go live on Twitch, and route alerts by role", icon: 'fas fa-user-plus', tags: "auto track role streamer add automatically" },
    { page: 'twitch-schedules', section: 'streams', title: "Twitch schedules", desc: "Post each streamer's Twitch schedule as an image", icon: 'fab fa-twitch', tags: "twitch schedule sync calendar image poster weekly" },
    { page: 'schedule-calendar', section: 'streams', title: "Schedule calendar", desc: "Fill in your own month and post it as a poster", icon: 'fas fa-calendar-days', tags: "calendar schedule month poster custom stream days" },
    { page: 'twitch-clips', section: 'streams', title: "Twitch clips", desc: "Post new clips to a channel", icon: 'fas fa-film', tags: "twitch clips clip highlights auto-post new clips feed" },
    { page: 'tiktok', section: 'streams', title: "TikTok", desc: "TikTok live alerts and new videos", icon: 'fab fa-tiktok', tags: "tiktok freshtok video notifications vod new post content creator reels shorts feed" },
    { page: 'event-schedule', section: 'streams', title: "Event schedules", desc: "Events members submit, posted as a weekly timetable", icon: 'fas fa-stream', tags: "event schedule timetable weekly submit events categories twitch" },
    { page: 'self-promo', section: 'streams', title: "Self-promo", desc: "Track streamers posting in self-promo channels", icon: 'fas fa-bullhorn', tags: "self-promo promotion streamer auto-track channel" },
    // creators
    { page: 'feeds', section: 'creators', title: "Social feeds", desc: "YouTube, X, Bluesky and RSS posts", icon: 'fas fa-rss', tags: "youtube twitter bluesky rss social feed notifications" },
    { page: 'community-support', section: 'creators', title: "Community support", desc: "Raids, shoutouts and top supporters", icon: 'fas fa-hands-helping', tags: "community support raid shoutout leaderboard affiliate" },
    { page: 'throne', section: 'creators', title: "Throne wishlists", desc: "Wishlist changes and gifts", icon: 'fas fa-crown', tags: "throne wishlist gifts gifter leaderboard notifications crowdfund" },
    { page: 'fourthwall', section: 'creators', title: "Fourthwall shop", desc: "Catalog change alerts for any Fourthwall shop", icon: 'fas fa-shopping-bag', tags: "fourthwall shop merch store catalog product variant price drop sale restocked back in stock sold out notifications" },
    { page: 'kofi', section: 'creators', title: "Ko-fi", desc: "Roles for Ko-fi tips and memberships", icon: 'fas fa-mug-hot', tags: "kofi ko-fi donation supporter tip subscription membership roles webhook" },
    { page: 'automemes', section: 'creators', title: "Auto memes", desc: "Paused: Reddit closed its API to bots", icon: 'fas fa-laugh-squint', tags: "memes auto-post humor reddit funny" },
    // media
    { page: 'music', section: 'media', title: "Music", desc: "Player, DJ role and voices", icon: 'fas fa-music', tags: "music play queue dj voice tts piper song" },
    { page: 'soundboard', section: 'media', title: "Soundboard", desc: "Upload clips and play them in voice", icon: 'fas fa-volume-high', tags: "soundboard sound sfx clip audio voice meme upload play sounds" },
    // replies
    { page: 'custom-commands', section: 'replies', title: "Custom commands", desc: "Commands with your own responses", icon: 'fas fa-terminal', tags: "custom commands create response trigger prefix" },
    { page: 'autoresponders', section: 'replies', title: "Auto-responses", desc: "Reply automatically to trigger phrases", icon: 'fas fa-reply', tags: "auto response trigger autoresponder automation reply phrase keyword" },
    { page: 'tags', section: 'replies', title: "Tags", desc: "Saved snippets members can recall", icon: 'fas fa-tag', tags: "tags quick response snippet shortcut" },
    // automation
    { page: 'announce', section: 'automation', title: "Announce", desc: "Post an announcement with an image", icon: 'fas fa-bullhorn', tags: "announce announcement post picture image giveaway event news broadcast" },
    { page: 'custom-embeds', section: 'automation', title: "Custom embeds", desc: "Build and post embed messages", icon: 'fas fa-newspaper', tags: "custom embeds rich message announcement post info rules" },
    { page: 'schedule', section: 'automation', title: "Schedules", desc: "Plan events, their days and the runs on each", icon: 'fas fa-calendar-alt', tags: "schedule events marathon runs planner timetable speedrun calendar planning" },
    { page: 'reminders', section: 'automation', title: "Reminders", desc: "Reminders posted in a channel, once or repeating", icon: 'fas fa-bell', tags: "reminders timer schedule notification repeat recurring" },
    { page: 'scheduled-messages', section: 'automation', title: "Scheduled messages", desc: "Post a message on a repeating schedule", icon: 'fas fa-clock', tags: "scheduled messages recurring repeat timer auto message autopost interval daily weekly monthly announcement timed post" },
    { page: 'timecapsules', section: 'automation', title: "Time capsules", desc: "Messages delivered at a future date", icon: 'fas fa-hourglass-half', tags: "time capsule future message delayed" },
    { page: 'holidays', section: 'automation', title: "Holiday countdowns", desc: "Live \"days until Christmas\" messages and share links", icon: 'fas fa-calendar-day', tags: "holiday countdown christmas halloween easter diwali hanukkah ramadan eid lunar new year valentines st patrick thanksgiving independence canada 420 four twenty juneteenth days until share link embed og unfurl" },
    { page: 'weather', section: 'automation', title: "Weather", desc: "Severe weather alerts by direct message", icon: 'fas fa-cloud-sun', tags: "weather alerts severe storm warning zip location forecast" },
    { page: 'sticky', section: 'automation', title: "Sticky messages", desc: "Keep a message at the bottom of a channel", icon: 'fas fa-thumbtack', tags: "sticky messages pin persistent channel" },
    { page: 'auto-purge', section: 'automation', title: "Auto purge", desc: "Clear channels on a schedule", icon: 'fas fa-broom', tags: "auto purge clear delete schedule timer cleanup self-promo midnight" },
    { page: 'smart-purge', section: 'automation', title: "Smart purge rules", desc: "Expire posts by age and content", icon: 'fas fa-hourglass-half', tags: "smart purge rules expire ttl timed delete message age content filter phrases images uploads links attachments temporary ephemeral self-destruct" },
    { page: 'utilities', section: 'automation', title: "Utilities", desc: "Auto-roles, temporary voice channels and auto-publish", icon: 'fas fa-toolbox', tags: "utilities auto-roles temp channels auto-publish" },
    // logging
    { page: 'logging', section: 'logging', title: "Logging", desc: "Which events are logged and where", icon: 'fas fa-file-alt', tags: "logging member join leave message delete edit voice channel role ban unban audit" },
    { page: 'action-log', section: 'logging', title: "Action log", desc: "Server events and moderation actions the bot recorded", icon: 'fas fa-history', tags: "action log history audit events moderation roles voice channels commands" },
    { page: 'analytics', section: 'logging', title: "Analytics", desc: "Member and message activity over time", icon: 'fas fa-chart-line', tags: "analytics statistics insights activity" },
    { page: 'activity-audit', section: 'logging', title: "Activity audit", desc: "Who is active, by messages and voice time", icon: 'fas fa-user-clock', tags: "activity audit inactive members voice vc messages engagement prune dormant quiet lurkers census report leavers" },
    { page: 'serverstats', section: 'logging', title: "Server stats", desc: "Top members, channels and busiest hours", icon: 'fas fa-server', tags: "server stats statistics leaderboard top members channels busiest hours heatmap messages voice commands joins leaves csv" },
    { page: 'stat-displays', section: 'logging', title: "Stat display channels", desc: "Voice channels that show stats, time and date", icon: 'fas fa-tv', tags: "stat display channels voice time date clock members online bots roles boosts counter" },
    { page: 'emojistats', section: 'logging', title: "Emoji stats", desc: "Which emojis are used most", icon: 'fas fa-smile', tags: "emoji statistics usage tracking popular" },
    // support
    { page: 'tickets', section: 'support', title: "Tickets", desc: "Support ticket panels and logs", icon: 'fas fa-ticket-alt', tags: "tickets support panel form alert log help" },
    { page: 'forms', section: 'support', title: "Forms", desc: "Applications and surveys", icon: 'fas fa-file-alt', tags: "forms application template submission" },
    { page: 'todo', section: 'support', title: "Task lists", desc: "Task list embeds that update live", icon: 'fas fa-tasks', tags: "todo task list checklist embed manage" },
]);

/** Spec category (core/feature-config-spec.js CATEGORIES) -> section key. */
export const SPEC_CATEGORY_SECTION = Object.freeze({
    'Core': 'setup',
    'Streaming & Content': 'streams',
    'Community': 'engagement',
    'Economy & Games': 'games',
    'Moderation & Security': 'moderation',
    'Analytics & Logging': 'logging',
    'Automation & Scheduling': 'automation',
    'Server Tools': 'setup',
});

/**
 * Generated pages filed somewhere other than their spec category says. With the
 * specific sections most generated pages are listed here, so where each one sits
 * is decided in this file rather than by a broad spec category.
 */
export const SPEC_OVERRIDES = Object.freeze({
    // setup
    'webhooks': 'automation',
    // moderation
    'automod-spam': 'moderation',
    'automod-heat': 'moderation',
    // joining
    'orientation': 'joining',
    // roles
    'colorroles': 'roles',
    'sticky-roles': 'roles',
    // engagement
    'rankcard': 'engagement',
    'communitygoals': 'engagement',
    'qotd': 'engagement',
    'cannabis': 'engagement',
    'grow': 'engagement',
    'selfcare': 'engagement',
    // events
    'event-reminders': 'events',
    'tournaments': 'events',
    // games
    'cah': 'games',
    'emojihunt': 'games',
    'fishing': 'games',
    'sprites': 'games',
    'fun': 'engagement',
    'arcade': 'games',
    'pokemon': 'games',
    'digimon': 'games',
    'wordgames': 'games',
    'windrose': 'games',
    // economy
    'loyalty': 'economy',
    'marketplace': 'economy',
    // gamenews
    'deals': 'gamenews',
    'steam-watch': 'gamenews',
    // streams
    'stream-signup': 'streams',
    // creators
    'shoutout': 'creators',
    'buymeacoffee': 'creators',
    'showcase': 'creators',
    'fourthwall': 'creators',
    // media
    'vc-sounds': 'media',
    'ai-dj': 'media',
    'voice-recording': 'media',
    'tts': 'media',
    'voice-reader': 'media',
    'voice-transcription': 'media',
    'cinema': 'media',
    'jellyfin': 'media',
    // replies
    'context-menus': 'replies',
    'ai-assistant': 'replies',
    'imagine': 'replies',
    'knowledge': 'replies',
    // automation
    'forums': 'automation',
    // logging
    'message-evidence': 'logging',
    'log-retention': 'logging',
    // support
    'modmail': 'support',
    'staff-contact': 'support',
    'bugs': 'support',
});

const SECTION_KEYS = new Set(SECTIONS.map((s) => s.key));

/** Section a generated feature-config page belongs in ('other' when unmapped). */
export function sectionForSpec(key, spec) {
    const s = SPEC_OVERRIDES[key] || SPEC_CATEGORY_SECTION[spec && spec.category];
    return SECTION_KEYS.has(s) ? s : 'other';
}

/**
 * The full navigation for one render: every section with its items, hand-registered
 * pages first, then generated pages sorted by label. Hand-registered pages win when a
 * key exists in both (e.g. modmail has its own partial and a spec entry).
 *
 * @param {object} specs  FEATURE_SPECS from core/feature-config-spec.js (may be {}).
 * @returns {{ key, label, icon, desc, items: { page, title, desc, icon, tags, generated, unwired }[] }[]}
 */
export function buildManageNav(specs = {}) {
    const bySection = new Map(SECTIONS.map((s) => [s.key, []]));
    bySection.set('other', []);
    const taken = new Set();
    for (const p of PAGES) {
        bySection.get(p.section).push({ ...p, generated: false, unwired: false });
        taken.add(p.page);
    }
    const generated = [];
    for (const [key, spec] of Object.entries(specs || {})) {
        if (!spec || !spec.label || taken.has(key)) continue;
        generated.push({
            page: key,
            section: sectionForSpec(key, spec),
            title: spec.label,
            desc: spec.blurb || '',
            icon: `${spec.iconPack || 'fas'} ${spec.icon || 'fa-sliders'}`,
            tags: [key, spec.label, ...(spec.commands || []).map((c) => String(c).replace(/\//g, '')), spec.blurb || '']
                .join(' ').toLowerCase(),
            generated: true,
            unwired: !!spec.unwired,
        });
    }
    generated.sort((a, b) => a.title.localeCompare(b.title));
    for (const g of generated) bySection.get(g.section).push(g);

    const out = SECTIONS.map((s) => ({ ...s, items: bySection.get(s.key) }));
    const other = bySection.get('other');
    if (other.length) out.push({ key: 'other', label: 'Other', icon: 'fa-ellipsis', desc: 'Pages without a section yet', items: other });
    return out;
}

/**
 * Explicit "related pages" pairs, shown at the bottom of each feature page (relatedPages()).
 * Only the obvious cross-section neighbours are listed: the pages an admin usually sets up
 * together or moves between. Listing is one-way here and applied both ways, so a pair is written
 * once. The rest of the list is filled from the page's own section.
 */
export const RELATED = Object.freeze({
    'verification': ['welcome', 'role-manager', 'rejoin', 'join-requests', 'security'],
    'moderation': ['automod', 'logging', 'action-log', 'quarantine'],
    'automod': ['automod-spam', 'link-filter', 'commission-filter', 'message-threats'],
    'security': ['advanced-protection', 'protection-settings', 'quarantine'],
    'advanced-protection': ['protection-settings', 'global-ban'],
    'protection-settings': ['name-filters', 'avatar-protection'],
    'phishing': ['link-filter', 'domain-reports', 'message-threats'],
    'name-filters': ['avatar-protection', 'nsfw-protection'],
    'welcome': ['reaction-roles', 'orientation', 'utilities'],
    'role-manager': ['reaction-roles', 'bulk-roles', 'sticky-roles', 'colorroles'],
    'logging': ['message-evidence', 'log-retention', 'action-log', 'activity-audit'],
    'activity-audit': ['analytics', 'verification'],
    'leveling': ['rankcard', 'achievements', 'role-manager'],
    'giveaways': ['polls', 'event-reminders'],
    'tickets': ['modmail', 'forms', 'staff-contact'],
    'streamers': ['announcements', 'stream-ended', 'auto-track', 'teams'],
    'custom-commands': ['autoresponders', 'tags', 'command-center'],
    'commands': ['command-center', 'permissions'],
    'appearance': ['theme', 'language'],
    'economy': ['gambling', 'trading', 'loyalty'],
    'music': ['ai-dj', 'soundboard', 'tts'],
    'schedule': ['event-schedule', 'twitch-schedules', 'schedule-calendar', 'reminders'],
    'scheduled-messages': ['reminders', 'announce', 'custom-embeds'],
    'auto-purge': ['smart-purge', 'sticky'],
});

/**
 * Up to `limit` pages to suggest at the bottom of `page`: its explicit pairs first (both
 * directions of RELATED), then the pages next to it in its own section, nearest first. Only
 * pages present in `nav` (the buildManageNav() result for this render) and never the page itself.
 *
 * @returns {{ page, title, desc, icon, section }[]}
 */
export function relatedPages(page, nav, { limit = 5 } = {}) {
    const target = PAGE_ALIASES[page] || page;
    const items = new Map();
    let home = null;
    for (const sec of nav || []) {
        for (const it of sec.items || []) {
            items.set(it.page, { page: it.page, title: it.title, desc: it.desc, icon: it.icon, section: sec.key });
            if (it.page === target) home = sec;
        }
    }
    if (!items.has(target)) return [];
    const picked = [];
    const add = (p) => {
        if (picked.length >= limit || p === target || !items.has(p) || picked.some((x) => x.page === p)) return;
        picked.push(items.get(p));
    };
    for (const p of RELATED[target] || []) add(p);
    for (const [from, list] of Object.entries(RELATED)) if (list.includes(target)) add(from);
    if (home) {
        const list = home.items.map((it) => it.page);
        const at = list.indexOf(target);
        const byDistance = list.map((p, i) => [p, Math.abs(i - at), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]);
        for (const [p] of byDistance) add(p);
    }
    return picked;
}

export default { SECTIONS, PAGES, PAGE_ALIASES, SPEC_CATEGORY_SECTION, SPEC_OVERRIDES, RELATED, sectionForSpec, buildManageNav, relatedPages };
