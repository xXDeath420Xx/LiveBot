import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { avatarFingerprint } from '../core/image-fingerprint.js';
import {
    variantToString, variantFromString, fpToString, fpFromString, variantFromBits, bitsOf, hamming256, variantScore, scoreAgainst,
    normaliseThresholds, decide, usableFingerprint, isSuppressed, addSuppression, bestMatch, canonicalHash, flatKind, solidPixels,
    BUILTIN_SCAM_AVATARS, exactScamMatch, avatarTargets, avatarKeyHash, pickScopes, planAvatarCleanse, splitAvatarForce,
    planAvatarDownloads, planAvatarAutoPilot, avatarReason, avatarEventAction, DEFAULT_AUTO, DEFAULT_REVIEW, MAX_SUPPRESS,
} from '../core/avatar-match-logic.js';

/*
 * Avatar protection (core/avatar-match-logic.js + avatarFingerprint in core/image-fingerprint.js).
 * What has to stay true:
 *   - a re-uploaded staff avatar scores at the act threshold; zoomed, mirrored and round-cropped copies
 *     at least reach the review queue; unrelated pictures never reach the slider's floor
 *   - flat pictures are never scored (they would match each other), but the ticket-scam kit's black and
 *     transparent avatars are caught EXACTLY, through Discord's re-encoding, and nothing else is
 *   - "not a match" suppresses that avatar against that image only; the protected member is never matched
 *   - cleanse / Auto-Pilot planning leaves the right people and rows alone
 *   - audit-log reasons are plain ASCII
 */

const ROOT = new URL('..', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, ROOT));
const src = (rel) => fs.readFileSync(new URL(rel, ROOT), 'utf8');

// Real, detailed pictures standing in for avatars. The catbot set is ONE drawing recoloured per rarity,
// so only one of it is in the "unrelated" set; two of its recolours are the "edited copy" case below.
// (The rank presets are smooth gradients: the flat-picture test relies on them being refused.)
const AVATARS = [
    'assets/catbot/gremlin.png', 'docs/ModBears.png', 'docs/kirby.png', 'docs/emoji.png', 'docs/Adult_Consent.png',
    'docs/Welcome.png', 'docs/Rules.png', 'docs/SafeSpace.png', 'docs/diablo.png', 'docs/fortnightmares.png',
    'docs/join-screen.png', 'docs/Unsolicited.png', 'docs/scam.jpg', 'docs/image2.jpg', 'docs/schedule4.png',
].filter(f => fs.existsSync(new URL(f, ROOT)));

const square = async (buf, size = 512) => sharp(buf).resize(size, size, { fit: 'cover' }).png().toBuffer();
const fpOf = async (buf) => avatarFingerprint(buf);
const usableFp = (fp) => usableFingerprint(fp);
const sha = (fp) => canonicalHash(fp.canonical);

test('fingerprint variants survive a round trip through their stored form', async () => {
    const fp = await fpOf(await square(read(AVATARS[0])));
    assert.equal(fp.variants.length, 7);
    const s = fpToString(fp.variants);
    const back = fpFromString(s);
    assert.equal(back.length, 7);
    for (let i = 0; i < 7; i++) {
        assert.equal(hamming256(back[i], fp.variants[i]), 0);
        assert.equal(variantScore(back[i], fp.variants[i]), 1);
    }
    assert.equal(variantFromString('nope'), null);
    assert.equal(variantToString(variantFromString(variantToString(fp.variants[0]))), variantToString(fp.variants[0]));
    const bits = Array.from({ length: 256 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    assert.equal(bitsOf(variantFromBits(bits, new Uint8Array(48))), bits.filter(Boolean).length);
});

test('a re-uploaded avatar scores at the act threshold; edited copies reach review', async () => {
    assert.ok(AVATARS.length >= 8, 'test pictures present');
    // The first four are avatar-like pictures (a face / a mascot); text-heavy banners lose more to a zoom.
    for (const file of AVATARS.slice(0, 4)) {
        const original = await square(read(file));
        const prot = await fpOf(original);
        assert.ok(usableFp(prot), `${file} is detailed enough to protect`);
        const meta = { w: 512 };
        const crop = Math.round(meta.w * 0.05);
        const variants = {
            'webp re-upload': await sharp(original).resize(256, 256).webp({ quality: 75 }).toBuffer(),
            'jpeg re-upload': await sharp(original).resize(1024, 1024).jpeg({ quality: 85 }).toBuffer(),
            'png 128': await sharp(original).resize(128, 128).png().toBuffer(),
        };
        for (const [name, buf] of Object.entries(variants)) {
            const s = scoreAgainst((await fpOf(buf)).variants, prot.variants).score;
            assert.ok(s >= DEFAULT_AUTO, `${file} ${name}: ${s.toFixed(3)} should be >= ${DEFAULT_AUTO}`);
        }
        const edited = {
            'zoomed 5%': await sharp(original).extract({ left: crop, top: crop, width: meta.w - 2 * crop, height: meta.w - 2 * crop }).toBuffer(),
            mirrored: await sharp(original).flop().toBuffer(),
            'brighter': await sharp(original).modulate({ brightness: 1.1 }).toBuffer(),
        };
        for (const [name, buf] of Object.entries(edited)) {
            const s = scoreAgainst((await fpOf(buf)).variants, prot.variants).score;
            assert.ok(s >= DEFAULT_REVIEW, `${file} ${name}: ${s.toFixed(3)} should reach review (${DEFAULT_REVIEW})`);
        }
    }
});

test('a recoloured copy of the same drawing is caught, but is not scored as identical', async () => {
    const fine = await fpOf(await square(read('assets/catbot/fine.png')));
    for (const other of ['nice', 'good', 'gremlin']) {
        const copy = await fpOf(await square(read(`assets/catbot/${other}.png`)));
        const s = scoreAgainst(copy.variants, fine.variants).score;
        assert.ok(decide(s, { auto: DEFAULT_AUTO, review: DEFAULT_REVIEW }), `${other}: scored ${s.toFixed(3)}`);
        assert.ok(s < 0.97, `${other}: ${s.toFixed(3)} is not a re-upload`);
    }
});

test('unrelated pictures never reach the slider floor', async () => {
    const fps = [];
    for (const f of AVATARS) fps.push(await fpOf(await square(read(f))));
    let worst = 0;
    for (let i = 0; i < fps.length; i++) {
        for (let j = 0; j < fps.length; j++) {
            if (i === j) continue;
            worst = Math.max(worst, scoreAgainst(fps[i].variants, fps[j].variants).score);
        }
    }
    assert.ok(worst < 0.70, `closest unrelated pair scored ${worst.toFixed(3)}`);
});

test('flat pictures are refused for scoring', async () => {
    const solid = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 120, g: 30, b: 200 } } }).png().toBuffer();
    const grad = await sharp(Buffer.from(Array.from({ length: 256 * 256 * 3 }, (_, i) => Math.floor((i / 3) % 256 / 2))), { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
    let seed = 7;
    const noisy = await sharp(Buffer.from(Array.from({ length: 256 * 256 * 3 }, () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return 100 + (seed % 3); })),
        { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
    for (const [name, buf] of Object.entries({ solid, gradient: grad, 'near-flat noise': noisy })) {
        const fp = await fpOf(buf);
        assert.equal(usableFp(fp), false, `${name} must not be scored (bits ${fp.bits}, contrast ${fp.contrast.toFixed(1)})`);
    }
});

test('the ticket-scam black and transparent avatars match exactly through re-encoding', async () => {
    const black = { r: 0, g: 0, b: 0, alpha: 1 };
    const clear = { r: 0, g: 0, b: 0, alpha: 0 };
    const make = (bg, size = 512) => sharp({ create: { width: size, height: size, channels: 4, background: bg } });
    const blacks = {
        png: await make(black).png().toBuffer(),
        jpeg: await make(black).flatten({ background: '#000000' }).jpeg({ quality: 70 }).toBuffer(),
        webp: await make(black, 128).webp({ quality: 50 }).toBuffer(),
        'near-black #0a0a0a': await make({ r: 10, g: 10, b: 10, alpha: 1 }).png().toBuffer(),
    };
    for (const [name, buf] of Object.entries(blacks)) {
        const fp = await fpOf(buf);
        assert.equal(flatKind(fp.canonical), 'black', name);
        assert.deepEqual(exactScamMatch(sha(fp)), { builtin: true, key: 'black', label: BUILTIN_SCAM_AVATARS[0].label }, name);
        assert.equal(usableFp(fp), false, `${name} is never scored perceptually`);
    }
    const clears = {
        png: await make(clear).png().toBuffer(),
        webp: await make(clear, 128).webp({ lossless: true }).toBuffer(),
        // a transparent pixel's colour is whatever the encoder left there; it must not matter
        'transparent red': await make({ r: 255, g: 0, b: 0, alpha: 0 }).png().toBuffer(),
    };
    for (const [name, buf] of Object.entries(clears)) {
        const fp = await fpOf(buf);
        assert.equal(flatKind(fp.canonical), 'transparent', name);
        assert.equal(exactScamMatch(sha(fp))?.key, 'transparent', name);
    }
    const notScam = {
        'dark grey #333': await make({ r: 51, g: 51, b: 51, alpha: 1 }).png().toBuffer(),
        'white': await make({ r: 255, g: 255, b: 255, alpha: 1 }).png().toBuffer(),
        'half transparent': await make({ r: 0, g: 0, b: 0, alpha: 0.5 }).png().toBuffer(),
        'black with a logo': await make(black).composite([{ input: await sharp(read(AVATARS[0])).resize(200, 200).png().toBuffer(), gravity: 'center' }]).png().toBuffer(),
        'real picture': await square(read(AVATARS[1])),
    };
    for (const [name, buf] of Object.entries(notScam)) {
        assert.equal(exactScamMatch(sha(await fpOf(buf))), null, `${name} is not a scam avatar`);
    }
});

test('canonical hashing: built-ins come from synthetic pixels; stored entries match by hash', () => {
    assert.equal(BUILTIN_SCAM_AVATARS.length, 2);
    assert.notEqual(BUILTIN_SCAM_AVATARS[0].sha, BUILTIN_SCAM_AVATARS[1].sha);
    assert.equal(canonicalHash(solidPixels(5, 3, 0, 250)), BUILTIN_SCAM_AVATARS[0].sha, 'quantised to the same levels');
    assert.equal(canonicalHash(solidPixels(200, 100, 50, 3)), BUILTIN_SCAM_AVATARS[1].sha, 'invisible pixels zeroed');
    assert.equal(flatKind(solidPixels(40, 40, 40, 255)), null);
    const stored = [{ id: 9, sha: 'a'.repeat(64), label: 'Learned' }];
    assert.deepEqual(exactScamMatch('a'.repeat(64), stored), { builtin: false, id: 9, label: 'Learned' });
    assert.equal(exactScamMatch('b'.repeat(64), stored), null);
    assert.equal(exactScamMatch(null, stored), null);
});

test('thresholds: clamped to 0.70-1.00, review never above act; decide bands', () => {
    assert.deepEqual(normaliseThresholds(0.92, 0.8), { auto: 0.92, review: 0.8 });
    assert.deepEqual(normaliseThresholds(0.5, 0.2), { auto: 0.7, review: 0.7 });
    assert.deepEqual(normaliseThresholds(1.4, 0.95), { auto: 1, review: 0.95 });
    assert.deepEqual(normaliseThresholds(0.8, 0.9), { auto: 0.8, review: 0.8 });
    assert.deepEqual(normaliseThresholds('x', null), { auto: DEFAULT_AUTO, review: 0.7 });
    assert.deepEqual(normaliseThresholds(undefined, 'y'), { auto: DEFAULT_AUTO, review: DEFAULT_REVIEW });
    assert.deepEqual(normaliseThresholds('0.934', '0.811'), { auto: 0.93, review: 0.81 });
    const t = { auto: 0.92, review: 0.8 };
    assert.equal(decide(0.99, t), 'auto');
    assert.equal(decide(0.92, t), 'auto');
    assert.equal(decide(0.85, t), 'review');
    assert.equal(decide(0.79, t), null);
    assert.equal(decide(0.69, { auto: 0.7, review: 0.7 }), null, 'never below the floor');
    assert.equal(decide(Number.NaN, t), null);
});

test('"not a match" suppresses that avatar against that image, and the protected member is never matched', async () => {
    const a = await fpOf(await square(read(AVATARS[0])));
    const b = await fpOf(await square(read(AVATARS[1])));
    const reup = await fpOf(await sharp(await square(read(AVATARS[0]))).resize(256, 256).webp({ quality: 80 }).toBuffer());
    const entries = [
        { id: 1, variants: a.variants, protectedUserId: 'staff1', suppressed: [] },
        { id: 2, variants: b.variants, protectedUserId: null, suppressed: [] },
    ];
    const hit = bestMatch(reup.variants, entries, { review: 0.8, memberId: 'someone' });
    assert.equal(hit?.entry.id, 1);
    assert.equal(bestMatch(reup.variants, entries, { review: 0.8, memberId: 'staff1' }), null, 'the staff member themself');

    const list = addSuppression([], variantToString(reup.variants[0]));
    assert.equal(list.length, 1);
    assert.equal(addSuppression(list, variantToString(reup.variants[0])).length, 1, 'a near-duplicate is not added twice');
    entries[0].suppressed = list.map(variantFromString);
    assert.equal(isSuppressed(reup.variants, entries[0].suppressed), true);
    assert.equal(bestMatch(reup.variants, entries, { review: 0.8, memberId: 'someone' }), null, 'suppressed against image 1');
    // ...but only that pair: the same image still catches a different copy (mirrored), and other images are untouched
    const mirrored = await fpOf(await sharp(await square(read(AVATARS[0]))).flop().toBuffer());
    assert.equal(isSuppressed(mirrored.variants, entries[0].suppressed), false);
    assert.equal(bestMatch(mirrored.variants, entries, { review: 0.8 })?.entry.id, 1);
    const reupB = await fpOf(await sharp(await square(read(AVATARS[1]))).webp({ quality: 70 }).toBuffer());
    assert.equal(bestMatch(reupB.variants, entries, { review: 0.8 })?.entry.id, 2);

    // capped, oldest first
    let many = [];
    let seed = 1;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    let last = null;
    for (let i = 0; i < 15; i++) {
        last = variantToString({ d: Uint32Array.from({ length: 8 }, rnd), c: Uint8Array.from({ length: 48 }, () => rnd() & 255) });
        many = addSuppression(many, last, 10);
    }
    assert.equal(many.length, 10);
    assert.equal(many[9], last, 'newest kept, oldest dropped');
    assert.ok(MAX_SUPPRESS >= 100);
});

test('avatar targets: default avatars skipped, server avatar only when different, static PNG', () => {
    assert.deepEqual(avatarTargets({ userId: '1', guildId: '2' }), []);
    const both = avatarTargets({ userId: '1', guildId: '2', userAvatar: 'a_abc', guildAvatar: 'def' });
    assert.equal(both.length, 2);
    assert.equal(both[0].url, 'https://cdn.discordapp.com/avatars/1/a_abc.png?size=128');
    assert.equal(both[1].url, 'https://cdn.discordapp.com/guilds/2/users/1/avatars/def.png?size=128');
    assert.deepEqual(both.map(t => t.key), ['global:a_abc', 'server:def']);
    assert.equal(avatarTargets({ userId: '1', guildId: '2', userAvatar: 'x', guildAvatar: 'x' }).length, 1);
    assert.deepEqual(pickScopes(both, 'server').map(t => t.scope), ['server']);
    assert.deepEqual(pickScopes(both, 'global').map(t => t.scope), ['global']);
    assert.equal(pickScopes(both, 'both').length, 2);
    assert.match(avatarKeyHash('global:a_abc'), /^[0-9a-f]{16}$/);
    assert.notEqual(avatarKeyHash('global:a'), avatarKeyHash('server:a'));
});

test('cleanse planning: who is queued, who is left alone, what force acts on, downloads deduped', () => {
    const m = (key, kind = 'image', decision = 'auto') => ({ kind, decision, key });
    const plan = planAvatarCleanse([
        { id: 'bot', bot: true },
        { id: 'clean', match: null },
        { id: 'owner', owner: true, match: m('global:o') },
        { id: 'mod', staff: true, match: m('global:m') },
        { id: 'prot', protectedSelf: true, match: m('global:p') },
        { id: 'ex', exempt: true, match: m('global:e') },
        { id: 'safeSame', safeHash: avatarKeyHash('global:s'), match: m('global:s') },
        { id: 'safeChanged', safeHash: avatarKeyHash('global:old'), match: m('global:new') },
        { id: 'hit', match: m('server:h', 'image', 'review') },
        { id: 'scam', match: m('global:x', 'scam') },
    ]);
    assert.deepEqual(plan.queue.map(c => c.id), ['safeChanged', 'hit', 'scam']);
    assert.deepEqual(plan.skipped, { bots: ['bot'], staff: ['owner', 'mod'], exempt: ['ex'], protected: ['prot'], safe: ['safeSame'] });
    assert.equal(plan.clean, 1);

    const q = [{ id: 'near', match: m('a', 'image', 'auto') }, { id: 'band', match: m('b', 'image', 'review') }, { id: 'scam', match: m('c', 'scam') }];
    assert.deepEqual(splitAvatarForce(q, { action: 'ban', scamAction: 'log' }).act.map(c => c.id), ['near']);
    assert.deepEqual(splitAvatarForce(q, { action: 'log', scamAction: 'kick' }).act.map(c => c.id), ['scam']);
    assert.deepEqual(splitAvatarForce(q, { action: 'kick', scamAction: 'kick' }).review.map(c => c.id), ['band']);

    const t = (u, k) => ({ url: `https://x/${u}`, key: k, scope: 'global' });
    const d = planAvatarDownloads([[t(1, 'a')], [t(1, 'a'), t(2, 'b')], [t(3, 'c')], []], new Set(['https://x/3']));
    assert.deepEqual(d.jobs.map(j => j.url), ['https://x/1', 'https://x/2']);
    assert.equal(d.avatars, 4);
    assert.equal(d.members, 4);
});

test('Auto-Pilot planning: creates for covered staff, follows changes, remembers deletions', () => {
    const tg = (scope, hash) => ({ scope, key: `${scope}:${hash}`, url: `https://x/${hash}` });
    const plan = planAvatarAutoPilot({
        protectedMembers: [
            { id: 'a', targets: [tg('global', 'new1'), tg('server', 's1')] },
            { id: 'b', targets: [] },                      // default avatar: nothing to protect
            { id: 'c', targets: [tg('global', 'c1')] },
        ],
        existing: [
            { id: 10, userId: 'a', key: 'global:old1', removed: false },   // changed avatar: retire
            { id: 11, userId: 'a', key: 'server:s1', removed: false },     // unchanged: keep
            { id: 12, userId: 'c', key: 'global:c1', removed: true },      // deleted by staff: not recreated
            { id: 13, userId: 'gone', key: 'global:z', removed: false },   // no longer covered: retire
            { id: 14, userId: 'gone', key: 'global:y', removed: true },    // removed rows are never "retired"
        ],
    });
    assert.deepEqual(plan.create.map(c => `${c.userId}|${c.key}`), ['a|global:new1']);
    assert.deepEqual(plan.retire.sort(), [10, 13]);
});

test('audit-log reasons are plain ASCII and never carry a label; event actions map', () => {
    const reasons = [
        avatarReason({ kind: 'image', imageId: 7, score: 0.934, label: 'Mød ✨ avatar' }),
        avatarReason({ kind: 'image', imageId: 7, score: 0.85 }, 'review'),
        avatarReason({ kind: 'scam', builtinKey: 'black', label: 'Solid black' }, 'cleanse'),
        avatarReason({ kind: 'scam', label: 'ⓢⓒⓐⓜ' }),
        avatarReason(null),
    ];
    for (const r of reasons) assert.match(r, /^[\x20-\x7E]+$/, r);
    assert.equal(reasons[0], 'Avatar protection: avatar matches protected image #7 (93%)');
    assert.equal(reasons[2], 'Avatar protection: known scam avatar (black) (cleanse)');
    assert.equal(avatarEventAction('ban'), 'avatar_banned');
    assert.equal(avatarEventAction('queue'), 'avatar_queued');
    assert.equal(avatarEventAction('log'), 'avatar_logged');
});

test('wiring: join check, both change events, and the shared tables stay separated by kind', () => {
    const gate = src('core/join-gate.js');
    assert.match(gate, /await checkAvatarOnJoin\(member, cfg\)/);
    assert.match(gate, /verdict === 'avatar_removed'/);
    assert.match(src('events/guildMemberUpdate.js'), /checkAvatarProtection\(oldMember, newMember\)/);
    assert.match(src('events/userUpdate.js'), /checkAvatarProtection\(oldUser, newUser\)/);

    // The scam-image blocklist must only ever read its own rows, or a staff avatar posted in chat would be deleted.
    const blocklist = src('core/image-blocklist.js');
    const reads = [...blocklist.matchAll(/FROM blocked_images[\s\S]{0,120}/g)];
    assert.ok(reads.length >= 4);
    for (const m of reads) assert.match(m[0], /kind = 'message'/, `blocklist query not scoped: ${m[0]}`);
    // The name queue and the avatar queue share name_filter_reviews; every read/update/delete names its kind.
    for (const [file, kind] of [['core/name-filters.js', 'name'], ['core/avatar-protection.js', 'avatar']]) {
        for (const m of src(file).matchAll(/(SELECT|UPDATE|DELETE)[\s\S]{0,80}?name_filter_reviews[\s\S]{0,400}?(\[|`,|",)/g)) {
            if (/^SELECT[\s\S]*LEFT JOIN/.test(m[0])) continue;
            assert.match(m[0], new RegExp(`kind = '${kind}'`), `${file}: ${m[0].slice(0, 120)}`);
        }
    }
    assert.match(src('core/avatar-protection.js'), /await protectionHold\(/);
});
