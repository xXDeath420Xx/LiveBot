import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * Voice recording mixer (core/voice-recording-mixer.js). What has to be right:
 *   - speakers are summed onto one mono timeline, in order, with silence where nobody spoke
 *   - loud overlaps clip instead of wrapping around
 *   - a speaker's packets follow each other back to back; a pause re-anchors them to real time
 *   - only the jitter window is held in memory; late audio is dropped, never written out of order
 *   - the length cap always yields a file under the server's upload limit
 */
const m = await import('../core/voice-recording-mixer.js');

/** n samples of constant stereo PCM (L = R = value). */
function stereo(n, value) {
    const buf = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) { buf.writeInt16LE(value, i * 4); buf.writeInt16LE(value, i * 4 + 2); }
    return buf;
}

function collect() {
    const chunks = [];
    return { write: b => chunks.push(Buffer.from(b)), samples: () => { const all = Buffer.concat(chunks); return Array.from({ length: all.length / 2 }, (_, i) => all.readInt16LE(i * 2)); } };
}

test('two speakers are summed; gaps are silence; order is kept', () => {
    const out = collect();
    const mix = new m.TimelineMixer({ write: out.write, lagMs: 20 });
    mix.addStereo(0, stereo(960, 1000));           // frame 0: A
    mix.addStereo(480, stereo(960, 500));           // frames 0-1: B overlapping half of A
    mix.addStereo(3 * 960, stereo(960, -200));      // frame 3: A again
    mix.finish(5 * 960);
    const s = out.samples();
    assert.equal(s.length, 5 * 960);
    assert.equal(s[0], 1000);
    assert.equal(s[479], 1000);
    assert.equal(s[480], 1500);
    assert.equal(s[959], 1500);
    assert.equal(s[960], 500);
    assert.equal(s[1439], 500);
    assert.equal(s[1440], 0);
    assert.equal(s[2 * 960], 0);
    assert.equal(s[3 * 960], -200);
    assert.equal(s[4 * 960], 0);
});

test('stereo is downmixed and loud overlaps clip', () => {
    const out = collect();
    const mix = new m.TimelineMixer({ write: out.write });
    const lr = Buffer.alloc(8);
    lr.writeInt16LE(1000, 0); lr.writeInt16LE(3000, 2); lr.writeInt16LE(-1000, 4); lr.writeInt16LE(-3000, 6);
    mix.addStereo(0, lr);
    mix.addStereo(10, stereo(2, 30000));
    mix.addStereo(10, stereo(2, 30000));
    mix.addStereo(12, stereo(1, -30000));
    mix.addStereo(12, stereo(1, -30000));
    mix.finish(960);
    const s = out.samples();
    assert.equal(s[0], 2000);
    assert.equal(s[1], -2000);
    assert.equal(s[10], 32767);
    assert.equal(s[12], -32768);
});

test('real-time flushing holds only the jitter window and drops late audio', () => {
    const out = collect();
    const mix = new m.TimelineMixer({ write: out.write, lagMs: 1000 });
    mix.addStereo(0, stereo(960, 7));
    assert.equal(mix.flushRealtime(30 * 960), 0);                  // still inside the 1 s window
    assert.equal(mix.flushRealtime(60 * 960), 10);                 // frames 0..9 written
    assert.equal(mix.frames.size, 0);
    mix.addStereo(5 * 960, stereo(960, 9));                        // too late: frame 5 is out
    assert.equal(mix.droppedLate, 960);
    mix.finish(12 * 960);
    const s = out.samples();
    assert.equal(s.length, 12 * 960);
    assert.equal(s[0], 7);
    assert.equal(s[5 * 960], 0);
    assert.equal(mix.writtenMs, 240);
});

test('speaker clock: back to back within a burst, re-anchored after a pause, clamped when ahead', () => {
    const c = new m.SpeakerClock({ maxBehindMs: 200, maxAheadMs: 500 });
    assert.equal(c.place(48_000, 960), 48_000);                    // first packet: now
    assert.equal(c.place(48_000 + 900, 960), 48_960);              // jitter: still back to back
    assert.equal(c.place(48_000 + 2100, 960), 49_920);             // early arrival: back to back
    assert.equal(c.place(48_000 + 48_000, 960), 96_000);           // after a 1 s pause: now
    const d = new m.SpeakerClock({ maxBehindMs: 200, maxAheadMs: 500 });
    const placed = Array.from({ length: 100 }, () => d.place(0, 960));   // a pile-up of 100 packets at once
    assert.ok(placed.every(p => p <= 24_000), 'never placed more than 500 ms ahead of real time');
    assert.equal(placed[26], 0);                                   // the 27th re-anchors to now
});

test('length cap fits the upload limit', () => {
    assert.equal(m.uploadLimitBytes(0), 10 * 1024 * 1024);
    assert.equal(m.uploadLimitBytes(2), 50 * 1024 * 1024);
    assert.equal(m.uploadLimitBytes(3), 100 * 1024 * 1024);
    for (const tier of [0, 1, 2, 3]) {
        const minutes = m.maxMinutesForLimit(m.uploadLimitBytes(tier));
        const worstBytes = minutes * 60 * (m.OPUS_BITRATE / 8) * 1.05;
        assert.ok(worstBytes < m.uploadLimitBytes(tier), `tier ${tier}: ${minutes} min`);
    }
    assert.equal(m.effectiveMaxMinutes({}), 30);
    assert.equal(m.effectiveMaxMinutes({ requested: 10 }), 10);
    assert.equal(m.effectiveMaxMinutes({ requested: 90, configured: 60 }), m.maxMinutesForLimit(m.uploadLimitBytes(0)));
    assert.equal(m.effectiveMaxMinutes({ requested: 90, configured: 60, premiumTier: 2 }), 60);
    assert.equal(m.effectiveMaxMinutes({ requested: 500, configured: 500, premiumTier: 3 }), m.HARD_MAX_MINUTES);
    assert.equal(m.effectiveMaxMinutes({ requested: 0, configured: 0 }), 30);
});

test('helpers', () => {
    assert.deepEqual(m.parseRoleList('["123456789012345678", "x"]'), ['123456789012345678']);
    assert.deepEqual(m.parseRoleList('123456789012345678, 223456789012345678'), ['123456789012345678', '223456789012345678']);
    assert.deepEqual(m.parseRoleList(null), []);
    assert.equal(m.recordingFileName('General Chat 🎤', Date.UTC(2026, 9, 5, 13, 7)), 'recording-general-chat-2026-10-05-13-07.ogg');
    assert.equal(m.recordingNickname('CertiFried Utility Bot Deluxe'), '🔴 REC · CertiFried Utility Bot'.slice(0, 32));
    assert.ok(m.recordingNickname('x'.repeat(40)).length <= 32);
    assert.equal(m.recordingNickname(m.recordingNickname('Bot')), '🔴 REC · Bot');
    assert.equal(m.formatDuration(3_725_000), '1h 2m 5s');
    assert.equal(m.formatDuration(65_000), '1m 5s');
    assert.match(m.consentNotice({ starter: 'Alice', channel: '#vc', maxMinutes: 30, output: '#out' }), /RECORDED.*leave the channel now.*opt-out/s);
});
