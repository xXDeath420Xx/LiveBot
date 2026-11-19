/*
 * Build an emote pack for a guild.
 *
 *   node scripts/build-emote-pack.mjs <guildId> [--set=kirby,fortnite] [--upload] [--dir=…]
 *
 * Generates each candidate, cuts its backdrop away, sizes it for Discord and
 * writes it to disk with a contact sheet. Nothing reaches the guild without
 * --upload: emoji slots are scarce (fifty at boost tier zero) and taste is not
 * something a script should be spending them on unasked.
 *
 * Re-runnable. A name the guild already has is skipped, not duplicated.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import sharp from 'sharp';
import encryption from '../utils/encryption.js';
import { generateImage } from '../utils/image-generation.js';
import { stickerPrompt, makeEmote, emoteCapacity, uploadEmote, emoteName, prepareEmote } from '../core/emote-pack.js';

/* One entry per emoji. `subject` is the only part that changes between them —
   the rest of the prompt is fixed so the whole pack looks like a set rather
   than twelve unrelated drawings. */
const CATALOGUE = [
    // Kirby-ish. The guild already has an animated Kirby_Hello; these fill it out.
    { name: 'kirby_love', set: 'kirby', subject: 'a perfectly round smooth pink ball creature with a glossy surface, tiny stubby arms and small red oval feet, no fur and no texture, with big sparkling heart-shaped eyes, blushing, in love' },
    { name: 'kirby_sleepy', set: 'kirby', subject: 'a perfectly round smooth pink ball creature with a glossy surface, tiny stubby arms and small red oval feet, no fur and no texture, fast asleep with closed happy eyes and a little Z floating above' },
    { name: 'kirby_rage', set: 'kirby', subject: 'a perfectly round smooth pink ball creature with a glossy surface, tiny stubby arms and small red oval feet, no fur and no texture, furious, flushed red with tiny angry eyebrows and a cartoon anger vein' },
    { name: 'kirby_yay', set: 'kirby', subject: 'a perfectly round smooth pink ball creature with a glossy surface, tiny stubby arms and small red oval feet, no fur and no texture, cheering with both stubby arms thrown up in the air, delighted' },

    // Fortnite. Objects, not likenesses — the props are what people react with.
    { name: 'fn_llama', set: 'fortnite', subject: 'a colourful llama piñata loot crate, blue and purple patterned, with a happy face' },
    { name: 'fn_crown', set: 'fortnite', subject: 'a glowing golden victory crown floating above a small sparkle burst' },
    { name: 'fn_boogie', set: 'fortnite', subject: 'a shiny purple disco-ball grenade with a glowing green stripe, sparkling' },
    { name: 'fn_pickaxe', set: 'fortnite', subject: 'a chunky cartoon pickaxe with a blue metal head and a wrapped handle, crossed with a sparkle' },
    { name: 'fn_slurp', set: 'fortnite', subject: 'a chubby blue juice can with a glowing lid, dripping bright blue liquid, cartoon style' },

    // Kuromi-flavoured kawaii goth — black and pink, skulls, a bit mischievous.
    { name: 'kuro_hi', set: 'kuromi', subject: 'a small white bunny in a black jester hood with a pink skull on it, waving hello, mischievous grin' },
    { name: 'kuro_smug', set: 'kuromi', subject: 'a small white bunny in a black jester hood with a pink skull on it, smirking smugly with half-lidded eyes' },
    { name: 'kuro_pout', set: 'kuromi', subject: 'a small white bunny in a black jester hood with a pink skull on it, pouting with puffed cheeks and folded arms' },

    // General kawaii reaction emotes.
    { name: 'kawaii_heart', set: 'kawaii', subject: 'a glossy pastel pink heart with a soft shine and tiny sparkles around it' },
    { name: 'kawaii_sparkle', set: 'kawaii', subject: 'a cluster of glittering pastel star sparkles, lilac and pink, shining' },
    { name: 'kawaii_cry', set: 'kawaii', subject: 'a tiny round pastel blob creature sobbing with huge watery eyes and streaming cartoon tears' },
    { name: 'kawaii_boba', set: 'kawaii', subject: 'a cup of bubble tea with a cute smiling face, pastel lilac drink, dark tapioca pearls and a striped straw' },
    { name: 'kawaii_coffee', set: 'kawaii', subject: 'a steaming takeaway coffee cup with a sleepy cute face and a little heart in the steam' },
    { name: 'kawaii_yes', set: 'kawaii', subject: 'a tiny round pastel blob creature giving an enthusiastic double thumbs up, beaming' },
];

/* Ellie is the owner's dog, and the guild already holds one photo of her as an
   emoji. That photo is the reference: the generator is shown her rather than
   told about her, which is the only way a likeness survives. */
const ELLIE = [
    { name: 'ellie_happy', set: 'ellie', subject: 'this dog, beaming with a big open happy smile, tongue out' },
    { name: 'ellie_love', set: 'ellie', subject: 'this dog with big sparkling heart eyes, blushing, in love' },
    { name: 'ellie_sleepy', set: 'ellie', subject: 'this dog curled up fast asleep with a little Z floating above' },
];

const args = process.argv.slice(2);
const guildId = args.find((a) => /^\d{15,25}$/.test(a));
const sets = (args.find((a) => a.startsWith('--set='))?.slice(6) || '').split(',').filter(Boolean);
const doUpload = args.includes('--upload');
const outDir = args.find((a) => a.startsWith('--dir='))?.slice(6)
    || path.join('/tmp', `emote-pack-${guildId}`);
/* Upload what is already on disk instead of drawing it again. Generation is the
   slow, billed half; approving a batch afterwards should not repeat it — and a
   second run would produce different pictures than the ones that were approved. */
const fromDirs = args.filter((a) => a.startsWith('--from=')).map((a) => a.slice(7));

if (!guildId) {
    console.error('usage: node scripts/build-emote-pack.mjs <guildId> [--set=kirby,…] [--upload]');
    process.exit(1);
}

const db = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const [[mapping]] = await db.execute(
    'SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ? LIMIT 1', [guildId]);
const [[bot]] = await db.execute(
    'SELECT bot_token FROM custom_bots WHERE bot_id = ?', [mapping?.bot_id || '']);
await db.end();
if (!bot) { console.error(`no custom bot is mapped to guild ${guildId}`); process.exit(1); }
const token = encryption.decrypt(JSON.parse(bot.bot_token));

const cap = await emoteCapacity(token, guildId);
console.log(`guild has ${cap.used}/${cap.perTier} static emoji — ${cap.free} slots free\n`);

/** The existing :Ellie: photo, when there is one, is the reference for her set. */
async function ellieReference() {
    const emojis = await fetch(`https://discord.com/api/v10/guilds/${guildId}/emojis`,
        { headers: { Authorization: `Bot ${token}` } }).then((r) => r.json());
    const ellie = (Array.isArray(emojis) ? emojis : [])
        .filter((e) => /ellie/i.test(e.name) && !e.animated)
        .pop();
    if (!ellie) return null;
    const res = await fetch(`https://cdn.discordapp.com/emojis/${ellie.id}.png?size=256&quality=lossless`);
    if (!res.ok) return null;
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: 'image/png' };
}

const wanted = fromDirs.length ? [] : [...CATALOGUE, ...ELLIE]
    .filter((e) => !sets.length || sets.includes(e.set));
fs.mkdirSync(outDir, { recursive: true });

const reference = wanted.some((e) => e.set === 'ellie') ? await ellieReference() : null;
if (wanted.some((e) => e.set === 'ellie') && !reference) {
    console.log('no :Ellie: emoji to work from — skipping her set\n');
}

const made = [];

for (const dir of fromDirs) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.png') && !f.startsWith('_'))) {
        const name = emoteName(path.basename(file, '.png'));
        if (!name) { console.log(`× ${file}: not a usable emoji name`); continue; }
        if (cap.names.has(name)) { console.log(`· ${name}: already in the guild, skipped`); continue; }
        /* Re-fit whatever is on disk. A directory can hold anything — a
           full-size cut-out, a photo someone dropped in — and Discord's 256 KiB
           limit is not negotiable, so nothing is trusted to already be an emoji. */
        const raw = fs.readFileSync(path.join(dir, file));
        const buffer = await prepareEmote(raw);
        made.push({ name, buffer, set: 'disk' });
        console.log(`· ${name.padEnd(16)} ${(buffer.length / 1024).toFixed(0)}KB  read from ${dir}`);
    }
}

for (const entry of wanted) {
    const name = emoteName(entry.name);
    if (!name) { console.log(`× ${entry.name}: not a usable emoji name`); continue; }
    if (cap.names.has(name)) { console.log(`· ${name}: already in the guild, skipped`); continue; }
    if (entry.set === 'ellie' && !reference) continue;

    try {
        const t0 = Date.now();
        const art = await generateImage({
            prompt: entry.set === 'ellie'
                ? `${stickerPrompt(entry.subject)} Keep the same breed, the same fur colours and the same markings as the photograph.`
                : stickerPrompt(entry.subject),
            reference: entry.set === 'ellie' ? reference : null,
            aspect: 'square',
        });
        const emote = await makeEmote(art.buffer);
        fs.writeFileSync(path.join(outDir, `${name}.png`), emote.buffer);
        made.push({ name, buffer: emote.buffer, set: entry.set });
        console.log(`✓ ${name.padEnd(16)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ` +
            `${(emote.bytes / 1024).toFixed(0)}KB  ${emote.cut ? `cut ${(emote.coverage * 100).toFixed(0)}% backdrop` : 'no cut'}`);
    } catch (e) {
        console.log(`× ${name}: ${e.message}`);
    }
}

// A contact sheet, on the same grey Discord actually shows emoji against.
if (made.length && !fromDirs.length) {
    const cols = 6, cell = 140;
    const rows = Math.ceil(made.length / cols);
    const sheet = sharp({
        create: { width: cols * cell, height: rows * cell, channels: 4, background: '#313338' },
    });
    const tiles = await Promise.all(made.map(async (m, i) => ({
        input: await sharp(m.buffer).resize(120, 120, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer(),
        left: (i % cols) * cell + 10,
        top: Math.floor(i / cols) * cell + 10,
    })));
    await sheet.composite(tiles).png().toFile(path.join(outDir, '_contact-sheet.png'));
    console.log(`\ncontact sheet: ${path.join(outDir, '_contact-sheet.png')}`);
}

if (!doUpload) {
    console.log(`\n${made.length} candidates written to ${outDir}. Re-run with --upload to put them in the guild.`);
    process.exit(0);
}

let free = cap.free;
for (const m of made) {
    if (free <= 0) { console.log(`— ${m.name}: no slots left`); continue; }
    const res = await uploadEmote(token, guildId, m.name, m.buffer, 'Emote pack');
    if (res.ok) { free--; console.log(`↑ :${m.name}: uploaded`); }
    else console.log(`× ${m.name}: ${res.status} ${res.reason}`);
    await new Promise((r) => setTimeout(r, 1200));   // emoji routes rate-limit hard
}
console.log(`\ndone — ${free} static slots left`);
process.exit(0);
