// Checked against: core/feature-config-spec.js (ai-assistant, imagine, tts, voice-reader, voice-transcription fields, defaults and notes),
// core/manage-nav.js (SPEC_OVERRIDES: ai-assistant and imagine under Custom commands & AI; tts, voice-reader, voice-transcription under
// Music & voice), core/ai-assistant.js (Gemini, tools and their permissions, 8 s per member, 800 characters, daily cap reply, forget,
// memory, persona), events/messageCreate.js (mention handlers first, then the assistant), commands/tools/ai.js (/manage ai),
// core/command-mounts.js (ai under manage), commands/fun/imagine.js (FLUX.1 Schnell, SDXL, config), commands/tools/tools.js and
// tools-tts-handler.js (/tools tts speak, play), commands/voice/voice-tools-handler.js (reader, transcribe, privacy, disconnect),
// core/voice-reader-manager.js (quiet while music plays), docs/command-split-2026-11-18.md (/manage is slash; /tools, /voice, /imagine are text).
export default {
    slug: 'ai-assistant',
    title: 'AI assistant, images, text to speech and captions',
    area: 'music',
    summary: 'Let members ask the bot questions by mentioning it, make images from a prompt, hear chat read aloud in voice, and get live captions of a voice channel.',
    result: {
        image: 'ai-assistant-discord',
        caption: 'A member mentions the bot with a question and the AI assistant replies.',
    },
    before: [
        'You need **Manage Server**. **AI assistant** and **AI image generation** are on the dashboard under **Custom commands & AI**; **Text to speech**, **Voice chat reader** and **Voice transcription** are under **Music & voice**.',
    ],
    steps: [
        {
            title: 'Turn on the AI assistant',
            text: [
                'On **AI assistant**, turn on **AI assistant**. Members then ask it things by mentioning the bot, for example "@CertiFried what time is it in Tokyo?". Real commands keep priority, so "@CertiFried play" followed by a song still goes to the music player.',
                'It can look up the time and the weather, facts about the server, and the web, and it can play or skip music, set the member\'s timezone and clear messages. **Allow it to take actions** lets it do those things, and only when the member asking could do them; turned off, it only answers.',
                '**Only in these channels** limits where it answers. **Replies per day** (500 unless you change it, from 1 to 5000) is for the whole server; after that it says it has reached its limit for the day. Each member can ask once every 8 seconds. Answers come from Google\'s Gemini model.',
            ],
            command: '/manage ai enable actions:true',
            image: 'ai-assistant-discord',
        },
        {
            title: 'Choose what it remembers, and give it a persona',
            text: [
                '**Conversation memory** is **Per member (private)**, **Shared per channel** or **Off**. **Exchanges remembered** is 1 to 20 (6 to start) and **Forget after (minutes)** 5 to 1440 (60 to start). A member can say "@CertiFried forget" to wipe their own conversation in that channel; `/manage ai forget` clears more.',
                '`/manage ai persona` gives the assistant a name, tone and focus in one channel. A persona cannot change what the assistant is allowed to do.',
            ],
            command: '/manage ai persona action:Set prompt:Fern, a cheerful gardener who answers in short sentences',
        },
        {
            title: 'Let members make images',
            text: [
                'Members type `/imagine generate` as a message with a prompt. The image is made with FLUX.1 Schnell, or with Stable Diffusion XL if they pick that model.',
                'On **AI image generation**, **Image generation** is on unless you turn it off. **Only in this channel** keeps it to one channel, and **Wait between requests (seconds)** is 15 per member unless you change it (5 to 300).',
            ],
            command: '/imagine generate prompt:a lantern-lit treehouse village at dusk, watercolour',
        },
        {
            title: 'Read chat aloud in voice',
            text: [
                '`/tools tts speak` (typed as a message) turns text into speech: it attaches an audio file, or plays it in your voice channel with `play:true`. On **Text to speech**, set the **Default voice** (Ryan, a Piper voice, if you leave it blank; Kokoro voices sound more natural and take a moment longer), **Maximum characters**, **Wait between messages (seconds)**, and the channels and roles that may use it.',
                'The **Voice chat reader** reads messages aloud as they are posted. Turn on **Voice chat reader**; with no **Channels to read**, each voice channel\'s own chat is read into that voice channel. **Follow the author** speaks in the room the author is in, and **Author must be in that voice channel** stops people outside a room from talking into it. It says links as "a link", stops long messages at the end of a sentence (600 characters unless you change it), and stays quiet while music is playing.',
                'Members pick the voice their messages are read in with `/voice reader my-voice` and how their name is said with `/voice reader my-name`. `/voice reader skip` stops the message being read.',
            ],
            command: '/voice reader enable text_channel:#general',
        },
        {
            title: 'Caption a voice channel',
            text: [
                'Staff start a session with `/voice transcribe start` in the voice channel and end it with `/voice transcribe stop`. Everyone in the channel is told. Members with **Manage Server** can always start one; **Role that may start sessions** lets another role do it.',
                'On **Voice transcription**, choose the **Live caption channel** and the **Caption style**: as the speaker (their name and avatar, which needs Manage Webhooks) or compact lines from the bot. **Post the transcript when a session ends** posts the whole text. **Speech model** is **Fast** (captions in about a second) or **Accurate** (better with names, a few seconds behind). Transcripts are kept for 30 days unless you change **Keep transcripts for (days)**.',
                'Speech is turned into text on CertiFried\'s own server. The audio is never recorded or stored, only the text.',
            ],
            command: '/voice transcribe start',
        },
    ],
    notes: [
        'Any member can keep themselves out of transcription and the chat reader in every server with `/voice privacy opt-out`, and come back with `/voice privacy opt-in`.',
        '`/voice disconnect` makes the bot leave voice, which stops the reader and any transcription.',
        'Members who opted out of message logging are never kept in the assistant\'s memory. Turning memory off with `/manage ai memory` also deletes the stored conversations, and `/manage ai disable` deletes them too.',
        'A server that never saved the Text to speech page has it on, with no length limit and no wait.',
    ],
    related: ['music', 'voice-channels', 'custom-commands'],
};
