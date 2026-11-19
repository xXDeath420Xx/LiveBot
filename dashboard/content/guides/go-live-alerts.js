// Checked against: commands/community/social.js + social-streamer-handler.js, utils/announcer.js,
// core/stream-manager.js (live roles), jobs/stream-check-scheduler.js, migrations/202_stream_end_defaults.js,
// dashboard/views/partials/manage/streaming.ejs and add-streamer.ejs, core/stream-render-style.js.
export default {
    slug: 'go-live-alerts',
    title: 'Go-live alerts for Twitch, YouTube and Kick',
    area: 'streams',
    summary: 'Post in a channel when a streamer goes live, and give them a live role while they stream.',
    result: {
        image: 'go-live-discord',
        caption: 'A Twitch go-live post with the card style. The default style shows the platform\'s own live preview instead.',
    },
    before: [
        'You need **Manage Server**. Pick the channel the alerts should go to, and create the live role if you want one.',
    ],
    steps: [
        {
            title: 'Set the server defaults',
            text: [
                'Set the default channel, the live role and the message once. Every streamer you add uses them unless you change that streamer.',
                'On the dashboard: **Stream alerts**, then **Streamers**, then **Announcement defaults**. Streamers left on "Server default" are not announced until a default channel is set.',
            ],
            command: '/socials streamer setup channel:#stream-alerts live-role:@Live now',
        },
        {
            title: 'Add a streamer',
            text: [
                '`platform` is twitch, kick, youtube, tiktok or rumble. `discord-user` links the streamer to their Discord account, which is who gets the live role. Twitch and Kick usernames are checked when you add them.',
                'On the dashboard, select **Add streamer** and fill in the platform, the username or channel ID, the Discord member and, if you want, a different channel or message.',
            ],
            command: '/socials streamer add platform:twitch username:rowanpike_plays discord-user:@Rowan Pike',
            image: 'go-live-streamers',
        },
        {
            title: 'Write the message',
            text: [
                'The text above the alert can use `{streamer}`, `{platform}`, `{url}`, `{title}`, `{game}` and `{everyone}`. To ping a role, set a **Ping role** in the streamer\'s edit dialog on the Streamers page; the ping goes out as its own message.',
            ],
        },
        {
            title: 'Check the live role',
            text: [
                'While a streamer is live, their linked Discord member gets the live role; it is taken back when they go offline. A role set on the streamer wins over a stream team\'s role, which wins over the server default.',
                'The bot can only give roles below its own highest role. The **Live role check** panel on the Streamers page shows anything that is stopping it.',
            ],
        },
        {
            title: 'Choose what happens when the stream ends',
            text: [
                'By default the alert is deleted when the stream ends. Turn on **Edit the announcement to "stream ended"** to keep it instead: it turns grey and links the VOD when there is one. The **When a stream ends** page sets this for the whole server.',
            ],
        },
    ],
    notes: [
        'Streams are checked every minute, and Twitch also tells the bot directly, so Twitch alerts are usually the fastest. A stream counts as ended after six checks in a row find it offline.',
        'The **Live alert style** page chooses the look: the platform\'s live preview (the default), the card shown above, or a newer layout with a Watch button.',
        '`/socials streamer check-live` shows who is live now; `/socials streamer import` and `export` move a list of streamers as a CSV file.',
        'TikTok new-video posts are set up on the **TikTok** page under Stream alerts.',
    ],
    related: ['social-feeds', 'schedules', 'reaction-roles'],
};
