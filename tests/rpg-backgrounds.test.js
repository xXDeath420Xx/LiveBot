import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * H-649: every background /docs/rpg lists must give its two skill proficiencies, whichever way the
 * player types the name. The lookup used to turn spaces into underscores ('far_traveler') while the
 * table is keyed with spaces ('far traveler'), so the four two-word backgrounds gave nothing, and
 * Haunted One's entry was the literal ['choice', 'choice'].
 */
const { default: RPGCharacterManager, backgroundKey } = await import('../core/rpg-character-manager.js');

const LISTED = ['Acolyte', 'Charlatan', 'Criminal', 'Entertainer', 'Far Traveler', 'Folk Hero', 'Guild Artisan',
    'Haunted One', 'Hermit', 'Noble', 'Outlander', 'Sage', 'Sailor', 'Soldier', 'Urchin'];

const SKILLS = new Set(['acrobatics', 'animal handling', 'arcana', 'athletics', 'deception', 'history', 'insight',
    'intimidation', 'investigation', 'medicine', 'nature', 'perception', 'performance', 'persuasion', 'religion',
    'sleight of hand', 'stealth', 'survival']);

const manager = new RPGCharacterManager();

test('every listed background gives two real skills, typed as written', () => {
    for (const name of LISTED) {
        const bg = manager.getBackground(name);
        assert.ok(bg, `${name}: not found`);
        assert.equal(bg.skills.length, 2, `${name}: two skills`);
        for (const s of bg.skills) assert.ok(SKILLS.has(s), `${name}: "${s}" is not a skill`);
    }
});

test('underscores, hyphens, case and extra spaces resolve to the same background', () => {
    for (const typed of ['far_traveler', 'Far-Traveler', '  FAR   traveler ', 'far traveler']) {
        assert.deepEqual(manager.getBackground(typed)?.skills, ['insight', 'perception'], typed);
    }
    assert.deepEqual(manager.getBackground('folk_hero')?.skills, ['animal handling', 'survival']);
    assert.deepEqual(manager.getBackground('guild artisan')?.skills, ['insight', 'persuasion']);
    assert.equal(backgroundKey('Haunted_One'), 'haunted one');
});

test('Haunted One gets a pair from its own list, and an unknown background gives nothing', () => {
    const haunted = manager.getBackground('Haunted One');
    for (const s of haunted.skills) assert.ok(haunted.skillChoices.includes(s), s);
    assert.equal(manager.getBackground('Rogue'), null);
    assert.equal(manager.getBackground(''), null);
});
