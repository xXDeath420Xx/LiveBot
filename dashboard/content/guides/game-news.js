// Checked against: dashboard/views/partials/manage/free-games.ejs, dashboard/routes/api/features/free-games.js (add, edit, filters,
// SUBSCRIPTION_TOGGLES, test post), core/free-games-manager.js (buildAnnouncementEmbed, the message text), jobs/free-games-scheduler.js
// (one store every 15 minutes), commands/admin/alerts.js (freegames, gamenews groups, Administrator), dashboard/views/partials/manage/game-news.ejs,
// dashboard/routes/api/features/game-news.js (5 to 1440 minutes, custom providers), core/game-news-presets.js (75 presets, fortnite-news),
// core/game-patch-watcher-manager.js (the post, keyword filters), core/feature-config-spec.js (steam-watch), core/steam-watcher-manager.js (5/30/120 minutes), core/manage-nav.js (Game news & deals),
// commands/info/media.js (steam group, Manage Channels), jobs/steam-watch-scheduler.js, dashboard/views/partials/manage/steam-library.ejs,
// commands/games/steam-library.js, jobs/steam-library-sync.js, docs/command-split-2026-11-18.md (/media is text, /steam and /alerts are slash).
export default {
    slug: 'game-news',
    title: 'Free games, patch notes and Steam',
    area: 'tools',
    summary: 'Post free games and game patch notes in a channel, watch Steam games, and see who owns what for game nights.',
    result: {
        image: 'game-news-discord',
        caption: 'A free game alert: the store, the old price struck through, how long it stays free, and links to claim it.',
    },
    before: [
        'You need **Manage Server**. The pages are on the dashboard under **Game news & deals**: **Free games**, **Game news**, **Steam library** and **Steam Watch**.',
    ],
    steps: [
        {
            title: 'Post free games in a channel',
            text: [
                'On **Free games**, choose the **Channel**, a **Role to mention** if you want one, and the **Message text** (up to 200 characters; left empty, the standard Free Game Alert line is used). Choose **Add subscription**. Each channel can have one subscription.',
                'A new subscription posts free-to-keep games from Steam, Epic Games, GOG and Prime Gaming. **Filters** changes that: the offers (**Free to keep**, **Free weekends**, **DLC & expansions**, **Prime Gaming**, **Game Pass**), the stores, and the platforms Windows, macOS and Linux.',
                '**Send test** posts the newest free game the bot has seen to that channel, without pinging anyone. The stores are checked one at a time, one every 15 minutes, and new alerts go out every 15 minutes.',
            ],
            command: '/alerts freegames subscribe channel:#free-games mention-role:@Gamers',
            image: 'game-news-free-games',
        },
        {
            title: 'Follow patch notes and game news',
            text: [
                'On **Game news**, pick a title under **Game or source** from the catalogue of 75 games, Fortnite and Call of Duty included, or choose **Custom source**: an RSS or Atom feed, a game\'s Steam news by its app ID (only the developer\'s own posts), or an X account.',
                'Choose the **Channel**, a **Role to ping** if you want one, and **Check every** (from 15 minutes to 24 hours). **Only post if it mentions** and **Never post if it mentions** take words separated by commas, so one busy feed can be split over two channels.',
                'A new watcher first notes what the source already has, so it starts with the next new item. **Test** fetches the newest item and shows it as it would be posted, without posting it.',
            ],
            command: '/alerts gamenews add channel:#game-news game:Fortnite',
        },
        {
            title: 'Watch a Steam game for news, prices and workshop items',
            text: [
                'Type `/media steam watch` as a message with the game\'s name or app ID, what to watch (news updates, price changes, workshop items, free promotions or Valve news) and the channel. Watching, unwatching, mentions, the currency and `check` need **Manage Channels**; `news`, `price`, `search` and `watchers` are for everyone.',
                'A game is checked every 5 minutes for 3 hours after it updates, then every 30 minutes, and every 2 hours once it has gone quiet. The **Steam Watch** page lists them and sets the **Price currency** for price alerts. `/media steam watchers` lists them with their IDs and `/media steam unwatch` removes one.',
            ],
        },
        {
            title: 'See who owns what for game nights',
            text: [
                'Members link their Steam with `/steam link`, which opens Steam\'s own sign-in. Only their list of owned games is kept; their SteamID is never shown, not even to you.',
                '`/steam who` lists who here owns a game, `/steam common` the games a group all own (your voice channel if you pick nobody), and `/steam night` posts a game night card with RSVP buttons.',
                'On **Steam library**, choose a **Board channel** and **Post board** for a live list of the most-owned games with **Link Steam**, **Refresh** and **Remove me** buttons. **Games on the board** is 5 to 30, and **Only list games owned by at least** 1 to 50 members.',
            ],
            command: '/steam night game:Stardew Valley when:Friday 9pm EST',
        },
    ],
    notes: [
        'The `/alerts` commands are for administrators by default; the dashboard needs Manage Server. `/alerts freegames current` shows the free games right now and `/alerts gamenews catalogue` lists every game you can pick by name.',
        'Epic Games alerts link to the store page and to the Epic Games Launcher; the other stores link to the store page.',
        'Fortnite news is read from fortnite.com/news; most other titles use the game\'s Steam news or the publisher\'s feed.',
        'Steam libraries are read again about once a day, and when a member uses `/steam refresh`. A private game list counts as no games. Members who leave drop off the tally at once and are deleted after 30 days; `/steam unlink everywhere:true` deletes a member\'s link and games from every server.',
        '**Allow pasted profile links** on the Steam library page lets members paste a profile link instead of signing in. Anyone could paste someone else\'s, so turn it off to require Steam sign-in.',
    ],
    related: ['social-feeds', 'announcements', 'chat-games'],
};
