// Checked against: dashboard/views/partials/manage/utilities.ejs (Temporary voice channels), dashboard/server.js
// (POST /manage/:guildId/update-tempchannels: switch off, voice channel and category checks, one row per server),
// core/temp-channel-config.js (turning off), events/voiceStateUpdate.js (required role, {username}/{user}/{number}, permission
// overwrites, user limit, delete when empty), commands/admin/admin.js (temp-channel setup and disable, Administrator),
// commands/voice/voice.js (rename, limit, lock, unlock, transfer, claim, kick, trust, untrust, info; owner checks),
// migrations/098_temp_vc_multi_creator.js (one row per creator channel), core/manage-nav.js (Utilities under Scheduling & automation),
// docs/command-split-2026-11-18.md (/voice is text, /admin is slash).
export default {
    slug: 'voice-channels',
    title: 'Join-to-create voice channels',
    area: 'music',
    summary: 'Members join one voice channel and get a room of their own, which they can rename, limit and lock. It is deleted once it is empty.',
    result: {
        image: 'voice-channels-page',
        caption: 'Temporary voice channels on the Utilities page: the Join to create channel, the category new rooms go in, and the name each room gets.',
    },
    before: [
        'You need **Manage Server** for the dashboard and **Administrator** for `/admin temp-channel`. The settings are on the dashboard under **Scheduling & automation**, then **Utilities**, in **Temporary voice channels**.',
        'In Discord, make a voice channel for people to join (for example "Join to create") and a category for the new rooms. The bot needs **Manage Channels** and **Move Members** to make rooms and move people into them.',
    ],
    steps: [
        {
            title: 'Turn it on',
            text: [
                'Turn on **Temporary voice channels**, choose the **Creator channel** (the voice channel members join) and the **Category** the rooms are made in, and choose **Save**.',
                '**Channel name** is the name each room gets. `{username}` is the member\'s name in this server and `{number}` the next free number (1, 2, 3...). Left as it is, rooms are called "Juniper Vale\'s Channel" and so on.',
            ],
            image: 'voice-channels-page',
        },
        {
            title: 'Add more creator channels, a role or a user limit',
            text: [
                'With the command you can have more than one creator channel, for example one for games and one for study rooms. **required-role** lets only members with that role use a creator channel; anyone else who joins it is disconnected. **default-user-limit** (1 to 99) caps how many people fit in each new room.',
                'Running the command again for the same creator channel updates it. The dashboard shows and edits one creator channel and leaves the others alone (it says how many more there are), so manage several with the command.',
            ],
            command: '/admin temp-channel setup creator-channel:Join to create category:Community naming-template:{user}\'s room default-user-limit:5',
        },
        {
            title: 'What members get',
            text: [
                'A member who joins the creator channel gets a new voice channel and is moved into it. They are its owner: they can edit the channel and move people in Discord as well as with the commands below. The room is deleted as soon as the last person leaves.',
            ],
        },
        {
            title: 'Let members run their own room',
            text: [
                'The `/voice` commands are typed as a message while you are in your room. The owner can use `/voice rename`, `/voice limit` (0 for no limit, up to 99), `/voice lock` and `/voice unlock`.',
                '`/voice lock` stops anyone new from joining; people already inside stay, and `/voice trust` lets someone in anyway (`/voice untrust` takes it back). `/voice kick` disconnects someone and `/voice transfer` hands the room to someone in it. These are for the owner too.',
                'If the owner has left the room, anyone in it can take it over with `/voice claim`. `/voice info` shows the owner, whether it is locked, the limit and who is trusted.',
            ],
            command: '/voice lock',
        },
    ],
    notes: [
        'Turning the switch off on the dashboard removes every creator channel, the same as `/admin temp-channel disable`. Rooms already made stay until they are empty. `/admin temp-channel disable creator-channel:` turns off just one.',
        'New rooms take the category\'s permissions, so a room in a hidden or staff-only category is just as hidden. Members who want a private room can lock it.',
        'In the command\'s **naming-template**, `{user}` works the same as `{username}`.',
        'The `/voice` room commands only work in rooms made from a creator channel.',
    ],
    related: ['music', 'ai-assistant', 'roles-tools'],
};
