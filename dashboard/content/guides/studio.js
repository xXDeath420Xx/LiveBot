// Checked against: dashboard/views/studio-overview.ejs, studio-how-it-works.ejs (pairing, offline behaviour, updates, SmartScreen),
// studio-download.ejs, dashboard/routes/downloads.js (/downloads/studio, installer and portable builds), dashboard/routes/legal-pages.js
// (/studio, /studio/how-it-works, /studio/privacy, /studio/faq), dashboard/content/legal/data-inventory.js (STUDIO_FACTS: Windows 10 or 11
// 64-bit, OBS 28 / 30 / 30.2, updates every 6 hours), dashboard/views/stream-bot/devices.ejs (Your devices, Pair CertiFried Studio),
// dashboard/services/stream-bot-view.js (deviceView, studioView), dashboard/content/guides/stream-bot.js (Studio steps, not repeated here).
export default {
    slug: 'studio',
    title: 'CertiFried Studio for your streaming PC',
    area: 'streams',
    summary: 'A free Windows app that carries out the parts of your stream bot automations that have to happen on your PC: OBS, sounds, hotkeys, lights and more.',
    result: {
        image: 'studio-devices',
        caption: 'The Devices page with CertiFried Studio online and connected to OBS, and the section for pairing another copy.',
    },
    before: [
        'You need a CertiFried account with the [Stream bot](/docs/guides/stream-bot) set up: log in with Discord, open **Stream bot** from the account menu and link your Twitch or Kick channel.',
        'Studio runs on Windows 10 or 11 (64-bit). OBS control needs OBS 28 or newer.',
    ],
    steps: [
        {
            title: 'Download and install it',
            text: [
                'Get it from [Download CertiFried Studio](/downloads/studio). The installer keeps itself up to date: it checks shortly after it starts and then every 6 hours, and installs a new version when you quit Studio or choose **Restart to update**. The portable app runs from any folder and tells you when a newer version is on the download page.',
                'Studio is not code-signed, so the first time you open it Windows SmartScreen shows **Windows protected your PC**. Click **More info**, then **Run anyway**. The download page lists the SHA-256 of each file if you want to check it first.',
            ],
        },
        {
            title: 'Link it to your account',
            text: [
                'In Studio, choose **Sign in with CertiFried**. Your browser opens on certifriedmultitool.com; check that it shows the same four-character code as Studio and choose **Approve**.',
                'Or, on the stream bot\'s **Devices** page, choose **Make a pairing code** and type the code into Studio, or choose **Open in CertiFried Studio** on the same PC. A code works once and for 10 minutes.',
                'Studio then shows on **Devices** with whether it is online and, once it reports in, its OBS connection and the scene on air. **Revoke** there disconnects it at once.',
            ],
            image: 'studio-devices',
        },
        {
            title: 'Connect OBS and use it in automations',
            text: [
                'In Studio, open **Settings** and choose **Use my OBS settings** under **OBS**. Studio reads the WebSocket port and password from OBS on the same PC and connects.',
                'Your automations stay on the dashboard. When one has an OBS, sound, hotkey, light, Voicemeeter or Stream Deck action, the CertiFried server sends it to Studio, Studio carries it out and reports back to **Run history**. The [Stream bot guide](/docs/guides/stream-bot) goes through each of them, and the overlays.',
            ],
        },
    ],
    notes: [
        'If Studio is closed or offline, its actions wait 2 minutes (or the time you set on the action) and then expire. Studio reconnects by itself. If two copies use the same pairing, the newer one takes over.',
        'Studio has no analytics, telemetry or crash reporting, and your microphone audio and OBS password never leave your PC. [Studio privacy](/studio/privacy) lists what it keeps and what it sends, and [How Studio works](/studio/how-it-works) what it changes in OBS.',
        'Studio is free and open source under the GNU AGPL-3.0-or-later. The [Studio questions](/studio/faq) cover SmartScreen and antivirus warnings.',
        'The CertiFried docks need OBS 30 or newer, and the CertiFried theme OBS 30.2 or newer.',
    ],
    related: ['stream-bot', 'go-live-alerts', 'supporter-alerts'],
};
