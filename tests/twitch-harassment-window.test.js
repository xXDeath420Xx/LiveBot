import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestChatMessage, mentionTargets } from '../core/twitch-analytics-ingest.js';

const say = (bid, login, text) => ingestChatMessage(bid, login, login, text, 'wolfzgangz');

test('the Oct 30 freakyseafood19 conversation raises nothing', () => {
    const bid = 'replay';
    say(bid, 'kingkirby2900', '@freakyseafood19 hello there how are you doing today');
    say(bid, 'wolfzgangz', '!so @freakyseafood19');
    say(bid, 'freakyseafood19', '@kingkirby2900 tired wbu');
    say(bid, 'kingkirby2900', "@freakyseafood19 I'm tired thank you for asking");
    say(bid, 'freakyseafood19', '@itsladyblueee I can\'t wait for candy');
    say(bid, 'itsladyblueee', '@freakyseafood19 Ooop');
    assert.deepEqual(mentionTargets(bid, 1), []);
});

test("a target who replies to only some senders keeps the others counted", () => {
    const bid = "partial";
    for (const u of ["a1", "a2", "a3"]) say(bid, u, "@victim hi");
    say(bid, "victim", "@a1 hey");
    const [hit] = mentionTargets(bid, 2);
    assert.deepEqual(hit.senders.sort(), ["a2", "a3"]);
    assert.deepEqual(hit.conversing, ["a1"]);
});

test('five different people with no reply are flagged, each counted once', () => {
    const bid = 'pileon';
    for (const u of ['a1', 'a2', 'a3', 'a4', 'a5']) { say(bid, u, '@victim hi'); say(bid, u, '@victim again'); }
    const [hit, ...rest] = mentionTargets(bid, 5);
    assert.equal(rest.length, 0);
    assert.equal(hit.target, 'victim');
    assert.equal(hit.senders.length, 5);
});

test('commands, bots and the streamer as target do not count', () => {
    const bid = 'noise';
    for (const u of ['a1', 'a2', 'a3', 'a4', 'a5']) {
        say(bid, u, '!slap @victim');
        say(bid, u, '@wolfzgangz hello');
        say(bid, u, '@streamelements thanks');
    }
    assert.deepEqual(mentionTargets(bid, 1), []);
});

test('mentions older than 5 minutes drop out', () => {
    const bid = 'old';
    for (const u of ['a1', 'a2', 'a3', 'a4', 'a5']) say(bid, u, '@victim hi');
    assert.deepEqual(mentionTargets(bid, 5, Date.now() + 6 * 60 * 1000), []);
});
