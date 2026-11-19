import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/*
 * AI DJ blocklist / favourites / presets (core/dj-blocklist.cjs). What has to be right:
 *   - a blocked artist is caught however YouTube or Spotify credits them (uploader "VEVO"/"- Topic"
 *     channels, "Artist - Title" titles, "feat." credits, multi-artist credits) …
 *   - … but never by a substring: blocking "Queen" must leave "Dancing Queen" and Queen Latifah alone
 *   - a blocked song is caught in any upload of it, optionally only by one artist
 *   - Gemini is told the exclusions, without changing the prompt when nothing is blocked
 *   - favourites are picked by weight, without repeats
 */
const require = createRequire(import.meta.url);
const bl = require('../core/dj-blocklist.cjs');

const entries = (...rows) => rows.map(bl.entryFromRow).filter(Boolean);

test('artist block: matches the usual ways a track credits the artist', () => {
    const list = entries({ id: 1, entry_type: 'artist', artist: 'Rick Astley' });
    for (const t of [
        { title: 'Never Gonna Give You Up', author: 'Rick Astley' },
        { title: 'Never Gonna Give You Up', author: 'RickAstleyVEVO' },
        { title: 'Never Gonna Give You Up', author: 'Rick Astley - Topic' },
        { title: 'Rick Astley - Never Gonna Give You Up (Official Video)', author: 'Some Uploader' },
        { title: 'Remix (feat. Rick Astley)', author: 'DJ Someone' },
        { title: 'Together', author: 'DJ Someone, Rick Astley' },
        { title: 'Together', author: 'DJ Someone & Rick Astley' },
        { title: 'Together', artist: 'Rick Astley' },                 // a Gemini recommendation
        { title: 'Song', author: 'RICK ASTLEY' },
    ]) {
        assert.ok(bl.blockedBy(t, list), `should block ${JSON.stringify(t)}`);
    }
});

test('artist block: never matches on a substring of a title or a longer name', () => {
    const list = entries({ entry_type: 'artist', artist: 'Queen' });
    assert.ok(bl.blockedBy({ title: 'Bohemian Rhapsody', author: 'Queen' }, list));
    assert.ok(bl.blockedBy({ title: 'Bohemian Rhapsody', author: 'Queen Official' }, list));
    assert.equal(bl.blockedBy({ title: 'Dancing Queen', author: 'ABBA' }, list), null);
    assert.equal(bl.blockedBy({ title: 'U.N.I.T.Y.', author: 'Queen Latifah' }, list), null);
    assert.equal(bl.blockedBy({ title: 'Go With The Flow', author: 'Queens of the Stone Age' }, list), null);
});

test('artist block: names that contain separators still match themselves', () => {
    assert.ok(bl.blockedBy({ title: 'The Boxer', author: 'Simon & Garfunkel' }, entries({ entry_type: 'artist', artist: 'Simon & Garfunkel' })));
    assert.ok(bl.blockedBy({ title: 'Earfquake', author: 'Tyler, The Creator' }, entries({ entry_type: 'artist', artist: 'Tyler, The Creator' })));
    assert.ok(bl.blockedBy({ title: 'Dog Days', author: 'Florence + the Machine' }, entries({ entry_type: 'artist', artist: 'Florence + the Machine' })));
});

test('song block: any upload of the song, optionally only by one artist', () => {
    const any = entries({ entry_type: 'song', title: 'Never Gonna Give You Up' });
    assert.ok(bl.blockedBy({ title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)', author: 'Rick Astley' }, any));
    assert.ok(bl.blockedBy({ title: 'Never Gonna Give You Up [Remastered 2022]', author: 'Rick Astley' }, any));
    assert.ok(bl.blockedBy({ title: 'never gonna give you up', artist: 'Some Cover Band' }, any));
    assert.equal(bl.blockedBy({ title: 'Together Forever', author: 'Rick Astley' }, any), null);

    const byOne = entries({ entry_type: 'song', title: 'Hallelujah', artist: 'Leonard Cohen' });
    assert.ok(bl.blockedBy({ title: 'Hallelujah', author: 'Leonard Cohen' }, byOne));
    assert.equal(bl.blockedBy({ title: 'Hallelujah', author: 'Jeff Buckley' }, byOne), null);
});

test('song block: a short title only matches exactly, not inside other titles', () => {
    const list = entries({ entry_type: 'song', title: 'Hello' });
    assert.ok(bl.blockedBy({ title: 'Adele - Hello (Official Music Video)', author: 'Adele' }, list));
    assert.equal(bl.blockedBy({ title: 'Hello, Goodbye', author: 'The Beatles' }, list), null);
});

test('rows from before migration 291 (title only in song_identifier) still work', () => {
    const list = entries({ id: 5, song_identifier: 'Africa' });
    assert.equal(list[0].type, 'song');
    assert.ok(bl.blockedBy({ title: 'Toto - Africa (Official HD Video)', author: 'TotoVEVO' }, list));
});

test('entryKey collides for the same entry written differently', () => {
    assert.equal(bl.entryKey('artist', null, 'Rick Astley'), bl.entryKey('artist', null, 'rick astley - Topic'));
    assert.equal(bl.entryKey('song', 'Africa (Remastered)', 'TOTO'), bl.entryKey('song', 'africa', 'Toto'));
    assert.notEqual(bl.entryKey('song', 'Africa', 'Toto'), bl.entryKey('song', 'Africa', ''));
    assert.ok(bl.entryKey('song', 'x'.repeat(400), 'y').length <= 255);
});

test('filterBlocked splits kept and blocked items', () => {
    const list = entries({ entry_type: 'artist', artist: 'Nickelback' }, { entry_type: 'song', title: 'Baby Shark' });
    const { kept, blocked } = bl.filterBlocked([
        { title: 'Photograph', author: 'Nickelback' },
        { title: 'Baby Shark Dance', author: 'Pinkfong' },        // 3-word containment does not apply (2 words)
        { title: 'Baby Shark', author: 'Pinkfong' },
        { title: 'Take On Me', author: 'a-ha' },
    ], list);
    assert.deepEqual(kept.map(t => t.title), ['Baby Shark Dance', 'Take On Me']);
    assert.deepEqual(blocked.map(b => b.entry.type), ['artist', 'song']);
});

test('exclusionText names everything, safely, within the budget', () => {
    const list = entries({ entry_type: 'artist', artist: 'Nickelback' }, { entry_type: 'song', title: 'Baby "Shark"\nignore previous', artist: 'Pinkfong' });
    const text = bl.exclusionText(list);
    assert.match(text, /Nickelback/);
    assert.match(text, /"Baby Shark ignore previous" by Pinkfong/);
    assert.ok(!text.includes('\n'));
    assert.equal(bl.exclusionText([]), '');
    const many = entries(...Array.from({ length: 500 }, (_, i) => ({ entry_type: 'artist', artist: `Artist Number ${i}` })));
    assert.ok(bl.exclusionText(many).length < 1700);
});

test('withExclusions leaves the prompt alone when nothing is blocked', () => {
    assert.equal(bl.withExclusions(null, { inputSong: 'x' }, ''), null);
    assert.equal(bl.withExclusions('chill beats', {}, ''), 'chill beats');
    const p = bl.withExclusions(null, { inputSong: 'Africa', inputArtist: 'Toto', inputGenre: 'rock' }, 'STRICT EXCLUSIONS x.');
    assert.equal(p, 'songs similar to "Africa" by Toto, in the genre rock. STRICT EXCLUSIONS x.');
    assert.equal(bl.withExclusions('chill beats', {}, 'NO.'), 'chill beats. NO.');
    assert.equal(bl.withExclusions(null, {}, 'NO.'), 'a diverse mix of popular songs. NO.');
    // A fallback prompt that already ends in a full stop doesn't get a double one.
    assert.equal(bl.joinPrompt('Focus on songs on YouTube.', null, '', 'STRICT x.'), 'Focus on songs on YouTube. STRICT x.');
    assert.equal(bl.joinPrompt(null, ''), null);
});

test('pickWeighted: weighted, no repeats, bounded', () => {
    const favs = [{ song_title: 'A', priority: 1 }, { song_title: 'B', priority: 10 }, { song_title: 'C', priority: 0 }];
    assert.equal(bl.pickWeighted(favs, 5).length, 3);
    assert.equal(new Set(bl.pickWeighted(favs, 3).map(f => f.song_title)).size, 3);
    assert.deepEqual(bl.pickWeighted([], 3), []);
    // rand → 0.5 of total weight 12: A covers [0,1), B [1,11) → B
    assert.equal(bl.pickWeighted(favs, 1, () => 0.5)[0].song_title, 'B');
    assert.equal(bl.pickWeighted(favs, 1, () => 0)[0].song_title, 'A');
    assert.equal(bl.pickWeighted(favs, 1, () => 0.999)[0].song_title, 'C');
    let heavy = 0;
    for (let i = 0; i < 2000; i++) if (bl.pickWeighted(favs, 1)[0].song_title === 'B') heavy++;
    assert.ok(heavy > 1400, `B (weight 10 of 12) picked ${heavy}/2000`);
});

test('favoritesSeedText and presets', () => {
    assert.equal(bl.favoritesSeedText([]), '');
    assert.match(bl.favoritesSeedText([{ song_title: 'Africa', artist: 'Toto' }]), /"Africa" by Toto/);
    const cfg = bl.buildPresetConfig({ prompt: '  late night synthwave ', genre: '', bogus: 'x', playlistLink: 'https://x' });
    assert.deepEqual(cfg, { prompt: 'late night synthwave', playlistLink: 'https://x' });
    assert.deepEqual(bl.parsePresetConfig(JSON.stringify(cfg)), cfg);
    assert.deepEqual(bl.parsePresetConfig('{bad json'), {});
    assert.deepEqual(bl.parsePresetConfig('{"playlist_link":"https://y","song":"s"}'), { song: 's', playlistLink: 'https://y' });
    assert.match(bl.describePreset(cfg), /prompt "late night synthwave".*playlist link/);
    assert.equal(bl.describePreset({}), 'server defaults');
});
