// Checked against: core/nsfw-protection.js, core/nsfw-logic.js, core/avatar-protection.js (checkMember),
// core/phishing-detection-manager.js (image stage order), core/message-threat-logic.js, events/messageCreate.js,
// dashboard/views/partials/manage/nsfw-protection.ejs, dashboard/routes/api/features/nsfw-protection.js,
// commands/admin/avatarfilter.js, commands/admin/avatarfilter-nsfw-handler.js, commands/tools/link-filter.js
// (threats nsfw-images), core/manage-nav.js, docs/command-split-2026-11-18.md.
export default {
    slug: 'nsfw-protection',
    title: 'NSFW avatars and images',
    area: 'moderation',
    summary: 'Check avatars and pictures posted in chat for explicit content, act only when two models agree, and review anything borderline.',
    result: {
        image: 'nsfw-protection-page',
        caption: 'The NSFW protection page with both models loaded and avatar checks on.',
    },
    before: [
        'On the dashboard you need **Manage Server** or a bot-manager role. The page is under **Protection & anti-raid**, then **NSFW protection**. Banning, kicking or overturning from the review queue also needs Ban Members (Kick Members for a kick) yourself.',
    ],
    steps: [
        {
            title: 'Check avatars',
            text: [
                'Switch on **Check avatars** and press **Save avatar settings**. An avatar is checked when a member joins and whenever they change their avatar or server avatar. Two models run on the bot\'s own server: nothing is acted on unless both score the picture at the **Act threshold** (0.90) or higher, and from the **Review threshold** (0.60) it goes to the review queue for a person to decide.',
                '**When both models agree** starts on **Log only and review**, which only puts the member in the review queue. **Flag with role** gives them the "Flagged Avatar" role from **Avatar protection** and takes it off when they change to a clean avatar; **Kick** and **Ban** remove them, with a DM saying why while **Tell kicked or banned members why by DM** is on.',
            ],
            command: '/avatarfilter nsfw settings enabled:True action:log',
        },
        {
            title: 'Check images in chat',
            text: [
                'Switch on **Check images posted in chat** and press **Save chat-image settings**. Up to 4 images per message are scored, and only the scores are kept, never the image. Age-restricted channels and channels on the **Message threats** ignore list are skipped.',
                '**Action for chat images** starts on **Alert staff**: a card with a jump link is posted in the **Evidence channel** set on **Message threats** (or the phishing **Alert channel** if there is none). **Delete** removes the message, and **Delete and timeout** also times the member out, for 60 minutes unless you change **Timeout length**.',
            ],
            command: '/link-filter threats nsfw-images enabled:True action:alert',
        },
        {
            title: 'Test, then scan the members already here',
            text: [
                'Under **Test a member or an image**, find a member or upload a picture to see both models\' scores. Nothing is stored or acted on, so use it to choose thresholds.',
                '**Start scan** under **Scan everyone already here** checks every member\'s avatar in the background. It never acts: everything it finds goes to the review queue. It counts against the **Daily avatar scan limit** (1,000 unless you change it) and stops there; run it again the next day to carry on.',
            ],
            command: '/avatarfilter nsfw scan',
        },
        {
            title: 'Work through the review queue',
            text: [
                '**NSFW review queue** lists borderline finds and what the bot did on its own. For an entry that is waiting, choose **Ban**, **Kick**, **Not NSFW** (the picture is remembered as safe and not flagged again) or **Skip**.',
                'For an action the bot took, **Overturn** unbans, lifts the timeout or takes the flag role off, and remembers the picture as safe. A kick or a deleted message cannot be undone. Avatars are blurred on the page; click one to see it.',
            ],
            command: '/avatarfilter nsfw review',
        },
    ],
    notes: [
        'Both checks are off until you switch them on. Staff and members on the **Protection settings** allowlist are never acted on, and images from Administrators and the server owner are not checked.',
        'Up to 2,000 chat images a day are scanned (**Daily image scan limit**, 10 to 50,000). Once the limit is reached, images are not scanned until midnight UTC. **Scans per day** on the page shows the last 14 days.',
        'The act threshold goes from 0.80 to 0.99 and the review threshold from 0.30 to 0.99; the review threshold cannot be above the act threshold. **Alert cards for borderline images** also posts a card for images in the review band.',
        'If a model ever labels a chat image as possibly showing a minor, the image is deleted, nothing about it is stored, and staff are told to report it to Discord Trust & Safety.',
        'The commands are `/avatarfilter nsfw settings`, `status`, `test`, `scan`, `review` and `decide` for avatars, and `/link-filter threats nsfw-images` for chat images. Pick them from the `/` menu; they need Manage Server.',
    ],
    related: ['scam-links', 'quarantine-name-avatar', 'moderation'],
};
