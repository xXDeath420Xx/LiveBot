// Checked against: dashboard/views/partials/manage/security.ejs, dashboard/server.js (POST /manage/:guildId/security/
// antinuke, agegate, spammer, rejoin, network-intel), commands/admin/protection.js, commands/admin/protection/antinuke.js,
// commands/admin/protection/joingate.js, core/anti-nuke-manager.js, core/anti-nuke-action.js, events/channelDelete.js,
// events/guildRoleDelete.js, events/guildBanAdd.js, core/join-gate.js, core/spammer-guard.js, core/protection-exempt.js,
// core/manage-nav.js.
export default {
    slug: 'anti-nuke-join-gate',
    title: 'Anti-nuke and the join gate',
    area: 'moderation',
    summary: 'Stop a rogue admin or bot deleting your channels and roles, and keep brand-new and spam-flagged accounts out at the door.',
    result: {
        image: 'anti-nuke-join-gate-alert',
        caption: 'The alert anti-nuke posts when one person deletes three channels within five minutes.',
    },
    before: [
        'The dashboard page needs **Manage Server**, Administrator or a bot-manager role. It is under **Protection & anti-raid**, then **Join gate and anti-nuke**. The `/protection` commands need Administrator.',
        'Everything on this page is off until you turn it on. Raid detection and lockdowns are covered in [Raid protection and lockdown](/docs/guides/raid-protection).',
    ],
    steps: [
        {
            title: 'Turn on anti-nuke',
            text: [
                'Anti-nuke watches for one person deleting channels, deleting roles or banning members in a hurry. By default it acts when someone deletes 3 channels, deletes 3 roles or bans 3 people within 5 minutes, and the action is a kick.',
                'Switch on **Anti-nuke**, pick an **Anti-nuke alert channel** and select **Save**. Without an alert channel nothing is posted anywhere when it fires, so set one.',
            ],
            command: '/protection antinuke enable',
        },
        {
            title: 'Set the limits, the action and who is trusted',
            text: [
                'Each limit can be 1 to 20. The action can kick or ban the person, remove all the roles the bot is able to remove, or only alert.',
                'The server owner is never acted on, and nor is anyone on the anti-nuke trusted list. Add the admins and bots you trust to delete things in bulk with `/protection antinuke whitelist action:add user:@name`. This list is separate from the shared allowlist on **Protection settings**, which anti-nuke ignores. The pause on that page does hold anti-nuke.',
                'The bot can only act on someone whose highest role is below its own. If they are above it, the alert still posts but nothing else happens, so keep the bot\'s role near the top.',
            ],
            command: '/protection antinuke config max_channel_deletes:3 max_role_deletes:3 max_bans:3 action:strip',
        },
        {
            title: 'Keep brand-new accounts out',
            text: [
                'The **Account age gate** checks every new member\'s account age. Accounts younger than **Remove accounts younger than** (24 hours by default, 1 to 720) are removed with a DM saying when to come back. Accounts younger than **Application required under** (7 days by default; 0 turns applications off) are removed with an Apply button in the DM.',
                'Applications go to **Applications appear in**, where staff approve or decline them on buttons. Approving DMs the applicant a single-use invite to the **Approval invite points at** channel, and an approved applicant gets in whatever their account age. **What to do** is Kick (the default), Ban or Nothing; Nothing only logs who it would have caught, which is a safe way to try it for a day.',
            ],
            command: '/protection joingate config kick-under-hours:24 apply-under-days:7 review-channel:#mod-log',
            image: 'anti-nuke-join-gate-page',
        },
        {
            title: 'Act on accounts Discord has flagged as spammers',
            text: [
                'Turn on **Act on flagged spammers when they join** and choose the **Action for flagged spammers**: Kick (the default), Ban, Flag (give them the **Role for flagged members**; a "Flagged Spammer" role is made if you leave it empty) or Nothing. **Silent** stops the log post for each one; the action still happens.',
                'Under **Scan current members**, **Scan** finds flagged accounts already in the server. Nothing happens until you confirm, and staff and allowlisted members are left alone. Someone flagged by mistake can appeal to Discord at dis.gd/request.',
            ],
            command: '/protection joingate spammer enabled:True action:kick',
        },
        {
            title: 'Limit members who keep leaving and rejoining',
            text: [
                'The rejoin limit acts on anyone who joins more than a set number of times: 3 by default, counted over every join ever or the last number of days you choose. It can ban (the default), kick every time, remove them with an application, or only log. Its settings and each member\'s join history are on **Verification & joining**, then **Rejoin limit**.',
                'The first time you switch it on, the bot counts past joins from Discord\'s own join messages so returning members are not treated as new.',
            ],
            command: '/protection joingate rejoin enabled:True max-joins:3 action:ban',
        },
    ],
    notes: [
        'Anti-nuke counts channel deletions, role deletions and bans. Kicks are not counted.',
        'The allowlist and the pause on **Protection settings** apply to the age gate, the rejoin limit and the spammer check. Bots that join are never checked by them.',
        'On a join the checks run in this order: flagged spammers, network intel, name and avatar filters, the rejoin limit, then the account age. The first one that removes someone ends it.',
        'The **Verification** switch on this page is the same setting as on the [Verification](/docs/guides/verification) page, where the CAPTCHA and the setup wizard are.',
        '**Network intel** on the same page acts on accounts that several servers using this bot have reported for scam DMs. Members report a DM with `/engage report-dm`.',
        '`/protection joingate status` shows the age gate\'s settings, the last 30 days and the other join checks. `/protection joingate applications` lists pending, approved or declined applications. `/protection antinuke status` shows the anti-nuke settings.',
    ],
    related: ['raid-protection', 'verification', 'global-ban', 'quarantine-name-avatar'],
};
