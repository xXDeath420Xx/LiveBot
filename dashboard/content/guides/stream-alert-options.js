// Checked against: dashboard/views/manage-tailwind.ejs (pageMap: announcements = the streaming partial's appearance tab, stream-ended = its
// streamers tab), dashboard/views/partials/manage/streaming.ejs (Announcement defaults, When a stream ends, Live role check, Recently removed),
// dashboard/views/partials/manage/live-style.ejs, dashboard/routes/api/features/live-style.js, core/stream-render-style.js (STYLES,
// STYLE_LABELS, streamer > channel > guild), dashboard/views/partials/manage/tiktok.ejs, jobs/tiktok-video-checker.js (every 5 minutes,
// View on TikTok button, 8 MB file), core/manage-nav.js.
export default {
    slug: 'stream-alert-options',
    title: 'Alert style, stream end and TikTok videos',
    area: 'streams',
    summary: 'Choose how go-live posts look for the server, a channel or one streamer, what happens to them when the stream ends, and post new TikTok videos.',
    result: {
        image: 'stream-alert-options-style',
        caption: 'Live announcement style: the server uses the custom card, one channel uses Discord\'s newer layout, and one streamer keeps the platform preview.',
    },
    before: [
        'You need **Manage Server**. The pages are on the dashboard under **Stream alerts**: **Live alert style**, **When a stream ends** and **TikTok**. Set up the streamers first, as in [Go-live alerts](/docs/guides/go-live-alerts).',
    ],
    steps: [
        {
            title: 'Choose how go-live posts look',
            text: [
                'On **Live alert style**, under **Live announcement style**, set the **Server default**: the platform\'s own live preview with the streamer\'s avatar (used when nothing is set), a custom card the bot draws (the same layout on every platform, never a missing thumbnail), or Components V2, Discord\'s newer layout with the preview in a gallery and a Watch button.',
                '**Per live channel** and **Per streamer** change it for one channel or one streamer. The most specific setting wins: a streamer\'s style follows them into every channel, and anyone left on **Inherit** follows their channel.',
                'The same page has the announcement defaults. **Post as the streamer** posts with the streamer\'s name and avatar instead of the bot\'s (it needs Manage Webhooks in the channel), and members with one of the **Roles never announced** are never posted.',
            ],
            image: 'stream-alert-options-style',
        },
        {
            title: 'Decide what happens when a stream ends',
            text: [
                'On **When a stream ends**, turn on **Edit on end** to rewrite the post as a "stream ended" summary (with the VOD link on Twitch), or **Keep on end** to leave it exactly as it was posted. With both off the post is deleted. Only one of the two can be on.',
                '**Save default** sets this for every streamer added from now on, however they are added: the dashboard, `/socials streamer add`, auto-track or team sync. Streamers you already have keep their own setting until you choose **Apply to all streamers**.',
                '**Live role check** on the same page checks every live role in use: that it still exists, that the bot can give it, and who still has it without being live. Choose **Run check**.',
            ],
        },
        {
            title: 'Post new TikTok videos',
            text: [
                'On **TikTok**, type the **TikTok username** (with or without the @), choose where to **Post videos to**, a **Role to mention** if you want one, and a **New video message**, then **Add creator**. The message can use `{username}`, `{title}`, `{description}`, `{url}` and `{everyone}`.',
                'New videos are checked every 5 minutes. Each post has a **View on TikTok** button, and the video file itself when it is under 8 MB. **Stop video feed** pauses one creator; **Video feed channel for everyone** moves every creator\'s videos to one channel.',
            ],
        },
    ],
    notes: [
        'TikTok live alerts are run from the Streamers page with the other platforms; any TikTok creator added there is checked for live streams.',
        'Streamers taken off the list, by staff or because the member left, show under **Recently removed** on the Streamers page and can be put back as they were.',
        'The announcement text above the post can use `{streamer}`, `{platform}`, `{game}`, `{title}`, `{url}` and `{everyone}`. The preview under it shows made-up stream details, and **Send test** posts it to the default channel without pinging anyone.',
    ],
    related: ['go-live-alerts', 'twitch-tools', 'social-feeds'],
};
