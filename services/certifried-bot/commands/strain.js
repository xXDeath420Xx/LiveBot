/**
 * Strain Commands
 * !strain / !lookup - Look up strain information
 * !lineage / !genetics - Show strain genetics
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

/**
 * Search for a strain by name
 */
async function findStrain(query) {
    // Try exact match first
    let [rows] = await pool.execute(
        `SELECT * FROM tokes_strains WHERE LOWER(name) = LOWER(?) LIMIT 1`,
        [query]
    );

    if (rows.length > 0) return rows[0];

    // Try slug match
    const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    [rows] = await pool.execute(
        `SELECT * FROM tokes_strains WHERE slug = ? LIMIT 1`,
        [slug]
    );

    if (rows.length > 0) return rows[0];

    // Try fuzzy match
    [rows] = await pool.execute(
        `SELECT * FROM tokes_strains
         WHERE name LIKE ? OR name LIKE ? OR name LIKE ?
         ORDER BY
            CASE
                WHEN LOWER(name) = LOWER(?) THEN 0
                WHEN LOWER(name) LIKE LOWER(?) THEN 1
                ELSE 2
            END,
            name
         LIMIT 1`,
        [`${query}%`, `%${query}%`, `%${query}`, query, `${query}%`]
    );

    return rows[0] || null;
}

/**
 * Get random strain
 */
async function getRandomStrain() {
    const [rows] = await pool.execute(
        `SELECT * FROM tokes_strains ORDER BY RAND() LIMIT 1`
    );
    return rows[0] || null;
}

/**
 * Format strain type with emoji
 */
function formatType(type) {
    switch (type) {
        case 'indica': return 'Indica';
        case 'sativa': return 'Sativa';
        case 'hybrid': return 'Hybrid';
        default: return 'Unknown';
    }
}

/**
 * Parse JSON effects/flavors safely
 */
function parseJsonField(field) {
    if (!field) return [];
    try {
        if (typeof field === 'string') {
            return JSON.parse(field);
        }
        return field;
    } catch {
        return [];
    }
}

/**
 * !strain / !lookup - Look up strain information
 */
export async function strainCommand(ctx) {
    const { username, reply, args } = ctx;

    try {
        let strain;

        if (args.length === 0 || args[0]?.toLowerCase() === 'random') {
            // Random strain
            strain = await getRandomStrain();
            if (!strain) {
                reply(`No strains in the database yet!`);
                return;
            }
        } else {
            // Search for strain
            const query = args.join(' ');
            strain = await findStrain(query);

            if (!strain) {
                // Suggest similar
                const [similar] = await pool.execute(
                    `SELECT name FROM tokes_strains
                     WHERE name LIKE ?
                     LIMIT 3`,
                    [`%${query}%`]
                );

                if (similar.length > 0) {
                    const suggestions = similar.map(s => s.name).join(', ');
                    reply(`Strain "${query}" not found. Did you mean: ${suggestions}?`);
                } else {
                    reply(`Strain "${query}" not found. Try !strain random for a random one!`);
                }
                return;
            }
        }

        // Build response
        let response = `${strain.name} (${formatType(strain.strain_type)})`;

        // Add THC/CBD if available
        if (strain.thc_min || strain.thc_max) {
            const thc = strain.thc_min === strain.thc_max
                ? `${strain.thc_min}%`
                : `${strain.thc_min}-${strain.thc_max}%`;
            response += ` | THC: ${thc}`;
        }

        if (strain.cbd_min || strain.cbd_max) {
            const cbd = strain.cbd_min === strain.cbd_max
                ? `${strain.cbd_min}%`
                : `${strain.cbd_min}-${strain.cbd_max}%`;
            response += ` | CBD: ${cbd}`;
        }

        // Add effects
        const effects = parseJsonField(strain.effects);
        if (effects.length > 0) {
            const topEffects = effects.slice(0, 4).map(e =>
                e.charAt(0).toUpperCase() + e.slice(1)
            ).join(', ');
            response += ` | Effects: ${topEffects}`;
        }

        // Add flavors
        const flavors = parseJsonField(strain.flavors);
        if (flavors.length > 0) {
            const topFlavors = flavors.slice(0, 3).map(f =>
                f.charAt(0).toUpperCase() + f.slice(1)
            ).join(', ');
            response += ` | Flavors: ${topFlavors}`;
        }

        reply(response);

    } catch (error) {
        logger.error('[StrainCommand] Error', { error: error.message });
        reply(`${username}, couldn't look up that strain. Try again!`);
    }
}

/**
 * !lineage / !genetics - Show strain genetics
 */
export async function lineageCommand(ctx) {
    const { username, reply, args } = ctx;

    try {
        if (args.length === 0) {
            reply(`Usage: !lineage <strain name>`);
            return;
        }

        const query = args.join(' ');
        const strain = await findStrain(query);

        if (!strain) {
            reply(`Strain "${query}" not found.`);
            return;
        }

        let response = `${strain.name} (${formatType(strain.strain_type)})`;

        // Add parent strains if available
        if (strain.parent_1 || strain.parent_2) {
            const parents = [strain.parent_1, strain.parent_2].filter(Boolean);
            response += ` | Lineage: ${parents.join(' x ')}`;
        } else {
            response += ` | Lineage: Unknown`;
        }

        // Add description if available (truncated)
        if (strain.description) {
            const desc = strain.description.length > 150
                ? strain.description.substring(0, 147) + '...'
                : strain.description;
            response += ` | ${desc}`;
        }

        reply(response);

    } catch (error) {
        logger.error('[LineageCommand] Error', { error: error.message });
        reply(`${username}, couldn't look up lineage. Try again!`);
    }
}
