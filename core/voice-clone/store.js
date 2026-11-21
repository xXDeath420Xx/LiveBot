/*
 * Own-voice tables (migration 476). Every query names the tables through `prefix`, so tests run on throwaway copies
 * (voiceCloneDdl(prefix)).
 *
 *   createVoiceCloneStore({ db, prefix = 'voice_clone_' })
 * Plain SQL, no business rules (those are in service.js). JSON columns come back parsed.
 */
const J = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
};

export function createVoiceCloneStore({ db, prefix = 'voice_clone_' } = {}) {
    if (!/^[a-z0-9_]+$/.test(prefix)) throw new Error('bad prefix');
    const T = (n) => `\`${prefix}${n}\``;
    const q = async (sql, args = []) => (await db.query(sql, args))[0];
    const voiceRow = (r) => (r ? { ...r, tuning: J(r.tuning), features: J(r.features), model_attestation: J(r.model_attestation) } : null);

    return {
        prefix,
        async available() {
            try { await q(`SELECT 1 FROM ${T('voices')} LIMIT 1`); return true; } catch { return false; }
        },

        // ── invites ──
        async getInvite(userId) { return (await q(`SELECT * FROM ${T('invites')} WHERE user_id = ?`, [String(userId)]))[0] || null; },
        async listInvites() { return q(`SELECT * FROM ${T('invites')} ORDER BY revoked_at IS NULL DESC, created_at DESC LIMIT 600`); },
        async addInvite(userId, by, note = null) {
            await q(`INSERT INTO ${T('invites')} (user_id, invited_by, note) VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE invited_by = VALUES(invited_by), note = VALUES(note), revoked_at = NULL, revoked_by = NULL, created_at = CURRENT_TIMESTAMP`,
            [String(userId), String(by), note]);
        },
        async revokeInvite(userId, by) {
            const r = await q(`UPDATE ${T('invites')} SET revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE user_id = ? AND revoked_at IS NULL`, [String(by), String(userId)]);
            return r.affectedRows > 0;
        },

        // ── voices ──
        async liveVoiceOf(userId) { return voiceRow((await q(`SELECT * FROM ${T('voices')} WHERE live_owner = ?`, [String(userId)]))[0]); },
        async voiceById(id) { return voiceRow((await q(`SELECT * FROM ${T('voices')} WHERE id = ?`, [String(id)]))[0]); },
        async voiceByLegacy(name) { return voiceRow((await q(`SELECT * FROM ${T('voices')} WHERE legacy_voice_id = ? AND status <> 'deleted' LIMIT 1`, [String(name)]))[0]); },
        async createVoice(v) {
            await q(`INSERT INTO ${T('voices')} (id, owner_user_id, display_name, status, base_model, data_key_encrypted, wm_id, tuning, features, consent_id, keep_samples)
                     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
            [v.id, String(v.ownerUserId), v.displayName, v.baseModel, v.dataKeyEncrypted, v.wmId, JSON.stringify(v.tuning || {}), JSON.stringify(v.features || {}),
                v.consentId ?? null, v.keepSamples ? 1 : 0]);
        },
        async updateVoice(id, fields) {
            const keys = Object.keys(fields).filter((k) => /^[a-z_0-9]+$/.test(k));
            if (!keys.length) return 0;
            const vals = keys.map((k) => (fields[k] !== null && typeof fields[k] === 'object' && !(fields[k] instanceof Date) ? JSON.stringify(fields[k]) : fields[k]));
            const sets = keys.map((k) => (fields[k] === 'NOW()' ? `\`${k}\` = CURRENT_TIMESTAMP` : `\`${k}\` = ?`));
            const args = vals.filter((v, i) => fields[keys[i]] !== 'NOW()');
            return (await q(`UPDATE ${T('voices')} SET ${sets.join(', ')} WHERE id = ?`, [...args, String(id)])).affectedRows;
        },
        async setVoiceStatus(id, status, fromStatuses = null) {
            const extra = fromStatuses?.length ? ` AND status IN (${fromStatuses.map(() => '?').join(', ')})` : '';
            return (await q(`UPDATE ${T('voices')} SET status = ? WHERE id = ?${extra}`, [status, String(id), ...(fromStatuses || [])])).affectedRows;
        },
        async countLive() { return Number((await q(`SELECT COUNT(*) AS n FROM ${T('voices')} WHERE status <> 'deleted'`))[0].n); },
        /** wm ids not free: live voices, and deleted voices from the last 3 years (never reused for 3 years). */
        async wmTaken(wmId) {
            return (await q(`SELECT 1 FROM ${T('voices')} WHERE wm_id = ? AND (status <> 'deleted' OR deleted_at > DATE_SUB(NOW(), INTERVAL 3 YEAR)) LIMIT 1`, [wmId])).length > 0;
        },
        async voiceByWm(wmId) { return voiceRow((await q(`SELECT * FROM ${T('voices')} WHERE wm_id = ? ORDER BY status = 'deleted', created_at DESC LIMIT 1`, [wmId]))[0]); },
        async voicesWithCentroid() { return (await q(`SELECT id, owner_user_id, data_key_encrypted, centroid_encrypted FROM ${T('voices')} WHERE status <> 'deleted' AND centroid_encrypted IS NOT NULL`)); },
        async listVoices() { return (await q(`SELECT * FROM ${T('voices')} ORDER BY created_at DESC LIMIT 600`)).map(voiceRow); },
        async idleVoices(days) {
            return (await q(`SELECT id FROM ${T('voices')} WHERE status <> 'deleted' AND COALESCE(last_used_at, approved_at, created_at) < DATE_SUB(NOW(), INTERVAL ? DAY)`, [days])).map((r) => r.id);
        },

        // ── samples ──
        async addSample(s) {
            const r = await q(`INSERT INTO ${T('samples')} (voice_id, kind, prompt_index, prompt_text, duration_ms, sha256, file_name, asr_wer, score_redimnet, score_ecapa, checks, status, reason)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [s.voiceId, s.kind || 'recorded', s.promptIndex ?? null, s.promptText ?? null, Math.round(s.durationMs || 0), s.sha256 ?? null, s.fileName ?? null,
                s.asrWer ?? null, s.scoreRedimnet ?? null, s.scoreEcapa ?? null, JSON.stringify(s.checks || {}), s.status || 'ok', s.reason ?? null]);
            return Number(r.insertId);
        },
        async listSamples(voiceId, { kind = null } = {}) {
            return (await q(`SELECT * FROM ${T('samples')} WHERE voice_id = ?${kind ? ' AND kind = ?' : ''} ORDER BY id`, kind ? [voiceId, kind] : [voiceId]))
                .map((r) => ({ ...r, checks: J(r.checks) }));
        },
        async sampleSummary(voiceId) {
            const [r] = await q(`SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms), 0) AS ms, MIN(created_at) AS first_at FROM ${T('samples')} WHERE voice_id = ? AND kind = 'recorded' AND status = 'ok'`, [voiceId]);
            return { count: Number(r.n), ms: Number(r.ms), firstAt: r.first_at };
        },
        async setSampleFile(voiceId, id, fileName) { await q(`UPDATE ${T('samples')} SET file_name = ? WHERE voice_id = ? AND id = ?`, [fileName, voiceId, id]); },
        async deleteSample(voiceId, id) { return (await q(`DELETE FROM ${T('samples')} WHERE voice_id = ? AND id = ?`, [voiceId, id])).affectedRows; },
        async markSamplesPurged(voiceId, ids = null) {
            const extra = ids ? ` AND id IN (${ids.map(() => '?').join(', ') || 'NULL'})` : '';
            return (await q(`UPDATE ${T('samples')} SET status = 'purged', purged_at = CURRENT_TIMESTAMP, file_name = NULL, checks = NULL WHERE voice_id = ? AND status <> 'purged'${extra}`, [voiceId, ...(ids || [])])).affectedRows;
        },
        /** Voices with sample files to purge: 30 days from the first recording, or 7 days after training unless kept. */
        async voicesWithSamplesToPurge(capDays, afterTrainingDays) {
            return (await q(`SELECT DISTINCT s.voice_id FROM ${T('samples')} s JOIN ${T('voices')} v ON v.id = s.voice_id
                              WHERE s.status <> 'purged' AND (s.created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
                                 OR (v.keep_samples = 0 AND v.trained_at IS NOT NULL AND v.trained_at < DATE_SUB(NOW(), INTERVAL ? DAY)))`, [capDays, afterTrainingDays]))
                .map((r) => r.voice_id);
        },
        async expiredSampleIds(voiceId, capDays) {
            return (await q(`SELECT id FROM ${T('samples')} WHERE voice_id = ? AND status <> 'purged' AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`, [voiceId, capDays])).map((r) => Number(r.id));
        },

        // ── consents ──
        async addConsent(c) {
            const r = await q(`INSERT INTO ${T('consents')} (user_id, voice_id, text_version, text_sha256, typed_name_encrypted, age_attested, own_voice_attested, residence_state,
                                   residence_country, cf_country, cf_region, ip_hash, keep_samples, threshold_version, consent_method, recorded_by, note)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'US', ?, ?, ?, ?, ?, ?, ?, ?)`,
            [String(c.userId), c.voiceId ?? null, c.textVersion, c.textSha256, c.typedNameEncrypted, c.ageAttested ? 1 : 0, c.ownVoiceAttested ? 1 : 0, c.state ?? null,
                c.cfCountry ?? null, c.cfRegion ?? null, c.ipHash ?? null, c.keepSamples ? 1 : 0, c.thresholdVersion ?? null, c.consentMethod || 'live_check', c.recordedBy ?? null, c.note ?? null]);
            return Number(r.insertId);
        },
        async consentById(id) {
            const r = (await q(`SELECT * FROM ${T('consents')} WHERE id = ?`, [id]))[0] || null;
            return r ? { ...r, evidence: J(r.evidence) } : null;
        },
        async updateConsent(id, fields) {
            const keys = Object.keys(fields).filter((k) => /^[a-z_0-9]+$/.test(k));
            if (!keys.length) return 0;
            const sets = keys.map((k) => (fields[k] === 'NOW()' ? `\`${k}\` = CURRENT_TIMESTAMP` : `\`${k}\` = ?`));
            const args = keys.filter((k) => fields[k] !== 'NOW()').map((k) => (fields[k] !== null && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]));
            return (await q(`UPDATE ${T('consents')} SET ${sets.join(', ')} WHERE id = ?`, [...args, id])).affectedRows;
        },
        async setConsentVoice(id, voiceId) { await q(`UPDATE ${T('consents')} SET voice_id = ? WHERE id = ?`, [voiceId, id]); },
        async verifyConsent(id, { wer, redimnet, ecapa, thresholdVersion }) {
            await q(`UPDATE ${T('consents')} SET verified_at = CURRENT_TIMESTAMP, asr_wer = ?, score_redimnet = ?, score_ecapa = ?, threshold_version = ? WHERE id = ? AND revoked_at IS NULL`,
                [wer, redimnet, ecapa, thresholdVersion, id]);
        },
        async revokeConsents({ voiceId = null, userId = null, reason }) {
            if (!voiceId && !userId) return 0;
            const where = voiceId ? 'voice_id = ?' : 'user_id = ?';
            return (await q(`UPDATE ${T('consents')} SET revoked_at = CURRENT_TIMESTAMP, revoke_reason = ? WHERE ${where} AND revoked_at IS NULL`, [reason, String(voiceId || userId)])).affectedRows;
        },
        async consentsOf(userId) { return q(`SELECT * FROM ${T('consents')} WHERE user_id = ? ORDER BY id DESC LIMIT 50`, [String(userId)]); },

        // ── jobs ──
        async createJob(voiceId, totalSteps) {
            const r = await q(`INSERT INTO ${T('jobs')} (voice_id, total_steps) VALUES (?, ?)`, [voiceId, totalSteps]);
            return Number(r.insertId);
        },
        async jobById(id) { return (await q(`SELECT * FROM ${T('jobs')} WHERE id = ?`, [id]))[0] || null; },
        async openJobFor(voiceId) {
            return (await q(`SELECT * FROM ${T('jobs')} WHERE voice_id = ? AND state IN ('queued','leased','running','paused','uploading','checking') ORDER BY id DESC LIMIT 1`, [voiceId]))[0] || null;
        },
        async latestJobFor(voiceId) { return (await q(`SELECT * FROM ${T('jobs')} WHERE voice_id = ? ORDER BY id DESC LIMIT 1`, [voiceId]))[0] || null; },
        async nextQueued() {
            // Gate: only voices with a complete, unwithdrawn consent (verified; a residence declared) are ever handed out.
            return (await q(`SELECT j.* FROM ${T('jobs')} j JOIN ${T('voices')} v ON v.id = j.voice_id
                              JOIN ${T('consents')} c ON c.id = v.consent_id AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL AND (c.residence_state IS NOT NULL OR c.region_exception IS NOT NULL)
                              WHERE j.state = 'queued' AND v.status = 'queued' ORDER BY j.id LIMIT 1`))[0] || null;
        },
        async queuePosition(jobId) {
            return Number((await q(`SELECT COUNT(*) AS n FROM ${T('jobs')} WHERE state IN ('queued','leased','running','paused','uploading','checking') AND id < ?`, [jobId]))[0].n);
        },
        async leaseJob(id, { tokenHash, workerId, leaseMs }) {
            const r = await q(`UPDATE ${T('jobs')} SET state = 'leased', lease_token_hash = ?, worker_id = ?, attempt = attempt + 1,
                                      leased_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND), last_heartbeat_at = CURRENT_TIMESTAMP,
                                      started_at = COALESCE(started_at, CURRENT_TIMESTAMP), error = NULL
                                WHERE id = ? AND state = 'queued'`, [tokenHash, String(workerId).slice(0, 64), Math.ceil(leaseMs / 1000), id]);
            return r.affectedRows === 1;
        },
        async updateJob(id, fields) {
            const keys = Object.keys(fields).filter((k) => /^[a-z_0-9]+$/.test(k));
            if (!keys.length) return 0;
            const sets = keys.map((k) => (fields[k] === 'NOW()' ? `\`${k}\` = CURRENT_TIMESTAMP` : `\`${k}\` = ?`));
            const args = keys.filter((k) => fields[k] !== 'NOW()').map((k) => fields[k]);
            return (await q(`UPDATE ${T('jobs')} SET ${sets.join(', ')} WHERE id = ?`, [...args, id])).affectedRows;
        },
        async extendLease(id, leaseMs) {
            await q(`UPDATE ${T('jobs')} SET leased_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND), last_heartbeat_at = CURRENT_TIMESTAMP WHERE id = ?`, [Math.ceil(leaseMs / 1000), id]);
        },
        async expiredLeases() {
            return q(`SELECT * FROM ${T('jobs')} WHERE state IN ('leased','running','paused','uploading') AND leased_until < CURRENT_TIMESTAMP`);
        },
        async runsInDays(voiceId, days) {
            return Number((await q(`SELECT COUNT(*) AS n FROM ${T('jobs')} WHERE voice_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? DAY)`, [voiceId, days]))[0].n);
        },
        async cancelOpenJobs(voiceId, reason) {
            return (await q(`UPDATE ${T('jobs')} SET state = 'cancelled', error = ?, finished_at = CURRENT_TIMESTAMP
                              WHERE voice_id = ? AND state IN ('queued','leased','running','paused','uploading','checking')`, [reason, voiceId])).affectedRows;
        },
        async listJobs(limit = 50) { return q(`SELECT * FROM ${T('jobs')} ORDER BY id DESC LIMIT ?`, [limit]); },

        // ── events ──
        async addEvent({ voiceId = null, userId = null, actor, event, detail = null }) {
            await q(`INSERT INTO ${T('events')} (voice_id, user_id, actor, event, detail) VALUES (?, ?, ?, ?, ?)`,
                [voiceId, userId ? String(userId) : null, actor, event, detail ? JSON.stringify(detail) : null]);
        },
        async countEvents({ userId, event, hours }) {
            return Number((await q(`SELECT COUNT(*) AS n FROM ${T('events')} WHERE user_id = ? AND event = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? HOUR)`, [String(userId), event, hours]))[0].n);
        },
        async lastEvents({ userId, events, limit }) {
            return q(`SELECT event, created_at FROM ${T('events')} WHERE user_id = ? AND event IN (${events.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT ?`, [String(userId), ...events, limit]);
        },
        async listEvents({ voiceId = null, limit = 100 } = {}) {
            const rows = voiceId ? await q(`SELECT * FROM ${T('events')} WHERE voice_id = ? ORDER BY id DESC LIMIT ?`, [voiceId, limit])
                : await q(`SELECT * FROM ${T('events')} ORDER BY id DESC LIMIT ?`, [limit]);
            return rows.map((r) => ({ ...r, detail: J(r.detail) }));
        },

        // ── usage ──
        async usageOn(userId, day) {
            return (await q(`SELECT chars, audio_ms, requests FROM ${T('usage_daily')} WHERE user_id = ? AND day = ?`, [String(userId), day]))[0] || { chars: 0, audio_ms: 0, requests: 0 };
        },
        async addUsage(userId, day, chars, audioMs) {
            await q(`INSERT INTO ${T('usage_daily')} (user_id, day, chars, audio_ms, requests) VALUES (?, ?, ?, ?, 1)
                     ON DUPLICATE KEY UPDATE chars = chars + VALUES(chars), audio_ms = audio_ms + VALUES(audio_ms), requests = requests + 1`,
            [String(userId), day, chars, Math.round(audioMs)]);
        },
        async gpuSecondsOn(day) { return Number((await q(`SELECT gpu_seconds FROM ${T('gpu_daily')} WHERE day = ?`, [day]))[0]?.gpu_seconds || 0); },
        async addGpuSeconds(day, s) {
            if (!(s > 0)) return;
            await q(`INSERT INTO ${T('gpu_daily')} (day, gpu_seconds) VALUES (?, ?) ON DUPLICATE KEY UPDATE gpu_seconds = gpu_seconds + VALUES(gpu_seconds)`, [day, Math.round(s)]);
        },
    };
}

export default { createVoiceCloneStore };
