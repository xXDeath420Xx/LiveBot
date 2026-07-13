// Full rebuild of #roles — purges the channel, posts 3 pretty panels as Twatwaffle Patrol,
// and backfills reaction_role_mappings.label so future re-posts don't look bastardized.
import { createPool } from './shared.js';

const GUILD = '1099732505243959407';
const ROLES_CH = '1456056474097680394';
const NEW_BOT_ID = '1496352090950467595';
const COLOR = 0x5865F2;

async function main() {
    const pool = createPool();
    const enc = (await import('../../utils/encryption.js')).default;
    const [r] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [NEW_BOT_ID]);
    const token = enc.decrypt(JSON.parse(r[0].bot_token));
    const H = { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' };

    // 1. Fetch all guild roles → name lookup
    const rolesRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD}/roles`, { headers: H });
    const allRoles = await rolesRes.json();
    const roleNameById = Object.fromEntries(allRoles.map(r => [r.id, r.name]));

    // 2. Purge every message in #roles — regardless of author. Uses bulk-delete for <14d
    console.log('purging #roles…');
    let purged = 0;
    while (true) {
        const mRes = await fetch(`https://discord.com/api/v10/channels/${ROLES_CH}/messages?limit=100`, { headers: H });
        const msgs = await mRes.json();
        if (!Array.isArray(msgs) || msgs.length === 0) break;
        const now = Date.now();
        const fourteenD = 14 * 24 * 60 * 60 * 1000;
        const bulk = msgs.filter(m => now - new Date(m.timestamp).getTime() < fourteenD).map(m => m.id);
        const old = msgs.filter(m => now - new Date(m.timestamp).getTime() >= fourteenD);

        if (bulk.length >= 2) {
            const bd = await fetch(`https://discord.com/api/v10/channels/${ROLES_CH}/messages/bulk-delete`, {
                method: 'POST', headers: H, body: JSON.stringify({ messages: bulk })
            });
            if (bd.ok) purged += bulk.length;
        } else if (bulk.length === 1) {
            await fetch(`https://discord.com/api/v10/channels/${ROLES_CH}/messages/${bulk[0]}`, { method: 'DELETE', headers: H });
            purged++;
        }
        for (const o of old) {
            const d = await fetch(`https://discord.com/api/v10/channels/${ROLES_CH}/messages/${o.id}`, { method: 'DELETE', headers: H });
            if (d.ok) purged++;
        }
        if (msgs.length < 100) break;
    }
    console.log(`purged ${purged} messages`);

    // 3. Load existing panels and mappings from DB so we keep the same role IDs
    const [panels] = await pool.execute(
        "SELECT id, panel_name, interaction_type, panel_mode FROM reaction_role_panels WHERE guild_id = ? AND channel_id = ? ORDER BY id ASC",
        [GUILD, ROLES_CH]
    );

    // Hardcoded panel definitions keyed by panel_name (so we can render pretty text)
    const PANEL_COPY = {
        'Color Roles': {
            embed: {
                color: COLOR,
                title: '🎨 Color Roles',
                description: "Pick the color you want next to your name.\n_One color at a time — selecting a new one replaces the old._",
            },
            // Pretty name overrides in case the raw role name is ugly
            labelFor: (roleName) => roleName,
            placeholder: 'Choose a color…',
        },
        'Game Roles': {
            embed: {
                color: COLOR,
                title: '🎮 Game Roles',
                description: "Pick the games you play.\n_Select as many as you want — each opens the matching game channel._",
            },
            labelFor: (roleName) => roleName,
            placeholder: 'Choose one or more games…',
        },
        'Notifications': {
            embed: {
                color: COLOR,
                title: '🔔 Notifications & Extras',
                description: [
                    "Toggle optional access and pings:",
                    "",
                    "📢 **Announcements** — get pinged for important server news",
                    "🎵 **Music** — unlocks the #music channel so you can queue songs",
                ].join('\n'),
            },
            labelFor: (roleName) => roleName,
        },
    };

    // 4. Rebuild each panel
    for (const panel of panels) {
        const copy = PANEL_COPY[panel.panel_name];
        if (!copy) { console.log(`  no copy defined for panel ${panel.panel_name}, skipping`); continue; }

        const [mappings] = await pool.execute(
            'SELECT id, role_id, emoji_id FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id ASC',
            [panel.id]
        );
        if (!mappings.length) continue;

        // Enrich each mapping with role name as label, and backfill DB
        const enriched = mappings.map(m => {
            const name = roleNameById[m.role_id] || 'Unknown role';
            return { ...m, label: copy.labelFor(name) };
        });
        for (const m of enriched) {
            await pool.execute('UPDATE reaction_role_mappings SET label = ? WHERE id = ?', [m.label, m.id]);
        }

        let components;
        if (panel.interaction_type === 'button') {
            const buttons = enriched.map((m, i) => ({
                type: 2,
                style: i === 0 ? 1 : 2,
                label: m.label,
                emoji: m.emoji_id ? { name: m.emoji_id } : undefined,
                custom_id: `rr_${m.role_id}`,
            }));
            components = [{ type: 1, components: buttons }];
        } else {
            const options = enriched.map(m => ({
                label: m.label,
                value: m.role_id,
                emoji: m.emoji_id ? { name: m.emoji_id } : undefined,
            }));
            components = [{
                type: 1,
                components: [{
                    type: 3,
                    custom_id: `rr_select_${panel.panel_name.toLowerCase().replace(/[^a-z]+/g, '_')}`,
                    placeholder: copy.placeholder || 'Choose…',
                    min_values: panel.panel_mode === 'unique' ? 0 : 0,
                    max_values: panel.panel_mode === 'unique' ? 1 : options.length,
                    options,
                }],
            }];
        }

        const postRes = await fetch(`https://discord.com/api/v10/channels/${ROLES_CH}/messages`, {
            method: 'POST', headers: H,
            body: JSON.stringify({ embeds: [copy.embed], components }),
        });
        if (!postRes.ok) { console.log(`  ✗ post ${panel.panel_name}: ${postRes.status} ${await postRes.text()}`); continue; }
        const sent = await postRes.json();

        await pool.execute('UPDATE reaction_role_panels SET message_id = ? WHERE id = ?', [sent.id, panel.id]);
        console.log(`  ✓ ${panel.panel_name}: ${enriched.length} options, msg ${sent.id}`);
    }

    await pool.end();
    console.log('DONE');
}

main().catch(err => { console.error('FATAL', err?.stack || err); process.exit(1); });
