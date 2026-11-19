import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * /community starboard setup capped the threshold at 50 while the Starboard page and core/starboard-manager.js
 * allow 1 to 100. The command now allows 100 as well.
 */
const { MAX_THRESHOLD } = await import('../core/starboard-manager.js');
const community = (await import('../commands/admin/community.js')).default;

test('the setup command allows the same range as the page', () => {
    assert.equal(MAX_THRESHOLD, 100);
    const json = community.data.toJSON();
    const starboard = json.options.find((o) => o.name === 'starboard');
    const setup = starboard.options.find((o) => o.name === 'setup');
    const threshold = setup.options.find((o) => o.name === 'threshold');
    assert.equal(threshold.min_value, 1);
    assert.equal(threshold.max_value, MAX_THRESHOLD);
});
