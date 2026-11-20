// Checked against: core/self-promo-handler.js, events/messageCreate.js (live-promotion filter, announce gate,
// self-promo handler order), dashboard/views/partials/manage/self-promo.ejs, dashboard/routes/features/self-promo.js,
// dashboard/routes/api.js (ensureGuildPerms), commands/admin/systems.js (selfpromo group), core/manage-nav.js,
// docs/command-split-2026-11-18.md.
export default {
    slug: 'self-promo',
    title: 'Self-promo rules',
    area: 'streams',
    summary: 'Let members post their own stream link in one channel and get go-live alerts from then on, and keep live promotion out of the other channels.',
    result: {
        image: 'self-promo-page',
        caption: 'The Self-promo page: #self-promo is the request channel, and go-lives are announced there.',
    },
    before: [
        'On the dashboard you need **Manage Server** or a bot-manager role. The page is under **Stream alerts**, then **Self-promo**. The `/systems selfpromo` commands need Administrator, unless your server changed its command permissions in Discord.',
    ],
    steps: [
        {
            title: 'Pick the request channel',
            text: [
                'Open **Stream alerts**, then **Self-promo**. Choose the **Request channel**, where members post their stream link, and tick the **Allowed platforms**: Twitch, Kick and YouTube. Set the switch at the top of the page, next to **Self-promo**, to On and press **Save**.',
                'When a member posts a link to their own channel, the bot adds it to stream tracking (**Add to stream tracking**); Twitch and Kick channels are looked up first, so a link to a channel that does not exist is not tracked. From then on their go-lives are announced like any other tracked streamer.',
            ],
            command: '/systems selfpromo setup channel:#self-promo platforms:twitch,kick,youtube',
        },
        {
            title: 'Decide what happens to each post',
            text: [
                'By default the channel works as a sign-up box: each link is removed once the bot has read it, and messages without a stream link are removed too (**Delete messages without a link**). Switch on **Keep members\' posts** to let promo posts stay up; the bot then confirms with a tick reaction and a DM instead.',
                '**DM when tracked** and **DM if already tracked** tell the member what happened. If their DMs are closed, the bot replies in the channel and deletes the reply after a minute.',
            ],
        },
        {
            title: 'Choose where go-lives are announced',
            text: [
                'With **Announce in the request channel** on, go-live posts for these streamers appear in the request channel. Switch it off to choose a separate **Announcement channel**. Members of a stream team are announced in their team\'s channel instead.',
                '**Announcement gate** (off by default) limits who may post or open a thread in the announcement channel: a **Minimum level** (0 for none) and at least one of the **Required roles**, if you pick any. Posts from members who do not qualify are deleted and they get a DM saying why.',
            ],
        },
    ],
    notes: [
        'Self-promo is for a member\'s own channel. The bot only tracks a link when the member\'s Discord username, display name or nickname closely matches the channel name (5 letters in a row in common, or one containing the other). Otherwise the link is not tracked, the post is removed unless **Keep members\' posts** is on, and the member is told to ask a moderator to link it.',
        'A post that promotes someone else ("go watch X, they are live") is left up and not tracked.',
        'Unless you turn off **Delete live promotion outside self-promo channels** on the Self-promo page, "I\'m live", "going live" and "live at" posts that also have a stream link or a time are deleted from members without Moderate Members, unless the channel name contains a word such as self-promo, promo, stream, live, creator, content, share, plug or links. The deletion is posted in the moderation log channel. To allow such posts in another channel, add it to **Exempt channels** under adaptive spam on the **Raid lockdown** page.',
        '`/systems selfpromo setup` turns self-promo on with the channel and platforms you give, `status` shows the settings and `disable` turns it off. Pick them from the `/` menu; the dashboard has every option.',
        'To clear a promo channel on a schedule, use **Auto purge** under **Scheduling & automation**.',
    ],
    related: ['go-live-alerts', 'stream-bot', 'spam-filters', 'schedules'],
};
