/**
 * Diff engine: compares validated scrape data against current DB entries.
 * Produces a structured report of all needed changes.
 */

/**
 * Generate a diff report between validated data and current DB entries.
 * @param {Array} validated - Validated entries from phase 2
 * @param {Array} dbEntries - Current DB entries (from global_ban_entries)
 * @returns {Object} Diff report
 */
export function generateDiff(validated, dbEntries) {
    const dbMap = new Map(dbEntries.map(e => [e.user_id, e]));
    const validatedMap = new Map(validated.map(e => [e.user_id, e]));

    const updates = [];     // Entries needing field changes
    const inserts = [];     // New entries not in DB
    const orphans = [];     // In DB but not in scrape
    const flagged = [];     // Bad IDs (server IDs, etc.)
    const unchanged = [];   // Already correct

    for (const entry of validated) {
        if (entry.flagged) {
            flagged.push({
                user_id: entry.user_id,
                flag_reason: entry.flag_reason,
                current_db: dbMap.get(entry.user_id) || null,
            });
            continue;
        }

        const dbEntry = dbMap.get(entry.user_id);

        if (!dbEntry) {
            inserts.push(entry);
            continue;
        }

        // Compare fields
        const changes = {};
        if (entry.reason && entry.reason !== dbEntry.reason) {
            changes.reason = { old: dbEntry.reason, new: entry.reason };
        }
        if (entry.category && entry.category !== dbEntry.category) {
            changes.category = { old: dbEntry.category, new: entry.category };
        }
        if (entry.username && entry.username !== dbEntry.username) {
            changes.username = { old: dbEntry.username, new: entry.username };
        }
        if (entry.reporter_name && entry.reporter_name !== dbEntry.reporter_name) {
            changes.reporter_name = { old: dbEntry.reporter_name, new: entry.reporter_name };
        }
        // Merge evidence: combine existing + new without duplicates
        if (entry.evidence) {
            const existingEvidence = parseEvidence(dbEntry.evidence);
            const newEvidence = parseEvidence(entry.evidence);
            const merged = [...new Set([...existingEvidence, ...newEvidence])];
            const mergedStr = JSON.stringify(merged);
            if (mergedStr !== dbEntry.evidence) {
                changes.evidence = { old: dbEntry.evidence, new: mergedStr };
            }
        }

        if (Object.keys(changes).length > 0) {
            updates.push({
                user_id: entry.user_id,
                db_id: dbEntry.id,
                changes,
            });
        } else {
            unchanged.push(entry.user_id);
        }
    }

    // Find orphans: in DB but not in validated scrape data
    for (const dbEntry of dbEntries) {
        if (!validatedMap.has(dbEntry.user_id) && dbEntry.active) {
            orphans.push({
                user_id: dbEntry.user_id,
                db_id: dbEntry.id,
                username: dbEntry.username,
                reason: dbEntry.reason,
                source: dbEntry.source,
            });
        }
    }

    return {
        summary: {
            total_validated: validated.length,
            total_in_db: dbEntries.length,
            updates: updates.length,
            inserts: inserts.length,
            orphans: orphans.length,
            flagged: flagged.length,
            unchanged: unchanged.length,
        },
        updates,
        inserts,
        orphans,
        flagged,
        unchanged,
    };
}

/**
 * Parse evidence from DB format (could be JSON array string or plain text).
 */
function parseEvidence(evidence) {
    if (!evidence) return [];
    try {
        const parsed = JSON.parse(evidence);
        return Array.isArray(parsed) ? parsed : [evidence];
    } catch {
        return [evidence];
    }
}
