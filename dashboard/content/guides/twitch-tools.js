// Checked against: dashboard/views/partials/manage/streaming.ejs (auto-track, live channel routing, teams and role-sync tabs),
// dashboard/views/manage-tailwind.ejs (pageMap: auto-track, teams, role-sync), dashboard/views/partials/add-team-modal.ejs,
// events/presenceUpdate.js (Streaming status with a twitch.tv link, role match, already-tracked skip), dashboard/routes/features/auto-track.js,
// commands/admin/systems.js (autotrack, Administrator), commands/admin/admin.js (teamsync, Manage Server), jobs/team-sync-scheduler.js (hourly),
// jobs/twitch-role-sync-scheduler.js (every 15 minutes, member links, role removal, auto-off), dashboard/views/partials/manage/twitch-clips.ejs,
// jobs/twitch-clip-checker.js (every 10 minutes, 5 per check, clipEmbed), commands/admin/alerts.js (clips group),
// dashboard/views/partials/manage/community-support.ejs, events/communitySupportTracker.js, commands/admin/shoutout.js (/alerts shoutout),
// core/command-mounts.js (shoutout under alerts), core/manage-nav.js, docs/command-split-2026-11-18.md.
export default {
    slug: 'twitch-tools',
    title: 'Auto-track, stream teams, Twitch roles and clips',
    area: 'streams',
    summary: 'Announce members who go live without adding them by hand, follow whole Twitch teams, give roles to your Twitch VIPs and moderators, and post new clips.',
    result: {
        image: 'twitch-tools-auto-track',
        caption: 'An auto-track mapping: Regulars who go live on Twitch are announced in #stream-alerts and get the Live now role.',
    },
    before: [
        'You need **Manage Server**. The pages are on the dashboard under **Stream alerts**: **Auto-track**, **Stream teams**, **Twitch role sync** and **Twitch clips**. **Community support** is under **Social feeds & creators**.',
        'Go-live posts themselves (the default channel, the live role and the message) are set up as in [Go-live alerts](/docs/guides/go-live-alerts).',
    ],
    steps: [
        {
            title: 'Announce members who go live on Twitch',
            text: [
                'On **Auto-track**, under **Auto-track mappings**, choose a **Role** (or **Any member**), the **Announcement channel**, a **Live role**, **When the stream ends** and, if you like, a **Minimum level** members must reach first, then **Add mapping**. When a member with that role starts streaming on Twitch and Discord shows it in their status (Streaming, with a twitch.tv link), they are added as a streamer with those settings.',
                'Members already announced through self-promo, a team or a streamer you added are skipped, so nobody is announced twice.',
                '**Live channel routing** above it sends some streamers somewhere else, for example subscribers to #subs-live. Give a rule a **Name**, a **Priority**, a **Live channel** and **Roles**; the highest priority rule that matches wins. Roles are checked again right before each post, so a lapsed subscriber falls back to the normal channel. A rule with no roles picks up your Twitch subscriber roles (tiers 1 to 3).',
            ],
            command: '/systems autotrack setup channel:#stream-alerts role:@Regulars',
            image: 'twitch-tools-auto-track',
        },
        {
            title: 'Follow a whole stream team',
            text: [
                'On **Stream teams**, choose **Add team**. **Twitch Team Name** is the last part of the team\'s address: for twitch.tv/team/mapleguild it is `mapleguild`. Pick an **Announcement Channel** (or the server default) and a **Live Role**.',
                'A **Live board channel** gets one message listing which team members are live right now, updated every minute. Use a channel nobody else posts in, so it stays at the top.',
                'Every member of the team is announced, and members who join the team later are picked up by the hourly team sync. Removing the team removes its streamers.',
            ],
            command: '/admin teamsync team team_name:mapleguild',
        },
        {
            title: 'Give Discord roles to your Twitch VIPs and moderators',
            text: [
                'On **Twitch role sync**, the broadcaster chooses **Connect Twitch account** and signs in. Pick the **VIP role** and the **Moderator role**, turn on **Sync roles** and choose **Save settings**.',
                'Roles are checked every 15 minutes, or at once with **Sync now**, and taken away when someone stops being a VIP or moderator. A Discord member is matched to their Twitch account when the bot has seen them streaming on Twitch, when they are a tracked streamer linked to their Discord account, or when you link them under **Twitch moderators and VIPs**. **Link high-confidence matches** applies every suggestion that scores 90 or more.',
                '**Add VIP** and **Add moderator** give the role on the broadcaster\'s Twitch channel straight away. **Remove Twitch VIP when they leave** takes away a member\'s Twitch VIP when they leave this Discord server.',
            ],
        },
        {
            title: 'Post new clips',
            text: [
                'On **Twitch clips**, type the **Twitch streamer** (a name or a twitch.tv link), choose the **Channel**, **Whose clips** (anyone\'s, or only the streamer\'s own) and the **Minimum views**, then **Add feed**.',
                'Only clips made after you add the feed are posted. Feeds are checked every 10 minutes and at most five clips go out per check. A clip below the minimum views is posted later, once it gets there.',
            ],
            command: '/alerts clips add streamer:rowanpike_plays channel:#stream-alerts',
            image: 'twitch-tools-clip',
        },
        {
            title: 'Reward members who raid and support',
            text: [
                'On **Community support**, turn on **Community support** and pick a **Raid channel**, a **Support channel** and a **Shoutout channel**. A post in the raid channel counts as a raid; a post in the support channel counts as support, or as a raid if it says "raided". The member mentions the streamer or posts their twitch.tv link.',
                'Under **Points**, raiding a non-affiliate is worth 10, raiding an affiliate 5 and a support post 3 unless you change them (1 to 100). Early on the 1st of each month (UTC) the top 10 supporters are posted in the shoutout channel, and their streams are announced there for that month.',
            ],
            command: '/alerts shoutout leaderboard',
        },
    ],
    notes: [
        'Auto-track only sees Twitch, and only while Discord shows the member as Streaming. For Kick, YouTube and the rest, add the streamer on the Streamers page.',
        '`/admin teamsync exclude` stops team sync from adding a streamer again in this server, and `/admin teamsync include` lets it.',
        'If Twitch stops accepting the broadcaster\'s connection, role sync turns itself off and says so in the server log. Choose **Reconnect** on the Twitch role sync page to turn it back on.',
        'Clip posts show the title, the game, the length and the views, and say who made the clip.',
        '`/systems` and `/alerts` are for administrators by default.',
    ],
    related: ['go-live-alerts', 'stream-alert-options', 'self-promo'],
};
