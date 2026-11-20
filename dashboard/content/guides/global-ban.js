// Checked against: dashboard/views/partials/manage/global-ban.ejs, dashboard/routes/features/global-ban.js,
// commands/admin/globalban.js, commands/admin/protection.js, commands/admin/protection/globalban.js,
// core/global-ban-manager.js, core/global-ban-confidence.js, core/moderation-manager.js (recordCrossGuildAction),
// events/guildBanAdd.js, events/guildMemberAdd.js, jobs/global-ban-aggregator.js, migrations/047_global_ban_system.js,
// migrations/329_insight_network.js, core/manage-nav.js.
export default {
    slug: 'global-ban',
    title: 'The global ban network',
    area: 'moderation',
    summary: 'Act on people who have been banned for scams, raids or spam in other servers that use this bot, the moment they join yours.',
    result: {
        image: 'global-ban-page',
        caption: 'Protect mode, acting at a confidence of 75 or more, with alerts in #mod-log.',
    },
    before: [
        'The dashboard page needs **Manage Server**, Administrator or a bot-manager role. It is under **Protection & anti-raid**, then **Global ban**. `/protection globalban` needs Administrator and `/globalban mode` needs Manage Server.',
    ],
    steps: [
        {
            title: 'Turn on global ban protection',
            text: [
                'Turn on the switch at the top of the page. It saves straight away, and from then on every member who joins is checked against the network\'s list.',
                'It is off in every server until someone turns it on. The defaults are Protect mode, a confidence of 75, and the actions in step 3.',
            ],
            command: '/protection globalban enable',
        },
        {
            title: 'Choose a mode',
            text: [
                '**Protect** (the default) carries out the action for the listing\'s severity when the listing\'s confidence is at or above **Confidence needed to act** (75 by default), and only alerts below it. **Alert only** never removes anyone and posts every hit to the alert channel. **Feed only** never acts or alerts.',
                'Confidence is 0 to 100. It grows with the number of independent servers that banned someone, who banned them (the bot\'s protections count most, then staff, then other bots) and why. One server alone can never push anyone past 50, two can reach 80, and three or more 100. Servers with the same owner count as one, and very new or very small servers and mass-ban bursts count for less.',
            ],
            command: '/globalban mode mode:protect threshold:75',
        },
        {
            title: 'Set the actions and the alert channel',
            text: [
                'Under **Action by severity**, **Critical** (phishing and verified scams) and **High** (raid organisers and repeat offenders) are Ban by default, **Medium** (spam accounts) is Kick and **Low** (a single, unverified incident) is Alert only. Each can also be Nothing.',
                'Pick an **Alert channel** so staff see each hit, its confidence and what was done. **Check on message** also checks members when they post, not only when they join. Select **Save**.',
            ],
            command: '/protection globalban config action_medium:kick alert_channel:#mod-log',
            image: 'global-ban-alert',
        },
        {
            title: 'Know how someone gets on the list',
            text: [
                'Every ban in a server that contributes is a signal: bans by the bot\'s protections, by staff by hand and by other bots, plus kicks and timeouts made with the bot\'s moderation commands. Every 15 minutes the network works out each person\'s confidence. They are listed automatically once bans come from at least two independent servers and the confidence reaches 40.',
                'A moderator can also report someone with evidence. The report is listed once 3 moderators from at least 2 servers approve it with `/globalban vote`, and dropped after 3 deny votes. Reports, votes and lookups need **Moderate Members**.',
            ],
            command: '/globalban report user:@name category:scam severity:critical evidence:Screenshot of the DM reason:Fake Nitro links in DMs',
        },
        {
            title: 'Look someone up, and handle appeals',
            text: [
                '**Check a user** on the page, or `/globalban check`, shows a person\'s confidence, how many independent servers reported them, the kinds of reason, and what your server would do. It never shows which servers reported them or which moderators.',
                'Before removing someone the bot DMs them the category and severity and how to appeal: with `/globalban appeal`, by replying to the DM, or on the [appeal page](/appeal). An appeal the CertiFried team approves takes them off the list for every server, and they are told the decision by DM.',
                'Your moderators can also accept an appeal for your server only, with `/globalban appeals`: the global ban stops acting on that person here, and every other protection (raids, scam links, name filters and the rest) still applies to them. The people you accepted are listed on **Protection settings** under **Accepted global ban appeals**, where you can remove someone again.',
            ],
            command: '/globalban check user:@name',
        },
    ],
    notes: [
        'Your server\'s bans feed the network even while protection is off. To stop that, turn off **Contribute this server\'s bans**, or use `/protection globalban config auto_aggregate:False`.',
        'What is shared is the banned person\'s user ID, the kind of action, the reason and who made it (a protection, staff or a bot). Other servers see the summary in step 5, and the **Global ban list** on the page shows each listed user\'s severity, category, reason and evidence.',
        'Bans the global ban network makes itself are not counted again, so it cannot feed itself.',
        'Members on the **Protection settings** allowlist, and everyone while protections are paused, are alerted on but never removed.',
        'The bot can only remove someone whose highest role is below its own and needs **Ban Members** or **Kick Members**. When it cannot, the alert says **Manual action needed** and what to fix.',
        '**Check on message** only removes people; it never posts an alert per message, and tries at most once per member every 10 minutes.',
        '`/protection globalban status` and `/globalban stats` show your settings and the network\'s size.',
    ],
    related: ['raid-protection', 'anti-nuke-join-gate', 'moderation', 'quarantine-name-avatar'],
};
