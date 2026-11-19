import test from 'node:test';
import assert from 'node:assert/strict';
import {
    entryStageFor,
    displayStageKey,
    parseEnvironment,
    parseFeeding,
    parseHeight,
    parseWeightGrams
} from '../core/grow-journal-helpers.js';

test('entryStageFor: journal stages map onto the journal_entries.stage ENUM', () => {
    assert.equal(entryStageFor('vegetative'), 'veg');
    assert.equal(entryStageFor('flowering'), 'flower');
    assert.equal(entryStageFor('complete'), 'cure');
    assert.equal(entryStageFor('germination'), 'germination');
    assert.equal(entryStageFor(undefined), 'seedling');
});

test('displayStageKey: entry stages resolve back to display keys', () => {
    assert.equal(displayStageKey('veg'), 'vegetative');
    assert.equal(displayStageKey('flower'), 'flowering');
    assert.equal(displayStageKey('cure'), 'cure');
});

test('parseEnvironment: the placeholder example', () => {
    assert.deepEqual(parseEnvironment('Temp: 75-80F, RH: 55-60%, VPD: 1.2'), {
        tempHigh: 80, tempLow: 75, humidityHigh: 60, humidityLow: 55, vpd: 1.2
    });
});

test('parseEnvironment: single values, reversed ranges, out-of-range dropped', () => {
    assert.deepEqual(parseEnvironment('temp 24c humidity 65%'), {
        tempHigh: 24, tempLow: 24, humidityHigh: 65, humidityLow: 65, vpd: null
    });
    const r = parseEnvironment('Temp 80-75, RH 300, vpd 55');
    assert.equal(r.tempLow, 75);
    assert.equal(r.tempHigh, 80);
    assert.equal(r.humidityHigh, null);
    assert.equal(r.vpd, null);
    assert.deepEqual(parseEnvironment(null), { tempHigh: null, tempLow: null, humidityHigh: null, humidityLow: null, vpd: null });
});

test('parseFeeding: pH, EC converted to ppm (500 scale), PPM used as-is', () => {
    assert.deepEqual(parseFeeding('1 gallon, pH 6.2, CalMag 2ml/gal'), { phIn: 6.2, ecPpm: null, watered: 1 });
    assert.equal(parseFeeding('EC 1.6').ecPpm, 800);
    assert.equal(parseFeeding('EC: 1600').ecPpm, 800); // µS/cm
    assert.equal(parseFeeding('800 ppm, ph 5.9').ecPpm, 800);
    assert.equal(parseFeeding('ppm: 650').ecPpm, 650);
    assert.equal(parseFeeding('pH 65').phIn, null); // would overflow decimal(3,1) / not a pH
    assert.deepEqual(parseFeeding(''), { phIn: null, ecPpm: null, watered: 0 });
});

test('parseHeight: number with optional cm', () => {
    assert.equal(parseHeight('45'), 45);
    assert.equal(parseHeight('45.5 cm'), 45.5);
    assert.equal(parseHeight('tall'), null);
    assert.equal(parseHeight(''), null);
});

test('parseWeightGrams: units convert to grams; junk is rejected', () => {
    assert.deepEqual(parseWeightGrams('500g'), { ok: true, grams: 500 });
    assert.deepEqual(parseWeightGrams('500 grams'), { ok: true, grams: 500 });
    assert.deepEqual(parseWeightGrams('100'), { ok: true, grams: 100 });
    assert.deepEqual(parseWeightGrams('1.2kg'), { ok: true, grams: 1200 });
    assert.deepEqual(parseWeightGrams('3 oz'), { ok: true, grams: 85.05 });
    assert.deepEqual(parseWeightGrams('1 lb'), { ok: true, grams: 453.59 });
    assert.deepEqual(parseWeightGrams(null), { ok: true, grams: null });
    assert.equal(parseWeightGrams('a lot').ok, false);
    assert.equal(parseWeightGrams('0g').ok, false);
});
