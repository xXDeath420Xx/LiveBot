import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * These guard the promise the QOTD system makes: nothing repeats, and nothing comes back
 * reworded, inside the rolling window. That promise is enforced at post time on
 * variant_group — which only works if the library data itself is clean. A duplicate slug
 * or an unnoticed rewording added months from now would quietly reintroduce exactly the
 * problem this system exists to fix, so it gets caught here instead.
 */

const libraryDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'qotd-library');

const files = fs.readdirSync(libraryDir).filter(f => f.endsWith('.json'));
const themes = files.map(f => JSON.parse(fs.readFileSync(path.join(libraryDir, f), 'utf8')));
const questions = themes.flatMap(t => t.questions.map(q => ({ ...q, theme: t.theme, file: t.theme + '.json' })));
const groupOf = q => q.group || q.slug;

test('every theme file has the expected shape', () => {
    assert.ok(files.length >= 10, `expected a broad set of themes, found ${files.length}`);
    for (const t of themes) {
        assert.match(t.theme, /^[a-z][a-z-]*$/, `theme slug must be kebab-case: ${t.theme}`);
        assert.ok(t.label, `${t.theme} needs a label`);
        assert.ok(Array.isArray(t.questions) && t.questions.length >= 20,
            `${t.theme} has too few questions to rotate meaningfully`);
    }
});

test('slugs are unique across the whole library', () => {
    const seen = new Map();
    for (const q of questions) {
        assert.equal(seen.has(q.slug), false,
            `duplicate slug ${q.slug} in ${q.file} and ${seen.get(q.slug)}`);
        seen.set(q.slug, q.file);
    }
});

test('every question has usable text', () => {
    for (const q of questions) {
        assert.match(q.slug, /^[a-z0-9][a-z0-9-]*$/, `bad slug: ${q.slug}`);
        assert.ok(q.text.length >= 20, `${q.slug} is too short to prompt a real answer`);
        assert.ok(q.text.length <= 400, `${q.slug} is too long for an embed description`);
        assert.ok(/[?.!]$/.test(q.text.trim()), `${q.slug} should end in punctuation`);
    }
});

test('the library is large enough to outrun a 90-day window across several servers', () => {
    const groups = new Set(questions.map(groupOf));
    // Distinct groups are the real runway — rewordings share a slot.
    assert.ok(groups.size >= 365,
        `only ${groups.size} distinct questions; a year of daily posts needs at least 365`);
});

test('no two questions in different groups are near-duplicates of each other', () => {
    const STOP = new Set(('what whats which who whom whose when where why how the a an and or of to in on for ' +
        'you your yours do did does would could should is are was were be been that this these those it its ' +
        'if not no with about at from one ever have has had can most best worst thing things').split(' '));
    const tokens = q => new Set(
        q.text.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/)
            .filter(w => w.length > 2 && !STOP.has(w))
    );

    const prepared = questions.map(q => ({ ...q, toks: tokens(q) }));
    const offenders = [];
    for (let i = 0; i < prepared.length; i++) {
        for (let j = i + 1; j < prepared.length; j++) {
            const a = prepared[i], b = prepared[j];
            if (!a.toks.size || !b.toks.size) continue;
            if (groupOf(a) === groupOf(b)) continue;   // deliberately clustered, fine
            const shared = [...a.toks].filter(w => b.toks.has(w)).length;
            const jaccard = shared / (a.toks.size + b.toks.size - shared);
            if (jaccard >= 0.5) offenders.push(`${a.slug} ~ ${b.slug} (${jaccard.toFixed(2)})`);
        }
    }
    assert.deepEqual(offenders, [],
        'near-duplicates must share a variant group or be reworded:\n' + offenders.join('\n'));
});
