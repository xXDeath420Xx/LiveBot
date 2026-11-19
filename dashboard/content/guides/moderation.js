// Checked against: commands/admin/admin.js + admin-mod-handler.js, core/moderation-manager.js,
// core/escalation-manager.js, core/automod.js, core/log-manager.js, core/log-actions.js,
// commands/admin/ban.js + core/ban-requests.js, commands/admin/logs-setup.js + core/logs-setup-plan.js,
// dashboard/views/partials/manage/moderation.ejs, automod.ejs, logging.ejs.
export default {
    slug: 'moderation',
    title: 'Moderation, AutoMod and logs',
    area: 'moderation',
    summary: 'Warn, time out, kick and ban with a record of every action, let AutoMod handle the obvious cases, and log what happens.',
    result: {
        image: 'moderation-discord',
        caption: 'A warning in the moderation log channel.',
    },
    before: [
        'The moderation commands are under `/admin`, which needs **Manage Server** unless your server changed its command permissions in Discord.',
    ],
    steps: [
        {
            title: 'Pick the log channel and mute role',
            text: [
                'On the dashboard, open **Moderation & AutoMod**, then **Moderation**. Set the **Moderation log channel**, where every warning, timeout, kick and ban is posted, and the **Mute role**.',
                'Under **Messages to members** you choose which actions send the member a DM and what it says.',
            ],
            image: 'moderation-page',
        },
        {
            title: 'Use the moderation commands',
            text: [
                '`/admin mod warn`, `mute` (a timeout of up to 28 days), `unmute`, `kick`, `ban` and `unban` all take a member and a reason. A ban can end on its own: `duration:7d`. `/admin mod history user:` shows the last 10 entries for a member.',
                '`/admin mod purge` deletes up to 100 recent messages, filtered to one member, bots, text, links or files.',
                '`/ban` lets moderators without Ban Members ask for a ban: it kicks the member and posts a request that an admin approves or declines. Members with Ban Members ban straight away. Pick the request channel and any extra approver or requester roles under **Ban requests** on the Moderation page. `/ban` is not in every server\'s `/` menu: every custom bot has it, and the main bot has it only in the servers it has been added to. Typed as a message it works in the same servers only, and where it is missing the Moderation page does not show **Ban requests**.',
            ],
            command: '/admin mod warn user:@Fennel reason:Spoilers outside #spoilers',
        },
        {
            title: 'Add escalation rules',
            text: [
                'An escalation rule acts on repeat offenders: for example, 3 **Infractions** **Within (hours)** 24 gives a timeout. **Action** is Timeout, Kick or Ban. When several rules match, the one with the highest count runs.',
                'Warnings, timeouts, kicks and bans count, by moderators and by AutoMod. Unmutes, unbans, the records the raid and spam detectors keep, and the action the escalation itself takes do not, and `/admin mod clearinfractions` starts the count again. The member gets the DM set under **Messages to members** for that action, or none if it is switched off.',
            ],
        },
        {
            title: 'Turn on AutoMod rules',
            text: [
                'On the **AutoMod** page, add a rule and pick its **Filter type**: Banned words, Mass mentions, All caps or Message spam. Then pick what happens: delete the message, or delete it and warn, mute, kick or ban the member.',
                'Each rule can ignore roles and channels, so staff and bot channels are left alone.',
            ],
            image: 'automod-page',
        },
        {
            title: 'Log what happens',
            text: [
                'Open **Logs & stats**, then **Logging**. Choose a **Default log channel** and tick the events to record, such as deleted and edited messages, joins and leaves, and bans. Each kind of event can go to its own channel instead.',
                '`/manage logs-setup apply` does this in one go: it creates private log channels under a **CF Logs** category (moderation, members, messages, voice, channels, roles, invites, webhooks, events and system) and routes every kind of event to one of them. `preview` shows what it would do first. Categories you already unticked on the Logging page stay off.',
            ],
            image: 'logging-page',
        },
    ],
    notes: [
        'Banned words match anywhere in a message, including inside longer words.',
        'Message spam catches the same or nearly the same message sent again and again (**Message limit** copies within the **Time window**), not fast typing. It deletes the copies and keeps deleting the sender\'s messages until they stop for a minute. Warn, mute, kick and ban happen as soon as the spam is caught. **Delete and time out, longer each time** waits until the spam stops, then gives 1 minute, then 5, 15, 30 and so on up to a day for repeat spam within 24 hours.',
        '**Protected roles** on the Moderation page can never be warned, muted, kicked or banned with the bot.',
        '`/modreason` saves short reasons, so `gh` can stand for a longer one. Type the short reason as the whole reason in `/ban` or in `/admin mod` warn, mute, kick, ban and the other `/admin mod` commands that take a reason. `/modreason` itself is in the same servers as `/ban`.',
    ],
    related: ['raid-protection', 'support-tickets', 'privacy'],
};
