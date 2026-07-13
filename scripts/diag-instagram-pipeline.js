#!/usr/bin/env node
/**
 * Diagnostic smoke test for the Instagram pipeline fixes.
 *
 * Verifies:
 *   1. stream-url-parser correctly rejects /p/ as a handle.
 *   2. stream-url-parser captures a real handle from a profile URL.
 *   3. stream-url-parser extracts the handle (not "stories") from a stories URL.
 *   4. (Optional) igBusinessDiscovery is wired and returns a result for a known
 *      Business account when META_ACCESS_TOKEN + META_INSTAGRAM_ACCOUNT_ID are set.
 *
 * Run: node scripts/diag-instagram-pipeline.js
 */

import { parseStreamUrl } from '../utils/stream-url-parser.js';

let failures = 0;
function assert(cond, label, detail) {
    if (cond) {
        console.log(`  ✓ ${label}`);
    } else {
        console.log(`  ✗ ${label}`);
        if (detail !== undefined) console.log(`    detail: ${JSON.stringify(detail)}`);
        failures++;
    }
}

console.log('1. URL parser — post link should NOT yield handle "p"');
{
    const r = parseStreamUrl('https://www.instagram.com/p/ABC123/');
    assert(
        !(r && r.platform === 'instagram' && r.username === 'p'),
        'instagram.com/p/ABC123/ does not extract "p" as handle',
        r
    );
}

console.log('2. URL parser — profile link extracts the handle');
{
    const r = parseStreamUrl('https://www.instagram.com/realhandle/');
    assert(
        r && r.platform === 'instagram' && r.username === 'realhandle',
        'instagram.com/realhandle/ -> { platform: instagram, username: realhandle }',
        r
    );
}

console.log('3. URL parser — stories link extracts the user handle, not "stories"');
{
    const r = parseStreamUrl('https://www.instagram.com/stories/somehandle/1234567890/');
    assert(
        r && r.platform === 'instagram' && r.username === 'somehandle',
        'instagram.com/stories/somehandle/<id>/ -> { username: somehandle }',
        r
    );
}

console.log('4. URL parser — reel link should NOT yield handle "reel"');
{
    const r = parseStreamUrl('https://www.instagram.com/reel/XYZ789/');
    assert(
        !(r && r.platform === 'instagram' && r.username === 'reel'),
        'instagram.com/reel/XYZ789/ does not extract "reel" as handle',
        r
    );
}

console.log('5. (optional) igBusinessDiscovery wiring');
if (!process.env.META_ACCESS_TOKEN || !process.env.META_INSTAGRAM_ACCOUNT_ID) {
    console.log('  ⊘ skipped — META_ACCESS_TOKEN / META_INSTAGRAM_ACCOUNT_ID not configured');
} else {
    try {
        const { igBusinessDiscovery } = await import('../utils/platforms/meta.js');
        const biz = await igBusinessDiscovery('instagram', { mediaLimit: 1 });
        assert(biz && biz.username, 'igBusinessDiscovery(instagram) returned a profile', biz ? { username: biz.username, id: biz.id } : null);
    } catch (err) {
        console.log(`  ✗ igBusinessDiscovery threw: ${err.message}`);
        failures++;
    }
}

if (failures > 0) {
    console.log(`\n${failures} assertion(s) failed.`);
    process.exit(1);
} else {
    console.log('\nAll assertions passed.');
    process.exit(0);
}
