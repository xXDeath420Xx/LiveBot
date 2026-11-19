// Checked against: commands/community/social.js (twitter, feed groups), jobs/social-feed-scheduler.js,
// core/youtube-feed.js, core/twitter-feed.js, core/bluesky-feed.js, core/rss-feed.js, core/feed-message.js,
// dashboard/views/partials/manage/feeds.ejs.
export default {
    slug: 'social-feeds',
    title: 'Social and new-post feeds',
    area: 'streams',
    summary: 'Post new YouTube uploads, X posts, Bluesky posts and RSS items (blogs and podcasts) in a channel.',
    result: {
        image: 'feeds-discord',
        caption: 'A new YouTube upload and a Bluesky post, as they appear in the channel.',
    },
    before: [
        'You need **Manage Server**. Feeds are on the dashboard under **Social feeds & creators**, then **Social feeds**.',
    ],
    steps: [
        {
            title: 'Add a YouTube channel',
            text: [
                'On the dashboard, paste the channel\'s link (for example `https://youtube.com/@name`), its @handle or its channel ID (it starts with `UC`) into **YouTube channel**, choose **Post to** and select **Add feed**. The bot looks up the channel ID and saves that; a link it cannot find is refused.',
                'Each YouTube feed can post videos, Shorts, and live streams and premieres; pick which in the feed\'s settings.',
            ],
            command: '/socials feed youtube-add channel-id:@channelname channel:#new-videos',
            image: 'feeds-page',
        },
        {
            title: 'Add an X account',
            text: [
                'Reposts and replies are left out unless you set `filter_retweets` or `filter_replies` to False. `media_only:True` posts only posts with an image or video.',
            ],
            command: '/socials twitter add username:maplehollowhq channel:#announcements',
        },
        {
            title: 'Add Bluesky accounts and RSS feeds',
            text: [
                'These are set up on the dashboard only. For Bluesky, enter the **Handle** (for example `name.bsky.social`). For RSS, paste the **Feed address** of a blog or podcast; podcast items get a link to the episode.',
            ],
        },
        {
            title: 'Fine-tune each feed',
            text: [
                'Open a feed to change **Post to**, add a **Ping role**, write the **Message**, and filter by title with **Title must contain** and **Skip titles containing**.',
                'Messages can use `{channel}`, `{title}`, `{type}` and `{url}` for YouTube; `{username}`, `{name}` and `{url}` for X; `{handle}`, `{name}` and `{url}` for Bluesky; and `{feed}`, `{title}`, `{url}` and `{author}` for RSS.',
            ],
        },
    ],
    notes: [
        'X is checked every 5 minutes; YouTube, Bluesky and RSS every 15 minutes. YouTube and Bluesky post at most 3 new items per check.',
        'A server can have up to 10 RSS feeds. A feed that fails 5 times in a row is paused for 24 hours, then tried again.',
        'Reddit feeds are not available: Reddit no longer lets bots read subreddits. Instagram, Facebook and Threads are not supported.',
        'Go-live alerts are separate: see the go-live guide.',
    ],
    related: ['go-live-alerts', 'schedules', 'welcome'],
};
