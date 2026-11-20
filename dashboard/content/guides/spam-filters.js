// Checked against: core/selfbot-detection-manager.js, core/adaptive-spam-manager.js, core/commission-spam-filter.js,
// core/commission-spam-match.js, events/inviteLinkFilter.js, utils/link-whitelist.js, events/messageCreate.js,
// dashboard/views/partials/manage/advanced-protection.ejs, dashboard/views/partials/manage/commission-filter.ejs,
// dashboard/server.js (advanced-protection/selfbot, advanced-protection/adaptive-spam, checkGuildAdmin),
// commands/admin/protection.js, commands/admin/protection/selfbot.js, migrations/271_selfbot_mute_and_purge.js,
// commands/tools/commission-filter.js, commands/admin/moderation.js, core/command-mounts.js, commands/admin/report-dm.js,
// commands/context/report-dm-spam.js, dashboard/views/partials/manage/network-intel.ejs, core/manage-nav.js,
// docs/command-split-2026-11-18.md.
export default {
    slug: 'spam-filters',
    title: 'Spam filters',
    area: 'moderation',
    summary: 'Catch accounts run by scripts, members flooding several channels, commission adverts and Discord invite links.',
    result: {
        image: 'spam-filters-discord',
        caption: 'A self-bot alert with the signals it saw and buttons for the moderators.',
    },
    before: [
        'On the dashboard you need **Manage Server** or a bot-manager role. Self-bot detection, adaptive spam and the invite filter are under **Protection & anti-raid**, then **Raid lockdown** (the page itself is headed Advanced protection). The commission filter is under **Moderation & AutoMod**, then **Commission filter**.',
        'The `/protection` commands need Administrator and `/moderation commission-filter` needs Manage Server, unless your server changed its command permissions in Discord.',
    ],
    steps: [
        {
            title: 'Turn on self-bot detection',
            text: [
                'Open **Protection & anti-raid**, then **Raid lockdown**, and scroll to **Self-bot detection**. Switch on **Self-bot detection**, choose a **Self-bot alert channel** and press **Save** at the bottom of that section. It looks for members running automation on their own account: replies faster than the **Minimum response time** (50 ms), 20 messages within the **Burst window** (1000 ms), messages at exact intervals, and messages with identical formatting.',
                '**Self-bot action** starts on **Alert only (default)**: the alert lists what it saw, with **Kick**, **Ban**, **False Positive** and **View History** buttons for anyone with Timeout Members. Choose **Time out the member** (60 minutes), kick or ban to have the bot act on its own. **Strikes before action** (default 3) is how much suspicious behaviour it needs; lower catches more, and may catch real people.',
            ],
            command: '/protection selfbot enable',
            image: 'spam-filters-page',
        },
        {
            title: 'Turn on adaptive spam detection',
            text: [
                'In **Adaptive spam detection** on the same page, switch it on, choose a **Spam alert channel** and press **Save**. It learns each member\'s normal message rate and flags someone posting more than twice as fast (**Deviation multiplier**), or the same message in 3 channels within 5 minutes (**Cross-channel threshold** and **Cross-channel timeframe**). Accounts under 7 days or 24 hours old are judged more strictly.',
                '**Spam action** starts on **Alert only (default)**. **Time out for an hour** and **Kick the member** leave the message up; **Ban the member** also deletes their last day of messages; **Delete the message and warn the member** removes the message and sends the warning DM set on the Moderation page. Every detection is alerted and recorded as an infraction.',
            ],
            command: '/protection spam enable',
        },
        {
            title: 'Remove commission adverts',
            text: [
                'Open **Moderation & AutoMod**, then **Commission filter**, and set the switch at the top of the page to On; it saves straight away. Messages from regular members that contain a phrase such as "commissions open" or "dm for prices" are removed, ignoring case, punctuation, emoji and leetspeak. **DM the poster** (on by default) tells them why. Set a **Log channel** to see each removal in Discord.',
                '**Soft-sell detection** is an extra check for adverts that never ask, such as "just finished this logo for a client, thoughts?". Borderline posts stay up and wait under **Waiting for a decision**. A wrong removal can be put back from the **Removal log** with **Restore it**. The owner, Administrators and anyone with Moderate Members or Manage Server are never checked.',
            ],
            command: '/moderation commission-filter enable',
        },
        {
            title: 'Set the invite filter',
            text: [
                'The **Discord invite filter**, at the bottom of the **Raid lockdown** page, is on in every server until you switch it off. It deletes discord.gg, discord.com/invite, discordapp.com/invite, invite.gg and discord.me links and posts a warning in the channel for 10 seconds (**Delete and warn the user**). Members with Manage Server or Manage Messages can always post invites.',
                'To let others post them, switch on **Let the allowlist below post invites** and add users, roles or channels under **Invite filter allowlist**. **Log only (keep the message)** leaves invites up and records them in the **Log channel**.',
            ],
        },
    ],
    notes: [
        'Administrators, the server owner and members on the **Protection settings** allowlist are never acted on by these filters.',
        '**Exempt channels** in the adaptive spam section switch off every message filter in those channels: filtered words, AutoMod, adaptive spam, self-bot detection, phishing links, the link and commission filters, and live-promotion deletion. Use it for a self-promo or bot channel. Support ticket channels are never checked for adaptive spam.',
        'Self-bot detection does not delete the message it caught. `/protection selfbot config` sets the timeout length (`mute_duration:`, 1 to 10080 minutes) and `purge_messages:`, which deletes up to 100 of the member\'s messages. `/protection selfbot exempt` adds roles it ignores.',
        'Members can report scam or commission DMs with `/engage report-dm`, or by right-clicking the sender and choosing **Apps**, then **Report DM spam**. Moderators review the reports under **Protection & anti-raid**, then **Network intel**.',
        'The same message sent again and again in one channel is caught by AutoMod\'s Message spam rule: see [Moderation](/docs/guides/moderation).',
    ],
    related: ['moderation', 'scam-links', 'raid-protection', 'self-promo'],
};
