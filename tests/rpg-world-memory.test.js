import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * The AI DM's world-memory tags: {{QUEST}} parsing must be forgiving of how the model writes it,
 * place names must map onto the real zone ids where they match (so /rpg shop and /rpg combat keep
 * working), and the quest render must never read as "quest complete" — the natural-language
 * GAME_OVER fallback ends the whole session on that phrase.
 */
const {
    parseQuestTag, normalizeQuestAction, renderQuestEvent, inferLocationType, resolveZoneId,
    isRealLocation, addToJsonList, parseJsonList, appendQuestNote, lastQuestNote, buildWorldPromptSection,
} = await import('../core/rpg-world-tags.js');

test('quest tag: name:ACTION:detail', () => {
    assert.deepEqual(parseQuestTag('The Missing Miller:START:Find the son: he went north'),
        { name: 'The Missing Miller', action: 'start', detail: 'Find the son: he went north' });
    assert.deepEqual(parseQuestTag('The Missing Miller:complete'), { name: 'The Missing Miller', action: 'complete', detail: null });
    assert.deepEqual(parseQuestTag(' Rats in the Cellar : Progress : killed 3 rats '),
        { name: 'Rats in the Cellar', action: 'update', detail: 'killed 3 rats' });
});

test('quest tag: action-first and bare-name forms', () => {
    assert.deepEqual(parseQuestTag('FAIL:Escort the Caravan'), { name: 'Escort the Caravan', action: 'fail', detail: null });
    assert.deepEqual(parseQuestTag('Slay the Wyrm'), { name: 'Slay the Wyrm', action: 'start', detail: null });
    assert.deepEqual(parseQuestTag('Slay the Wyrm:A dragon terrorises the valley'),
        { name: 'Slay the Wyrm', action: 'start', detail: 'A dragon terrorises the valley' });
});

test('quest tag: rejects empty / placeholder names, caps length', () => {
    assert.equal(parseQuestTag(''), null);
    assert.equal(parseQuestTag('???:START'), null);
    assert.equal(parseQuestTag('x'.repeat(400)).name.length, 255);
});

test('quest actions normalise synonyms', () => {
    assert.equal(normalizeQuestAction('Completed'), 'complete');
    assert.equal(normalizeQuestAction('accepted'), 'start');
    assert.equal(normalizeQuestAction('abandoned'), 'abandon');
    assert.equal(normalizeQuestAction('banana'), null);
});

test('quest render never says "quest complete/failed"', () => {
    const gameOverPhrase = /quest\s+(?:has\s+)?(?:ended|complete|failed)/i;
    for (const action of ['start', 'update', 'complete', 'fail', 'abandon']) {
        const text = renderQuestEvent({ name: 'Find the Relic', action, detail: 'detail' });
        assert.equal(gameOverPhrase.test(text), false, text);
    }
});

test('location types', () => {
    assert.equal(inferLocationType('The Dark Cavern'), 'dungeon');
    assert.equal(inferLocationType('Crypt'), 'dungeon');
    assert.equal(inferLocationType('Whispering Woods'), 'wilderness');
    assert.equal(inferLocationType('The Prancing Pony Tavern'), 'building');
    assert.equal(inferLocationType('Throne Room'), 'room');
    assert.equal(inferLocationType('Neverwinter City'), 'city');
    assert.equal(inferLocationType('Oakhaven'), 'town');
    assert.equal(inferLocationType('Ancient Ruins'), 'landmark');
});

test('zone resolution maps names onto static zone ids, else keeps free text (<=50 chars)', () => {
    const zones = [
        { zone_id: 'forest', zone_name: 'Whispering Forest' },
        { zone_id: 'dragon_lair', zone_name: "Dragon's Lair" },
        { zone_id: 'town', zone_name: 'Town Square' },
    ];
    assert.equal(resolveZoneId('The Whispering Forest', zones), 'forest');
    assert.equal(resolveZoneId('town', zones), 'town');
    assert.equal(resolveZoneId('Dragon Lair', zones), 'dragon_lair');
    assert.equal(resolveZoneId('Oakhaven', zones), 'Oakhaven');
    assert.equal(resolveZoneId('A'.repeat(80), zones).length, 50);
    assert.equal(resolveZoneId('', zones), null);
});

test('placeholder locations are not real places', () => {
    assert.equal(isRealLocation('Unknown Location'), false);
    assert.equal(isRealLocation('???'), false);
    assert.equal(isRealLocation(''), false);
    assert.equal(isRealLocation('Crypt'), true);
});

test('JSON list helpers', () => {
    assert.equal(addToJsonList(null, 'Crypt'), '["Crypt"]');
    assert.equal(addToJsonList('["Crypt"]', 'crypt'), '["Crypt"]');
    assert.equal(addToJsonList('not json', 'Inn'), '["Inn"]');
    assert.deepEqual(parseJsonList('{"a":1}'), []);
});

test('quest notes keep the newest lines and skip repeats', () => {
    let notes = null;
    for (let i = 0; i < 15; i++) notes = appendQuestNote(notes, `step ${i}`);
    const lines = notes.split('\n');
    assert.equal(lines.length, 10);
    assert.equal(lines[0], 'step 5');
    assert.equal(appendQuestNote('a\nb', 'b'), 'a\nb');
    assert.equal(lastQuestNote(notes), 'step 14');
    assert.equal(appendQuestNote(null, ''), null);
});

test('world prompt section lists active quests, NPCs and places, bounded', () => {
    const world = {
        quests: [
            { quest_name: 'Main Quest', quest_type: 'main', status: 'active', description: 'Save the town', lastNote: 'Met the mayor' },
            { quest_name: 'Old Quest', status: 'completed' },
        ],
        npcs: Array.from({ length: 30 }, (_, i) => ({ npc_name: `NPC ${i}`, description: 'a person', is_alive: i === 0 ? 0 : 1 })),
        locations: [{ location_name: 'Oakhaven' }],
        timeOfDay: 'night',
        weather: 'rain',
    };
    const s = buildWorldPromptSection(world);
    assert.match(s, /Main Quest \[main\]: Save the town \(latest: Met the mayor\)/);
    assert.match(s, /Old Quest \(completed\)/);
    assert.match(s, /NPC 0 — a person; DEAD/);
    assert.equal((s.match(/^- NPC /gm) || []).length, 15);
    assert.match(s, /time: night, weather: rain/);
    assert.equal(buildWorldPromptSection(null), '');
    assert.equal(buildWorldPromptSection({ quests: [], npcs: [], locations: [] }), '');
});
