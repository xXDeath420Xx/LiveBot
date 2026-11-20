// Checked against: dashboard/views/partials/manage/verification.ejs, dashboard/views/partials/manage/security.ejs,
// dashboard/server.js (POST /manage/:guildId/security/joingate), commands/admin/systems.js (verification and
// auto-prune groups), commands/admin/systems-verify-handler.js, core/verification.js, core/verification-logic.js
// (DEFAULTS, LIMITS), core/auto-prune-logic.js, core/manage-nav.js.
export default {
    slug: 'verification',
    title: 'Verification: I agree or CAPTCHA',
    area: 'moderation',
    summary: 'New members press a button, or solve a six-digit picture code, before they can see the rest of the server.',
    result: {
        image: 'verification-panel',
        caption: 'The verification panel in CAPTCHA mode. In I agree mode the button says I agree instead.',
    },
    before: [
        'The dashboard page needs **Manage Server**, Administrator or a bot-manager role. It is under **Verification & joining**, then **Verification**. The `/systems verification` commands need Administrator.',
        'The bot needs **Manage Roles**, and **Manage Channels** to create the channel and hide the others. Its own role must sit above the Verified and Unverified roles.',
    ],
    steps: [
        {
            title: 'Run the setup wizard',
            text: [
                'In **Setup wizard**, pick an existing **Verification channel**, **Verified role** and **Unverified role**, or leave them on **Create a new channel** and **Create a new role** and the wizard makes them (named verify, Verified and Unverified unless you change the names). Choose **How members verify**.',
                'Under **Hide public channels until people verify**, the recommended choice hides them from the Unverified role, which new members get on joining and lose when they verify. Members already here are not affected. **Only the Verified role can see them** takes access away from @everyone and gives the Verified role to everyone already here first. **Do not hide anything** only sets up the roles, channel and panel.',
                'Select **Preview** to see every change, then **Apply**, which also turns verification on. The command does the same and asks you to confirm.',
            ],
            command: '/systems verification setup mode:captcha lock:unverified',
        },
        {
            title: 'Choose I agree or CAPTCHA',
            text: [
                'With **I agree button**, members read the rules and press the button to get the Verified role. With **CAPTCHA**, they press **Verify me**, see a picture of a fresh six-digit code and type it on a keypad. A wrong answer brings a new picture.',
                'For CAPTCHA, **Wrong codes allowed** is 3 by default (1 to 10) and **Time limit** is 5 minutes from joining (0 means no limit, at most 20160 minutes, which is 14 days). **When someone fails** is Kick by default; it can also be Log only, Timeout (for the **Timeout length**, 60 minutes by default) or Ban. **Tell them why by DM** is on by default.',
            ],
            command: '/systems verification settings mode:captcha attempts:3 minutes:10 fail_action:kick',
        },
        {
            title: 'Change the panel and post it again',
            text: [
                '**Panel title** and **Panel text** are optional; the preview on the page shows what new members will see. Changes reach Discord when you select **Save**, then **Post the panel again**. The new panel replaces the old one if this bot posted it.',
            ],
            command: '/systems verification panel',
        },
        {
            title: 'Watch it work, or undo it',
            text: [
                '**Last 30 days** shows how many verified, failed or ran out of time. **Waiting to verify** lists members on the CAPTCHA clock; **Stop the clock** lets one person take their time. Giving someone the Verified role by hand also stops their clock.',
                '**Undo the setup wizard** puts back every permission change the wizard recorded. Roles it gave to members are not taken back. Tick **Also delete the channel and roles the wizard created** to remove those as well, then select **Undo the permission changes**.',
            ],
            command: '/systems verification undo delete_created:False',
        },
        {
            title: 'Clear out members who never get a role (optional)',
            text: [
                '**Auto-prune** kicks new members who still have no real role a set time after joining, from 10 minutes to 14 days. Only joins after you switch it on are tracked. **At the limit** is Kick or Log only, and **Bypass roles** lists roles that do not count as a real role.',
                '**Inactivity prune** on the same page deals with members who never post or join voice, or who have gone quiet. Both are off until you turn them on.',
            ],
            command: '/systems auto-prune set enabled:True minutes:240 action:kick',
        },
    ],
    notes: [
        'Staff and members on the **Protection settings** allowlist are never kicked, banned or timed out by verification.',
        'The wrong-code count and the time limit only apply in CAPTCHA mode. In I agree mode nobody can fail.',
        '**Remove members still unverified after** (0 means never, up to 365 days) only works when an **Unverified role** is set. The check runs once a day.',
        '`/systems verification status` shows the settings, the last 30 days and the verification rate.',
        'The **Verification** switch on the **Join gate and anti-nuke** page is the same setting as the switch at the top of the Verification page.',
    ],
    related: ['anti-nuke-join-gate', 'welcome', 'raid-protection'],
};
