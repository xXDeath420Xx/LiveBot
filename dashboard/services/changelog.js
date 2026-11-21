/*
 * The public changelog (/changelog), built from migrations/*.js.
 *
 * Each migration's header comment is written for developers. The page shows, per migration:
 *   - USER_NOTES[id] when there is one: a title and a line written for the people who use the bot;
 *   - otherwise the file name as the title and the first paragraph of the header, with references
 *     only the team can follow taken out ("(register H-660)", "(owner decision 2026-11-18)",
 *     "(core/foo.js)", "(docs/bar.md ...)").
 * A migration from 417 on that is not recorded in the migrations table has not been run yet
 * (migrations/run.js records each one it runs; 417-436 were recorded by hand, register H-637), so the
 * page leaves it off rather than announce it early. Before 417 nothing was recorded, so all are shown.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const FIRST_RECORDED = 417;

export const USER_NOTES = Object.freeze({
    437: {
        title: 'Greenhouse Tycoon',
        desc: 'Greenhouse Tycoon, a plant-growing game, replaces CertiFried Tycoon. You play it on the website, in a Twitch panel or from Discord, with one save across your sign-ins. Nothing carries over from the old game.',
    },
    438: {
        title: "The old CertiFried Tycoon game's data is deleted",
        desc: "The closed game's tables were removed from the database. Greenhouse Tycoon saves are not affected.",
    },
    439: {
        title: 'How long custom-command storage is kept',
        desc: 'Values that custom commands save with {db:…} (per member) and {sdb:…} (per server) are deleted after 400 days without being read or written.',
    },
    440: {
        title: 'Voice XP survives a restart',
        desc: 'Time spent in a voice channel still earns XP when the bot restarts while you are in it.',
    },
    441: {
        title: 'The birthday role lasts 24 hours',
        desc: 'The birthday role is taken back 24 hours after it is given, instead of when the date changed in UTC.',
    },
    442: {
        title: 'One AI DJ switch',
        desc: 'The Music page and the AI DJ page now share one AI DJ switch. Randomness defaults to 5 out of 10 and the default voice is Amy.',
    },
    443: {
        title: 'AutoMod message spam does what its action says',
        desc: 'A Message spam rule now deletes, warns, mutes, kicks or bans as chosen. Existing rules moved to the new "Delete and time out, longer each time" action, which is how they already behaved.',
    },
    444: {
        title: 'Ticket numbers per server',
        desc: "Each server's tickets are numbered on their own, starting at 1, and a number is never reused. Existing tickets were numbered in the order they were opened.",
    },
    445: {
        title: 'Economy defaults match',
        desc: '/economy, the Economy page and the settings now share one set of defaults, and the economy is on until a server turns it off. The default currency icon is a money bag again.',
    },
    446: {
        title: 'Event schedule links are unique',
        desc: "No two servers can use the same event schedule link, so a public schedule page always shows the right event.",
    },
    447: {
        title: 'One way to pause DMs and invites during a raid',
        desc: '/lockdown dms and /lockdown invites now control the pause; /lockdown dm-pause and /lockdown discord are retired. The raid action that only timed raiders out is now called "Time out raiders".',
    },
    448: {
        title: 'Suggestions can wait for staff approval',
        desc: 'When a server requires approval, a new suggestion goes to staff with Approve and Reject buttons and is posted for voting only once approved.',
    },
    449: {
        title: 'Moderation records, tickets and raid lockdowns are no longer kept forever',
        desc: 'Moderation records are deleted after two years (warnings after one), closed tickets and their transcripts a year after closing, and ended raid lockdowns after 180 days.',
    },
    480: {
        title: 'YouTube: no points for YouTube viewers, and YouTube data kept 30 days',
        desc: 'YouTube viewers no longer earn or spend points: points, the loyalty store, raffles, points games and media share are for Twitch and Kick, because YouTube\'s API rules do not allow rewards for subscribing, joining or chatting. Data that came from YouTube is deleted after 30 days. Linking a YouTube channel is paused for most accounts while Google reviews CertiFried.',
    },
    450: {
        title: 'Sound drop volume is a percentage everywhere',
        desc: 'The VC sound drops page and /admin vcsounds volume both set the volume from 1 to 100%. Volumes saved the old way were converted, and the default is 50%.',
    },
});

/** Take out references only the team can follow. */
export function plainText(text) {
    return String(text ?? '')
        .replace(/\s*\((?=[^()]*(?:\bregister\b|\bH-\d+|\bowner (?:decision|request)\b|\bgap analysis\b|\baccuracy audit\b|[\w./-]+\.(?:js|mjs|cjs|md|sql)\b|\bdocs\/))[^()]*\)/gi, '')
        .replace(/\s+([.,;:])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** The first paragraph of a migration's leading comment, without its "Migration N —" / "Wave N —" prefix. */
export function headerParagraph(src) {
    const head = String(src).trimStart();
    const block = head.match(/^\/\*\*?([\s\S]*?)\*\//);
    let lines = null;
    if (block) lines = block[1].split('\n').map(l => l.replace(/^\s*\*\s?/, '').trim());
    else if (head.startsWith('//')) {
        lines = [];
        for (const l of head.split('\n')) { if (!/^\s*\/\//.test(l)) break; lines.push(l.replace(/^\s*\/\/\s?/, '').trim()); }
    }
    if (!lines) return '';
    const para = [];
    for (const l of lines) { if (!l) { if (para.length) break; continue; } para.push(l); }
    let text = para.join(' ').replace(/\s+/g, ' ').trim();
    const pre = text.match(/^(?:Migration|Wave)\s*#?\d+\s*(?:[—–:-])\s*/i);
    if (pre) text = text.slice(pre[0].length);
    return text;
}

function clip(text, max = 260) {
    return text.length > max ? text.slice(0, max).replace(/\s+\S*$/, '') + '…' : text;
}

/**
 * Entries for /changelog, newest first: { id, title, desc, date }.
 * @param {string} dir the migrations folder
 * @param {{recorded?: Set<string>|null}} [opts] names in the migrations table; null shows every file
 */
export async function buildChangelog(dir, { recorded = null } = {}) {
    const files = (await fs.readdir(dir))
        .filter(f => /^\d+_.*\.js$/.test(f))
        .sort((a, b) => Number(b.split('_')[0]) - Number(a.split('_')[0]));
    const entries = [];
    for (const name of files) {
        const match = name.match(/^(\d+)_(.+)\.js$/);
        if (!match) continue;
        const id = Number(match[1]);
        if (recorded && id >= FIRST_RECORDED && !recorded.has(name)) continue;
        const note = USER_NOTES[id];
        let desc = '';
        let date = null;
        try {
            if (!note) desc = clip(plainText(headerParagraph(await fs.readFile(path.join(dir, name), 'utf8'))));
            date = (await fs.stat(path.join(dir, name))).mtime.toISOString().slice(0, 10);
        } catch { /* non-fatal */ }
        entries.push({ id, title: note ? note.title : match[2].replace(/_/g, ' '), desc: note ? note.desc : desc, date });
    }
    return entries;
}
