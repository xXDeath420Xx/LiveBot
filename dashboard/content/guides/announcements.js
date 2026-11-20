// Checked against: dashboard/views/partials/manage/announce.ejs, dashboard/routes/api/features/announce.js,
// core/announcement-card.js, core/announcement-manager.js, commands/admin/announce.js,
// dashboard/views/partials/manage/custom-embeds.ejs, dashboard/server.js (create-custom-embed, customEmbeds,
// update-autopublisher), commands/admin/admin.js (embed group),
// dashboard/views/partials/manage/scheduled-messages.ejs, dashboard/routes/api/features/scheduled-messages.js,
// core/scheduled-announcements-manager.js, jobs/announcement-scheduler.js, commands/admin/alerts.js,
// commands/admin/alerts/announce.js, dashboard/views/partials/manage/sticky.ejs,
// dashboard/routes/features/content-management.js, commands/tools/notes.js, events/messageCreate.js (sticky repost),
// dashboard/views/partials/manage/utilities.ejs, commands/admin/alerts/autopublish.js, core/auto-publisher.js,
// core/manage-nav.js, core/universal-commands.js (describePath), dashboard/middleware/auth.js.
export default {
    slug: 'announcements',
    title: 'Announcements, embeds and scheduled posts',
    area: 'tools',
    summary: 'Post announcements and embeds from the dashboard, repeat a post on a schedule, keep a message at the bottom of a channel and publish announcement channels automatically.',
    result: {
        image: 'announcements-page',
        caption: 'The Announce page: the announcement on the left, and on the right a preview of how it will look in Discord.',
    },
    before: [
        'You need **Manage Server**. Everything here is on the dashboard under **Scheduling & automation**: **Announce**, **Custom embeds**, **Scheduled messages**, **Sticky messages** and **Utilities**.',
    ],
    steps: [
        {
            title: 'Post an announcement with a picture',
            text: [
                'Open **Announce**. Pick the **Channel**, add a **Picture** if you want one (PNG, JPEG, GIF or WebP, up to 10 MB) and write the **Title** and **Text**. Blank lines make paragraphs, and Discord formatting works. **Small print** goes under a line at the bottom, **Ping** mentions a role or @everyone, and **Stripe colour** sets the colour down the side.',
                'The picture sits above the text. Title, text, small print and ping share a limit of 4,000 characters, and the counter under the form shows how many you have used. Nothing is posted until you press **Post**.',
                'Your posts are listed under **Recent announcements**. **Edit** changes the message in Discord, and **Delete** removes it from Discord.',
            ],
            command: '/manage announce post channel:#announcements',
        },
        {
            title: 'Build an embed',
            text: [
                'Open **Custom embeds**. A **Channel** and a **Title** or **Description** are needed; the **Colour**, **Title link**, **Author name**, **Author icon URL**, **Thumbnail URL**, **Image URL** and **Footer** are optional. The preview next to the form updates as you type.',
                '**Save as draft** keeps it on the page, and **Create and post** sends it straight away. If the bot could not post it, the page says so and it is listed as a Draft; press **Post** on it to try again. A posted embed can be changed with **Save and update the Discord message**.',
                '**Start from JSON** fills the form from embed JSON you paste, and **Copy JSON** copies a saved embed the same way. Fields and buttons in pasted JSON are skipped.',
            ],
        },
        {
            title: 'Repeat a post on a schedule',
            text: [
                'Open **Scheduled messages** and select **New message**. Pick the **Channel**, write the **Message**, or turn on **Add an embed** for a boxed post, and choose a **Ping** if you want one.',
                'Under **When to post** pick **Repeat every** (from every 10 minutes to every 90 days), **On days** (the weekdays you tick, at one time), **Monthly** (a day of the month) or **Once**. Times are in the server\'s timezone. **End date** and **Stop after** end it on their own, and **Send now** posts it once as a test without changing its schedule.',
            ],
            image: 'announcements-scheduled',
        },
        {
            title: 'Keep a message at the bottom of a channel',
            text: [
                'Open **Sticky messages** and select **Add sticky message**. Pick the **Channel** and write the **Message**: plain text, up to 2,000 characters, one per channel. The bot posts it after the next message in the channel, then deletes and reposts it each time a member writes there, so it stays last. Editing the text takes effect at the next repost, which replaces the old copy.',
                'The reposted message never pings anyone, even if it mentions a role. Deleting a sticky message stops the reposting; the last copy stays in the channel until someone removes it.',
            ],
            command: '/notes sticky set Read the pinned rules before posting.',
        },
        {
            title: 'Publish announcement channels automatically',
            text: [
                'On **Utilities**, turn on **Publish announcements automatically** and select **Save**. From then on, a message a member posts in an announcement channel is published, so servers that follow the channel get it too. You can do the same with `/alerts autopublish enable`, and check it with `/alerts autopublish status`.',
            ],
        },
    ],
    notes: [
        'Auto-publish only publishes messages from people. Posts from bots, including this bot\'s own announcements and scheduled messages, are left for you to publish. Discord also needs the bot to have **Manage Messages** in the channel to publish other people\'s posts.',
        'A server can have up to 50 scheduled messages. A scheduled message whose channel is deleted shows **Channel deleted**, and one whose last post failed shows the reason in the list.',
        '`/manage announce post` opens a form for the text, so line breaks are kept. `/manage announce edit message:` takes a link to a post the bot made. Both are in the / menu and need **Manage Server**.',
        '`/alerts scheduled create` makes the same scheduled messages from Discord, and `/alerts scheduled list` lists them. The `/alerts` commands need **Administrator** unless you change that in Discord\'s Integrations settings. See [the alerts commands](/commands#alerts).',
        '`/notes sticky set` and `/notes sticky remove` are typed as a message in the channel, not picked from the / menu, and need **Manage Messages**. Type the text after `set`; the message is posted straight away in the channel you typed it in.',
        '`/admin embed create` and `/admin embed quick` post an embed from Discord. Those embeds are not listed on the Custom embeds page.',
    ],
    related: ['reminders-utilities', 'custom-commands', 'social-feeds'],
};
