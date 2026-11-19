import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEmojiWall } from '../core/advanced-automod-manager.js';

// The self-promo post that was deleted and timed out on 2026-10-10: 13 emojis, one per line.
const PROMO = `👀🎮 NICE NATION IS GOING INTO THE UNKNOWN! 💗

We’re shaking up our Saturday tradition! Change can be scary, but we’re trying something NEW together! 😂

📝 SATURDAY DETENTION — TODAY @ 10:30 AM EST!
Goodbye, Stay & Slay Super Solos! 👋
🎮 Fortnite WITH VIEWERS! Join the queue and squad up with MrsNice!

⚔️ SUNDAY @ 2:30 PM EST — STAY & SLAY DYNAMIC DUOS!
Some traditions are worth keeping! 💗
🔥 Fortnite Customs + Prizes! Are you and your duo up to the challenge?

💗 Come play or hang out with the nicest community on Twitch!

🎮 twitch.tv/mrsnice_fdm

💗 Be Nice. Always. Everywhere.`;

test('emojis spread through an announcement are not spam', () => {
    assert.equal(findEmojiWall(PROMO, 12), null);
    assert.equal(findEmojiWall(PROMO, 5), null);
});

test('an unbroken run of emojis is spam, whitespace does not break it', () => {
    assert.match(findEmojiWall('lol ' + '🔥'.repeat(13), 12), /13 emojis in a row/);
    assert.match(findEmojiWall('lol ' + '🔥 '.repeat(13), 12), /13 emojis in a row/);
    assert.equal(findEmojiWall('lol ' + '🔥'.repeat(12), 12), null);
});

test('a message that is mostly emoji is spam even when broken up', () => {
    assert.match(findEmojiWall('😀😀😀😀 a 😀😀😀😀 b 😀😀😀😀 c 😀', 12), /13 emojis to 3 words/);
});

test('emojis are counted as people see them', () => {
    // ⚔️ = U+2694 U+FE0F, 👨‍👩‍👧 = 5 code points, 🇺🇸 = 2 regional indicators: one emoji each.
    assert.equal(findEmojiWall('⚔️👨‍👩‍👧🇺🇸', 3), null);
    assert.match(findEmojiWall('⚔️👨‍👩‍👧🇺🇸', 2), /3 emojis in a row/);
});

test('custom Discord emojis count as one each', () => {
    assert.match(findEmojiWall('<:pog:123>'.repeat(4) + '<a:dance:456>', 4), /5 emojis in a row/);
    assert.equal(findEmojiWall('<:pog:123> nice stream today <:pog:123>', 1), null);
});
