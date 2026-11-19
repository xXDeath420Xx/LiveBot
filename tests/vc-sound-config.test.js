import test from "node:test";
import assert from "node:assert/strict";
import { volumePercent, parseDropTimes, parseIdList } from "../core/vc-sound-manager.js";
import { FEATURE_SPECS } from "../core/feature-config-spec.js";

// The VC sound drops page (generated from core/feature-config-spec.js) and /admin vcsounds write the
// same vc_sound_config row; the scheduler must read what either wrote.

test("volume: the page and command save a percentage, older rows a fraction", () => {
    assert.equal(volumePercent(50), 50);
    assert.equal(volumePercent(100), 100);
    assert.equal(volumePercent(1), 1);
    assert.equal(volumePercent(0.5), 50);
    assert.equal(volumePercent(0.05), 5);
    assert.equal(volumePercent(null), 50);
    assert.equal(volumePercent(5000), 100);
});

test("drop times: a JSON array from the command or the text typed on the page", () => {
    assert.deepEqual(parseDropTimes("[\"12:00\",\"17:00\"]"), ["12:00", "17:00"]);
    assert.deepEqual(parseDropTimes("14:00, 20:30"), ["14:00", "20:30"]);
    assert.deepEqual(parseDropTimes("9:05 25:00 nope"), ["09:05"]);
    assert.deepEqual(parseDropTimes(null), []);
});

test("channel lists: JSON array or comma-separated", () => {
    assert.deepEqual(parseIdList("[\"123456789012345678\"]"), ["123456789012345678"]);
    assert.deepEqual(parseIdList("123456789012345678, 223456789012345678"), ["123456789012345678", "223456789012345678"]);
    assert.deepEqual(parseIdList(""), []);
});

test("the page offers the scheduler modes and the command limits", () => {
    const f = Object.fromEntries(FEATURE_SPECS["vc-sounds"].fields.map((x) => [x.key, x]));
    assert.deepEqual(f.mode.options.map((o) => o.value), ["random", "scheduled", "both"]);
    assert.equal(f.mode.default, "random");
    assert.equal(f.min_interval_minutes.min, 5);
    assert.equal(f.max_interval_minutes.min, 10);
    assert.equal(f.min_users_in_vc.max, 50);
    assert.equal(f.min_users_in_vc.default, 1);
});
