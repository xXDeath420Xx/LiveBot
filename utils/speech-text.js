/*
 * Chat text → text a speech engine reads the way a person would.
 *
 * Piper phonemizes with espeak-ng, which reads what it is given literally: "𝓥𝓲𝓸𝓵𝓮𝓽" becomes a
 * string of code-point numbers, "ʙᴇᴀʀ" becomes "small capital letter …", 😂 becomes "face with
 * tears of joy", "brb" becomes "ber-beh", and a message typed across three lines comes out as one
 * breathless run-on. Everything here exists because a real chat message came out as gibberish;
 * scripts/eval-voice-reader.mjs measures it (TTS → Whisper → word error rate).
 */

// NFKC folds mathematical alphanumerics (𝓥 𝕍 𝐕 𝘝), fullwidth, circled and superscript letters to
// ASCII. These "font" alphabets are outside it, so they are mapped by hand.
const FANCY = {
    // small capitals
    'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j',
    'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ǫ': 'q', 'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't',
    'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z',
    // "bubble"/"square" letters NFKC leaves alone
    '🅰': 'a', '🅱': 'b', '🅾': 'o', '🅿': 'p',
    // lookalikes common in decorated names
    'ß': 'ss', 'ø': 'o', 'Ø': 'O', 'æ': 'ae', 'Æ': 'AE', 'đ': 'd', 'ł': 'l', 'Ł': 'L', 'ı': 'i',
    'ѕ': 's', 'і': 'i', 'ј': 'j', 'о': 'o', 'а': 'a', 'е': 'e', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
    'Ꭺ': 'A', 'Ᏼ': 'B', 'Ꮯ': 'C', 'Ꭰ': 'D', 'Ꭼ': 'E', 'Ꮋ': 'H', 'Ꭻ': 'J', 'Ꮶ': 'K', 'Ꮇ': 'M', 'Ꮲ': 'P',
    'Ꮪ': 'S', 'Ꭲ': 'T', 'Ꮃ': 'W', 'Ꮓ': 'Z',
};
const FANCY_RE = new RegExp(`[${Object.keys(FANCY).join('')}]`, 'gu');
// Regional indicators pair into flags; 🇦–🇿 alone read as letters in "spelled" names.
const REGIONAL_RE = /[\u{1F1E6}-\u{1F1FF}]/gu;

// Emoji and their glue: pictographs, skin tones, variation selectors, ZWJ, keycap combiner, tags.
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu;
// Zalgo stacks, invisible formatting, box drawing and other decoration.
const DECOR_RE = /[\p{Mn}\p{Me}\p{Cf}\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF\u2B00-\u2BFF\u3000-\u303F\u30FB]/gu;

/** Fold decorative Unicode to plain letters and drop what can't be spoken. */
export function foldUnicode(s) {
    return String(s ?? '')
        .normalize('NFKC')
        .replace(FANCY_RE, c => FANCY[c])
        .replace(REGIONAL_RE, c => String.fromCharCode(c.codePointAt(0) - 0x1F1E6 + 97))
        .replace(EMOJI_RE, ' ')
        .normalize('NFKD')                     // é → e + ◌́ …
        .replace(DECOR_RE, '')                 // … then drop the marks and any zalgo with them
        .replace(/[‘’‛`´]/g, "'")
        .replace(/[“”„‟]/g, '"')
        .replace(/[‐‑‒–—―]/g, '-');
}

// Said the way people say them out loud in voice chat. Longer spellings only where the short
// form comes out as noise (espeak reads "brb" as one syllable).
const CHAT_WORDS = {
    lol: 'lol', lmao: 'lmao', lmfao: 'lmfao', rofl: 'rofl', omg: 'oh my god', omfg: 'oh my fucking god',
    idk: "I don't know", idc: "I don't care", idgaf: "I don't give a fuck", brb: 'be right back', btw: 'by the way',
    tbh: 'to be honest', imo: 'in my opinion', imho: 'in my opinion', smh: 'shaking my head', ngl: 'not gonna lie',
    ikr: 'I know, right', irl: 'in real life', rn: 'right now', nvm: 'never mind', wtf: 'what the fuck',
    wth: 'what the hell', stfu: 'shut the fuck up', gtfo: 'get the fuck out', fr: 'for real', frfr: 'for real for real',
    istg: 'I swear to god', jk: 'just kidding', ttyl: 'talk to you later', tysm: 'thank you so much', ty: 'thank you',
    thx: 'thanks', np: 'no problem', pls: 'please', plz: 'please', ppl: 'people', bc: 'because',
    cuz: 'cause', bcuz: 'because', b4: 'before', gn: 'good night', gm: 'good morning', wyd: 'what you doing',
    hbu: 'how about you', wbu: 'what about you', hmu: 'hit me up', ofc: 'of course', af: 'as fuck', asf: 'as fuck',
    u: 'you', ur: 'your', r: 'are', k: 'okay', kk: 'okay', ok: 'okay',
    ez: 'easy', gg: 'G G', ggs: 'G Gs', gl: 'good luck', glhf: 'good luck, have fun', afk: 'A F K', dm: 'D M',
    dms: 'D Ms', vc: 'V C', pfp: 'profile pic', tmr: 'tomorrow', tmrw: 'tomorrow', tn: 'tonight', '2nite': 'tonight',
    msg: 'message', pic: 'pic', pics: 'pics', ily: 'I love you', bf: 'boyfriend', gf: 'girlfriend', bff: 'best friend',
    tho: 'though', thru: 'through', rly: 'really', srsly: 'seriously', prob: 'probably', probs: 'probably',
    obv: 'obviously', def: 'definitely', ig: 'I guess', iirc: 'if I remember right', afaik: 'as far as I know',
    ftw: 'for the win', pog: 'pog', xd: 'x d', ffs: "for fuck's sake", mfw: 'my face when', tfw: 'that feeling when',
    ya: 'yah', yea: 'yeah', ye: 'yeah', yh: 'yeah', nah: 'nah', dw: "don't worry", wdym: 'what do you mean',
    im: "I'm", ive: "I've", dont: "don't", cant: "can't", wont: "won't", didnt: "didn't",
    doesnt: "doesn't", isnt: "isn't", wasnt: "wasn't", thats: "that's", whats: "what's", hes: "he's",
    shes: "she's", theyre: "they're", youre: "you're", wouldnt: "wouldn't", couldnt: "couldn't",
    shouldnt: "shouldn't", aint: "ain't", lemme: 'lemme', gonna: 'gonna', wanna: 'wanna', gotta: 'gotta',
};
// Kept as letters: spoken letter by letter whatever their case.
const SPELL_OUT = new Set(['gg', 'afk', 'dm', 'dms', 'vc', 'xd', 'pc', 'ps5', 'ps4', 'fps', 'rpg', 'mmo', 'npc', 'ai', 'tv', 'id']);

const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi;

/** Words and shapes espeak mangles: chat shorthand, 2v2, 9pm, ALL CAPS. */
function speakWords(text) {
    let s = text;
    s = s.replace(TIME_RE, (_, h, m, ap) => `${h}${m && m !== '00' ? ` ${m}` : ''} ${ap.toUpperCase().split('').join(' ')}`);
    s = s.replace(/\b(\d+)\s*v\s*(\d+)\b/gi, '$1 v $2');
    s = s.replace(/\b(\d+)(k|m)\b/gi, (_, n, u) => `${n}${u.toLowerCase() === 'k' ? ' K' : ' M'}`);
    s = s.replace(/(\d)([a-z]{2,})\b/gi, '$1 $2');
    s = s.replace(/&/g, ' and ').replace(/\s@\s/g, ' at ').replace(/\+/g, ' plus ').replace(/%/g, ' percent');

    // SHOUTING: a message that is mostly capitals is read as words, not acronyms.
    const letters = s.replace(/[^A-Za-z]/g, '');
    const shouting = letters.length >= 4 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7;

    return s.replace(/[A-Za-z0-9']+/g, w => {
        const lower = w.toLowerCase().replace(/'/g, '');
        if (SPELL_OUT.has(lower)) return CHAT_WORDS[lower] || lower.toUpperCase().split('').join(' ');
        // Mixed case ("iDK") is someone's name or a deliberate stylisation; leave it be.
        if (!w.includes("'") && Object.hasOwn(CHAT_WORDS, lower)
            && (w === w.toLowerCase() || w === w.toUpperCase() || /^[A-Z][a-z]*$/.test(w))) {
            return CHAT_WORDS[lower];
        }
        if (shouting && /^[A-Z]{2,}$/.test(w)) return w.toLowerCase();
        if (/^[A-Z]{5,}$/.test(w)) return w.toLowerCase();   // one shouted word among normal text
        return w;
    });
}

/**
 * Break text into spoken sentences: line breaks and ellipses become pauses, "!!!"/"???" collapse,
 * and a line without end punctuation gets a full stop so Piper pauses after it.
 */
function punctuate(text) {
    return text
        .split(/\n+/)
        .map(line => line.trim())
        .filter(line => /[\p{L}\p{N}]/u.test(line))
        .map(line => line
            .replace(/\s*(?:\.{2,}|…)+\s*/g, '. ')
            .replace(/([!?])[!?1]+/g, '$1')
            .replace(/,{2,}/g, ',')
            .replace(/\s+([,.!?;:])/g, '$1')
            .replace(/([,.!?;:])(?=[A-Za-z])/g, '$1 ')
            .trim())
        .map(line => (/[.!?]$/.test(line) ? line : `${line.replace(/[,;:]$/, '')}.`))
        .join(' ');
}

/**
 * Cut to whole sentences within `limit`. Only when the first sentence alone is too long does it
 * cut inside a sentence — at a comma if there is one — and it says so, never stopping mid-word.
 */
export function trimToSentences(text, limit) {
    if (text.length <= limit) return text;
    // Split after end punctuation (and any closing quote/bracket), keeping every character.
    const sentences = text.split(/(?<=[.!?]["')\]]*)\s+/);
    let out = '';
    for (const sentence of sentences) {
        const next = out ? `${out} ${sentence}` : sentence;
        if (next.length > limit) break;
        out = next;
    }
    if (out.trim().length >= Math.min(60, limit / 3)) return `${out.trim()} And more.`;
    const window = text.slice(0, limit);
    const comma = window.lastIndexOf(', ');
    const cut = comma > limit * 0.5 ? window.slice(0, comma) : window.replace(/\s+\S*$/, '');
    return `${cut.replace(/[,;:\s]+$/, '')}, and so on.`;
}

/**
 * A display name as it should be said. Decorations go (xX…Xx, emoji, fancy fonts, clan tags in
 * brackets, trailing number soup), CamelCase and snake_case split into words.
 * Returns '' when nothing sayable is left, so the caller can fall back.
 */
export function speakableName(name) {
    let s = foldUnicode(name);
    s = s.replace(/\[[^\]]{1,8}\]|\{[^}]{1,8}\}|【[^】]{1,8}】/g, ' ');          // [TAG] clan tags
    s = s.replace(/[_.\-~|/\\]+/g, ' ');
    s = s.replace(/\b[xX]{1,3}(?=[A-Za-z0-9])|(?<=[A-Za-z0-9])[xX]{1,3}\b/g, m => (m.length > 1 ? ' ' : m));
    s = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    s = s.replace(/([A-Za-z]{3,})(\d{3,})\b/g, '$1');                              // death420 → death
    s = s.replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z]{2,})/g, '$1 $2');
    s = s.replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!/[\p{L}]/u.test(s)) return '';
    // ALL-CAPS names are names, not acronyms, unless they are short enough to be initials.
    return s.split(' ').map(w => (/^[A-Z]{4,}$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w)).join(' ');
}

/**
 * The whole message body. `resolve` turns Discord mentions into names (it gets the raw match).
 */
export function speakableBody(content, { skipLinks = true, maxLength = 600, resolve = {} } = {}) {
    let text = String(content || '');
    text = text.replace(/```[\s\S]*?```/g, '\ncode block.\n');
    text = text.replace(/\|\|[\s\S]*?\|\|/g, ' a spoiler ');
    text = text.replace(/<@!?(\d+)>/g, (_, id) => speakableName(resolve.user?.(id) || '') || 'someone');
    text = text.replace(/<@&(\d+)>/g, (_, id) => speakableName(resolve.role?.(id) || '') || 'a role');
    text = text.replace(/<#(\d+)>/g, (_, id) => speakableName(resolve.channel?.(id) || '') || 'a channel');
    text = text.replace(/<a?:\w+:\d+>/g, ' ');                   // custom emoji: silent, like any emoji
    text = text.replace(/<t:\d+(?::\w)?>/g, ' a time ');
    text = text.replace(/https?:\/\/(?:www\.)?([^/\s]+)\S*/gi, (_, host) =>
        (skipLinks ? ' a link ' : ` a ${host.split('.').slice(-2, -1)[0] || ''} link `));
    text = text.replace(/^#{1,3}\s+/gm, '').replace(/^\s*[-*]\s+/gm, '').replace(/^>\s?/gm, '');
    text = text.replace(/[*_~`|]+/g, ' ');
    text = foldUnicode(text);
    text = text.replace(/(\p{L})\1{3,}/gu, '$1$1');              // "noooooo" → "noo"
    text = text.replace(/\b(ha|he|lo)\1{2,}\b/gi, '$1$1');       // "hahahahaha" → "haha"
    text = text.replace(/[^\S\n]+/g, ' ');
    text = speakWords(text);
    text = punctuate(text);
    text = text.replace(/\s+/g, ' ').trim();
    return trimToSentences(text, Math.max(40, Number(maxLength) || 600));
}

export default { foldUnicode, speakableName, speakableBody, trimToSentences };
