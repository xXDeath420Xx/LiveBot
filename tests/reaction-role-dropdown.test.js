import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * H-663 reaction roles:
 *   - a dropdown pick could only add roles (Several roles mode) and the One-role "removed all"
 *     branch was unreachable, so members could not drop a role through the menu;
 *   - more than 25 roles made a sixth button row (Discord rejects it), and the panel refresh
 *     stopped at 21 buttons;
 *   - /manage roles add-role did not check how many roles the panel already had.
 */
const rr = await import('../core/reaction-role-manager.js');
const { default: pool } = await import('../utils/db.js');
const { default: ReactionRoleManager, chunkButtons, planSelectToggle, buildPanelMessage } = rr;

test('a pick toggles: roles the member lacks are added, roles they hold are removed', () => {
    const panelRoleIds = ['A', 'B', 'C'];
    assert.deepEqual(planSelectToggle({ panelMode: 'standard', panelRoleIds, heldRoleIds: ['A'], selected: ['A', 'B'] }),
        { add: ['B'], remove: ['A'] });
    assert.deepEqual(planSelectToggle({ panelMode: 'standard', panelRoleIds, heldRoleIds: [], selected: ['C'] }),
        { add: ['C'], remove: [] });
    // Not this panel's role: ignored.
    assert.deepEqual(planSelectToggle({ panelMode: 'standard', panelRoleIds, heldRoleIds: [], selected: ['Z'] }),
        { add: [], remove: [] });
});

test('one role at a time: switch, or drop the current role by picking it', () => {
    const panelRoleIds = ['A', 'B', 'C'];
    assert.deepEqual(planSelectToggle({ panelMode: 'unique', panelRoleIds, heldRoleIds: ['A'], selected: ['B'] }),
        { add: ['B'], remove: ['A'] });
    assert.deepEqual(planSelectToggle({ panelMode: 'unique', panelRoleIds, heldRoleIds: ['A'], selected: ['A'] }),
        { add: [], remove: ['A'] });
});

test('buttons: never more than five rows of five', () => {
    assert.deepEqual(chunkButtons([1, 2, 3, 4, 5, 6]).map(r => r.length), [5, 1]);
    assert.deepEqual(chunkButtons(Array.from({ length: 30 }, (_, i) => i)).map(r => r.length), [5, 5, 5, 5, 5]);

    const roles = Array.from({ length: 30 }, (_, i) => ({ roleId: String(1000 + i), label: `R${i}` }));
    const rows = new ReactionRoleManager({}).buildButtonComponents(roles).map(r => r.toJSON());
    assert.equal(rows.length, 5);
    assert.ok(rows.every(r => r.components.length === 5));
});

test('a refreshed 25-role button panel shows all 25 buttons', async () => {
    const panel = { panel_name: 'Roles', interaction_type: 'button' };
    const mappings = Array.from({ length: 25 }, (_, i) => ({ role_id: String(2000 + i), label: `R${i}` }));
    const { components } = await buildPanelMessage({ panel, mappings, guild: null });
    const json = components.map(c => c.toJSON());
    assert.equal(json.length, 5);
    assert.equal(json.flatMap(r => r.components).length, 25);
});

// ── The dropdown handler against stored panels ─────────────────────────────────────────────────
const GUILD = '100000000000000663';
const MSG = '600000000000000663';

async function storedPanel(t, { mode = 'standard', type = 'select_menu', roles = 3 } = {}) {
    const [p] = await pool.execute(
        `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, panel_mode, interaction_type)
         VALUES (?, '700000000000000663', ?, 'Test panel', ?, ?)`, [GUILD, MSG, mode, type]);
    for (let i = 0; i < roles; i++) {
        await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, min_level) VALUES (?, ?, ?)',
            [p.insertId, `R${i + 1}`, i === 2 ? 5 : null]);
    }
    t.after(async () => {
        await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [p.insertId]);
        await pool.execute('DELETE FROM reaction_role_panels WHERE id = ?', [p.insertId]);
    });
    return p.insertId;
}

function pick(values, held, level = 0) {
    const replies = [];
    const names = new Map([['R1', { name: 'Red' }], ['R2', { name: 'Blue' }], ['R3', { name: 'Gold' }]]);
    const interaction = {
        customId: 'rr_select', values,
        message: { id: MSG, components: [] },
        user: { id: 'U1', tag: 'tester' },
        member: {
            user: { id: 'U1', tag: 'tester' },
            roles: {
                cache: { has: id => held.has(id) },
                add: async ids => { for (const id of [].concat(ids)) held.add(id); },
                remove: async ids => { for (const id of [].concat(ids)) held.delete(id); },
            },
        },
        guild: { id: GUILD, roles: { cache: names } },
        client: { levelingManager: { getUserRank: async () => ({ level }) } },
        update: async (o) => { interaction.updated = o; },
        followUp: async (o) => { replies.push(o.content); },
    };
    return { interaction, replies };
}

test('dropdown: picking a held role removes it, picking a new one adds it, and the menu is reset', async (t) => {
    await storedPanel(t);
    const held = new Set(['R1']);
    const { interaction, replies } = pick(['R1', 'R2'], held);
    await new ReactionRoleManager({}).handleSelectMenuInteraction(interaction);
    assert.deepEqual([...held].sort(), ['R2']);
    assert.deepEqual(interaction.updated, { components: [] }, 'answered with the message\'s own components');
    assert.equal(replies[0], 'Added **Blue**.\nRemoved **Red**.');
});

test('dropdown: the level gate applies to adding, not to removing', async (t) => {
    await storedPanel(t);
    const held = new Set();
    const { interaction, replies } = pick(['R3'], held, 2);
    await new ReactionRoleManager({}).handleSelectMenuInteraction(interaction);
    assert.deepEqual([...held], []);
    assert.match(replies[0], /level 5/);
});

test('one role at a time: picking the current role drops it', async (t) => {
    await storedPanel(t, { mode: 'unique' });
    const held = new Set(['R2']);
    const { interaction, replies } = pick(['R2'], held);
    await new ReactionRoleManager({}).handleSelectMenuInteraction(interaction);
    assert.deepEqual([...held], []);
    assert.equal(replies[0], 'Removed **Blue**.');
});

test('/manage roles add-role refuses a role past the panel\'s capacity', async (t) => {
    await storedPanel(t, { type: 'reaction', roles: 20 });
    const res = await new ReactionRoleManager({ guilds: { cache: new Map() } })
        .addRoleToPanel(MSG, '800000000000000663', '👍', 'Thumbs', null);
    assert.equal(res.success, false);
    assert.match(res.error, /full/);
    assert.match(res.error, /20 roles/);
});
