import test from 'node:test';
import assert from 'node:assert/strict';
import {
    IDS, NOTE_PREFIX, isInternalNote, channelNameFor, truncate, parseCustomId, serialiseAttachments,
    parseAttachments, humanDuration, formatTranscript, speakerLabel, chunkText, isSnowflake,
} from '../core/modmail-format.js';

test('staff notes start with // (leading spaces allowed); everything else is a reply', () => {
    assert.equal(NOTE_PREFIX, '//');
    assert.equal(isInternalNote('// check their history first'), true);
    assert.equal(isInternalNote('   //note'), true);
    assert.equal(isInternalNote('see https://example.com'), false);
    assert.equal(isInternalNote('a // b'), false);
    assert.equal(isInternalNote(''), false);
    assert.equal(isInternalNote(null), false);
});

test('channel names are Discord-safe and never empty', () => {
    assert.equal(channelNameFor('Cool_User.99'), 'modmail-cool_user-99');
    assert.equal(channelNameFor('ÆØÅ émoji 🎉'), 'modmail-a-emoji');
    assert.equal(channelNameFor('🎉🎉'), 'modmail-member');
    assert.equal(channelNameFor(''), 'modmail-member');
    assert.ok(channelNameFor('x'.repeat(300)).length <= 100);
});

test('custom ids stay under Discord\'s 100-character limit with real snowflakes', () => {
    const snow = '1475352754682597468';
    for (const id of [
        `${IDS.open}${snow}:${snow}`, `${IDS.pick}${snow}`, `${IDS.route}${snow}`,
        `${IDS.close}2147483647`, `${IDS.block}2147483647`, `${IDS.closeModal}2147483647`, IDS.cancel,
    ]) assert.ok(id.length <= 100, id);
    assert.deepEqual(parseCustomId(`${IDS.open}${snow}:123`, IDS.open), [snow, '123']);
    assert.equal(parseCustomId('other:1', IDS.open), null);
    assert.deepEqual(parseCustomId(IDS.cancel, IDS.cancel), []);
});

test('no registered prefix shadows another (the registry matches by prefix)', () => {
    const buttons = [IDS.open, IDS.cancel, IDS.close, IDS.block];
    for (const a of buttons) for (const b of buttons) {
        if (a !== b) assert.ok(!b.startsWith(a), `${a} would swallow ${b}`);
    }
});

test('snowflake check', () => {
    assert.equal(isSnowflake('1475352754682597468'), true);
    assert.equal(isSnowflake('12'), false);
    assert.equal(isSnowflake('abc1475352754682597'), false);
    assert.equal(isSnowflake(1475352754682597468), false, 'numbers lose precision; ids must be strings');
});

test('attachments round-trip and tolerate junk', () => {
    const raw = serialiseAttachments([{ name: 'a.png', url: 'https://cdn/a.png', size: 10, contentType: 'image/png' }, { name: 'x' }]);
    assert.deepEqual(parseAttachments(raw), [{ name: 'a.png', url: 'https://cdn/a.png', size: 10, contentType: 'image/png' }]);
    assert.equal(serialiseAttachments([]), null);
    assert.deepEqual(parseAttachments('nope'), []);
    assert.deepEqual(parseAttachments(null), []);
});

test('durations for the dashboard', () => {
    assert.equal(humanDuration(42), '42s');
    assert.equal(humanDuration(60), '1m');
    assert.equal(humanDuration(3600), '1h');
    assert.equal(humanDuration(5400), '1h 30m');
    assert.equal(humanDuration(90000), '1d 1h');
    assert.equal(humanDuration(null), '0s');
});

test('truncate and chunking', () => {
    assert.equal(truncate('hello', 10), 'hello');
    assert.equal(truncate('hello world', 6), 'hello…');
    assert.equal(truncate('hello world', 6).length, 6);
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkText(text, 500);
    assert.ok(chunks.every(c => c.length <= 500));
    assert.equal(chunks.join('\n'), text);
});

test('transcript labels every speaker and keeps notes visibly separate', () => {
    const names = { u1: 'member#0001', s1: 'mod#0002' };
    const nameOf = id => names[id] || null;
    const thread = {
        id: 7, guild_id: 'g', user_id: 'u1', status: 'closed', created_at: '2026-10-05T10:00:00Z',
        closed_at: '2026-10-05T11:00:00Z', closed_by: 's1', close_reason: 'resolved',
    };
    const messages = [
        { author_id: 'u1', author_type: 'user', message_content: 'help\nplease', attachments: serialiseAttachments([{ name: 'p.png', url: 'https://cdn/p.png' }]), timestamp: '2026-10-05T10:00:01Z' },
        { author_id: 's1', author_type: 'staff', message_content: 'on it', is_anonymous: 1, timestamp: '2026-10-05T10:01:00Z' },
        { author_id: 's1', author_type: 'staff', message_content: '// alt account?', is_internal: 1, timestamp: '2026-10-05T10:02:00Z' },
        { author_id: 'bot', author_type: 'system', message_content: 'Conversation closed', timestamp: '2026-10-05T11:00:00Z' },
    ];
    const text = formatTranscript(thread, messages, { guildName: 'Test Server', nameOf });
    assert.match(text, /^Modmail thread #7 — Test Server \(g\)/);
    assert.match(text, /Member: member#0001 \(u1\)/);
    assert.match(text, /Closed: 2026-10-05 11:00:00 UTC by mod#0002 \(s1\)/);
    assert.match(text, /Reason: resolved/);
    assert.match(text, /MEMBER member#0001: help\n {4}please/);
    assert.match(text, /attachment: p\.png https:\/\/cdn\/p\.png/);
    assert.match(text, /STAFF mod#0002 \(sent anonymously\): on it/);
    assert.match(text, /NOTE mod#0002: \/\/ alt account\?/);
    assert.match(text, /SYSTEM: Conversation closed/);
    assert.equal(speakerLabel({ author_id: 'zz', author_type: 'user' }, () => null), 'MEMBER zz');
    assert.match(formatTranscript({ ...thread, status: 'open' }, []), /Status: open[\s\S]*\(no messages\)/);
});
