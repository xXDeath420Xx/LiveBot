// Checked against: core/phishing-detection-manager.js, jobs/phishing-list-updater.js, core/image-blocklist.js,
// core/scam-text-classifier.js, core/safe-domains.js, utils/report-patterns.js, events/messageCreate.js,
// dashboard/views/partials/manage/phishing.ejs, dashboard/routes/api/features/phishing.js,
// migrations/120_phishing_scan_images.js, commands/admin/admin.js (blocklist group), core/link-filter.js,
// core/link-policy.js, commands/tools/link-filter.js, dashboard/views/partials/manage/link-filter.ejs,
// core/message-threat-logic.js, dashboard/views/partials/manage/message-threats.ejs, core/domain-reports.js,
// core/domain-report-logic.js, dashboard/views/partials/manage/domain-reports.ejs, commands/tools/tools.js (checkurl),
// dashboard/server.js (checkGuildAdmin), core/manage-nav.js, docs/command-split-2026-11-18.md.
export default {
    slug: 'scam-links',
    title: 'Scam links and scam images',
    area: 'moderation',
    summary: 'Delete known phishing links and scam pictures the moment they are posted, and decide which other sites members may link to.',
    result: {
        image: 'scam-links-discord',
        caption: 'The alert moderators get when phishing detection removes a link.',
    },
    before: [
        'On the dashboard you need **Manage Server** or a bot-manager role. Everything in this guide is under **Protection & anti-raid**: **Phishing links**, **Link filter**, **Message threats** and **Domain reports**.',
    ],
    steps: [
        {
            title: 'Turn on phishing detection',
            text: [
                'Open **Protection & anti-raid**, then **Phishing links**, and set the switch at the top of the page, next to **Phishing detection**, to On. It saves straight away. From then on every message from a member is checked against a list of known phishing and scam domains, built from two community lists and refreshed every 4 hours.',
                '**Action on detection** is **Delete the message** unless you change it. The other choices are warn (a notice in the channel), mute (a timeout of 30 minutes unless you set **Mute length**, up to 7 days), kick and ban; the message is deleted with every one of them. Pick an **Alert channel** so moderators hear about each detection, then press **Save**.',
            ],
            image: 'scam-links-page',
        },
        {
            title: 'Know what happens to scam images',
            text: [
                'With phishing detection on, the text in posted images is read as well, unless you turn off **Read text in posted images** on the Phishing page. An image that shows a domain on the phishing list, or at least three typical scam signs (a crypto casino, a giveaway, a promo code to enter, a "claim it now" instruction), gets the same action as a link. When the scam wording gave it away, the picture is also added to your server\'s list of blocked scam pictures, so copies of it are deleted as soon as they are posted.',
                'Anyone who posts a blocked scam picture in 3 different channels within 2 hours is banned, and their last day of messages is deleted. To block the pictures in a scam post yourself, use `/admin blocklist add` with a link to the message; `/admin blocklist list` and `/admin blocklist remove` manage the list.',
            ],
        },
        {
            title: 'Choose which other sites are allowed',
            text: [
                '**Link filter** is off until you switch it on. It lets social and streaming sites, GIFs, Discord attachments and music through, removes link shorteners and commission marketplaces, and asks you about every other site. With **Unrecognised domains** on **Ask me (message stays up)**, the default, the link waits under **Waiting for a decision**: **Allow domain** allows that site in your server from then on, and **Block and remove** deletes the message and blocks the site.',
                '**Tip and membership links** (Ko-fi, Patreon, Throne and similar) are asked about too unless you choose Allow or Remove. Staff are never checked: the owner, Administrators and anyone with Moderate Members, Manage Server or Manage Messages. Discord invites are left to the invite filter in [Spam filters](/docs/guides/spam-filters).',
            ],
            command: '/link-filter enable unknown:review',
        },
        {
            title: 'Catch disguised links and QR codes',
            text: [
                '**Message threats** has extra checks, each off until you switch it on. **Obfuscated-URL "fake support" scam** catches a Discord link disguised so filters cannot read it, sent with support, ticket or appeal wording; its default action bans the member and deletes their last hour of messages. **QR codes in images** decodes QR codes in posted pictures and checks their links against the phishing list. **Image-text rules** act on your own words or patterns found in pictures.',
                '**Ignored channels and categories** on the same page switches off every check on the page in the channels you pick, and the phishing, link, invite and scam-image checks too. **Check a link** shows whether the bot would block a link, and why.',
            ],
        },
        {
            title: 'Report a missed site or a wrong block',
            text: [
                'On **Domain reports**, paste the link and press **Check**. Then pick **Report: this is phishing** or **Dispute: this block is wrong**, write a **Reason** of at least 10 characters and press **Send to the reviewers**. The bot\'s owners review it: an approved report blocks the site in every server the bot protects, and an approved dispute lifts the block everywhere. The sender is told the outcome by DM, and the page keeps each report with its history.',
                'Members can do the same with `/tools checkurl`, typed as a message: the result has a **Report as phishing** or **Dispute this block** button.',
            ],
            command: '/tools checkurl url:example.com',
        },
    ],
    notes: [
        'Administrators and the server owner are never checked, so test with an account that is neither. Members on the **Protection settings** allowlist are skipped, and the pause on that page stops every action.',
        'A moderator (Moderate Members) who pastes a phishing link, or a message that looks like a report, such as a user ID with a screenshot, is not punished: the message is removed and forwarded to the **Report and evidence channel**, if you set one. Phishing detection also skips your **Exempt channels** and any channel whose name contains evidence, red-flag, report, mod-log, ban-appeal or ban-evidence.',
        'Big sites such as Discord, YouTube, Twitch and Steam are never flagged. To stop another domain being flagged in your server, add it under **Never flag these domains**.',
        'Phishing links has no command; set it on the dashboard. With **Keep a detection log** on (the default) each detection is recorded, and **Recent detections** on **Message threats** lists the last 50.',
        '`/tools checkurl` allows 20 checks a minute per person. Domain reports are limited to 5 per person an hour and 50 per server a day.',
    ],
    related: ['spam-filters', 'moderation', 'nsfw-protection', 'raid-protection'],
};
