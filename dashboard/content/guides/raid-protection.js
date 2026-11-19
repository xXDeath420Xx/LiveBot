// Checked against: commands/admin/lockdown.js, core/raid-lockdown.js, core/raid-lockdown-logic.js (defaults),
// core/raid-detection-manager.js, dashboard/views/partials/manage/advanced-protection.ejs and raid-lockdown-panel.ejs.
export default {
    slug: 'raid-protection',
    title: 'Raid protection and lockdown',
    area: 'moderation',
    summary: 'Stop a flood of new accounts: block every new join for a while, automatically or by hand.',
    result: {
        image: 'raid-discord',
        caption: 'The alert staff see when the auto-trigger starts a lockdown.',
    },
    before: [
        '`/lockdown` needs **Manage Server**, Administrator or a bot-manager role. The settings are on the dashboard under **Protection & anti-raid**, then **Raid lockdown**.',
    ],
    steps: [
        {
            title: 'Set the lockdown defaults',
            text: [
                'During a lockdown every new join gets the same action: kick (the default), ban, timeout, quarantine or log only. A lockdown lasts 60 minutes unless you say otherwise, pauses Discord invites, and DMs kicked joiners when to come back.',
                'On the dashboard, these are under **Lockdown settings**. Set **Alerts and summaries go to** so staff see when a lockdown starts and ends.',
            ],
            command: '/lockdown settings action:kick duration:1h',
        },
        {
            title: 'Turn on the auto-trigger',
            text: [
                'The auto-trigger starts a lockdown on a join spike. The default is 20 joins within 10 seconds, for a 60-minute lockdown.',
            ],
            command: '/lockdown autotrigger enabled:True joins:20 seconds:10 minutes:60',
        },
        {
            title: 'Start or stop a lockdown by hand',
            text: [
                '`/lockdown start` asks you to confirm, then blocks every new join until it ends. On the dashboard you type LOCKDOWN to confirm. `/lockdown stop` ends it early and `/lockdown extend by:30m` makes it longer.',
                '`/lockdown status` shows what is running and `/lockdown history` the last 10 lockdowns with how many joins each blocked.',
            ],
            command: '/lockdown start duration:2h reason:Raid in progress',
            image: 'raid-page',
        },
        {
            title: 'Catch same-name floods',
            text: [
                'Raids often use accounts with the same name. With same-name protection on, 5 joins sharing a name within 300 seconds are banned (change the count, window and action as you like).',
            ],
            command: '/lockdown samename enabled:True',
        },
        {
            title: 'Pause invites and DMs',
            text: [
                '`/lockdown invites enabled:True` keeps Discord\'s invite pause on, so nobody can join by invite. `/lockdown dms enabled:True` keeps DMs from non-friends paused. Discord limits each pause to 24 hours; the bot renews it until you turn it off.',
                'These two switches, also on the dashboard under **Discord invite and DM pause**, are the only pause controls. Turning one off lifts a running pause straight away, even one set in Discord by hand, except invites that a running lockdown is holding.',
            ],
        },
    ],
    notes: [
        'Existing members, allowlisted users, bot managers and bots are never affected by a lockdown.',
        'A lockdown ends on its own at its end time; the end summary lists how many joins were blocked and who.',
        'Kicked joiners get a short DM saying the server is in lockdown and when to try again (at most 25 DMs per lockdown).',
        '**Raid protection** on the same page is a separate detector for waves of new accounts. It times out, kicks or bans the raiders it finds, or only alerts (the default); it never starts a lockdown, so use the auto-trigger for that. Purge messages is off unless you switch it on.',
        'An account-age gate is on the **Join gate and anti-nuke** page.',
    ],
    related: ['moderation', 'welcome', 'getting-started'],
};
