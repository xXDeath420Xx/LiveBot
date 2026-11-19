// Custom-trained Piper voices (bear): the "certifried" block in a voice's .onnx.json sets its pace for
// the chat reader's long-lived workers (utils/piper-worker.js voiceTuning) and its gender in the voice
// list; stock voices keep the worker DEFAULTS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { voiceTuning, DEFAULTS } from '../utils/piper-worker.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function model(config) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-tuning-'));
    const file = path.join(dir, 'en_US-test-medium.onnx');
    if (config !== undefined) fs.writeFileSync(`${file}.json`, typeof config === 'string' ? config : JSON.stringify(config));
    return file;
}

test('tuning: a certifried block replaces the defaults it names', () => {
    const t = voiceTuning(model({ inference: { length_scale: 1 }, certifried: { lengthScale: 1.15, noiseScale: 0.667, noiseW: 0.8, gender: 'male' } }));
    assert.deepEqual(t, { lengthScale: 1.15, noiseScale: 0.667, noiseW: 0.8 });
    assert.equal({ ...DEFAULTS, ...t }.sentenceSilence, DEFAULTS.sentenceSilence);
});

test('tuning: stock voices, missing or broken configs get nothing (worker DEFAULTS apply)', () => {
    assert.deepEqual(voiceTuning(model({ inference: { length_scale: 1 } })), {});
    assert.deepEqual(voiceTuning(model()), {});
    assert.deepEqual(voiceTuning(model('{not json')), {});
});

test('tuning: out-of-range or non-numeric values are dropped', () => {
    const t = voiceTuning(model({ certifried: { lengthScale: 0, noiseScale: -1, noiseW: 'x', sentenceSilence: 9 } }));
    assert.deepEqual(t, {});
    assert.deepEqual(voiceTuning(model({ certifried: { noiseScale: 0, sentenceSilence: '0.5' } })), { noiseScale: 0, sentenceSilence: 0.5 });
});

const bearPath = path.join(root, 'piper_models/en_US/bear/medium/en_US-bear-medium.onnx');
test('bear: installed voice reads at his measured pace and lists as male', { skip: !fs.existsSync(bearPath) && 'bear model not installed' }, () => {
    assert.equal(voiceTuning(bearPath).lengthScale, 1.15);
    const voices = require('../utils/piper-tts.cjs').getPiperInstalledVoices();
    assert.equal(voices.bear?.gender, 'male');
    assert.equal(voices.bear?.quality, 'medium');
});
