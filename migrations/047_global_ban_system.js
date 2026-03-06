/**
 * Migration 047: Global Ban Database System
 *
 * Creates tables for a shared cross-guild ban database:
 * - global_ban_entries: core ban list with severity and category
 * - global_ban_config: per-guild settings for enforcement actions
 * - global_ban_reports: manual reports from moderators
 * - global_ban_votes: cross-guild verification votes on reports
 * - global_ban_appeals: appeals from flagged users
 * - global_ban_auto_aggregate: cross-guild action tracking for auto-aggregation
 * - global_ban_action_log: audit trail of all actions taken
 */
export async function up(pool) {
    // Core ban list
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS global_ban_entries (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id VARCHAR(20) NOT NULL,
            severity ENUM('critical','high','medium','low') NOT NULL DEFAULT 'medium',
            category ENUM('phishing','scam','spam','raid','harassment','selfbot','mass_dm','impersonation','other') NOT NULL DEFAULT 'other',
            reason TEXT,
            evidence TEXT,
            source ENUM('auto_aggregate','manual_report','system') NOT NULL DEFAULT 'manual_report',
            reporter_id VARCHAR(20),
            source_guild_id VARCHAR(20),
            ban_count INT DEFAULT 0,
            verified TINYINT(1) DEFAULT 0,
            verification_votes INT DEFAULT 0,
            active TINYINT(1) DEFAULT 1,
            appealed TINYINT(1) DEFAULT 0,
            appeal_approved TINYINT(1) DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            expires_at TIMESTAMP NULL,
            INDEX idx_user_active (user_id, active),
            INDEX idx_severity (severity),
            INDEX idx_category (category),
            INDEX idx_created (created_at)
        )
    `);

    // Per-guild settings
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS global_ban_config (
            guild_id VARCHAR(20) PRIMARY KEY,
            enabled TINYINT(1) DEFAULT 0,
            action_critical ENUM('ban','kick','alert','none') DEFAULT 'ban',
            action_high ENUM('ban','kick','alert','none') DEFAULT 'ban',
            action_medium ENUM('ban','kick','alert','none') DEFAULT 'kick',
            action_low ENUM('ban','kick','alert','none') DEFAULT 'alert',
            alert_channel_id VARCHAR(20),
            log_actions TINYINT(1) DEFAULT 1,
            check_on_join TINYINT(1) DEFAULT 1,
            check_on_message TINYINT(1) DEFAULT 0,
            auto_aggregate_opt_in TINYINT(1) DEFAULT 1,
            exempt_roles TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);

    // Manual reports from moderators
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS global_ban_reports (
            id INT AUTO_INCREMENT PRIMARY KEY,
            reporter_id VARCHAR(20) NOT NULL,
            reporter_guild_id VARCHAR(20) NOT NULL,
            target_user_id VARCHAR(20) NOT NULL,
            category ENUM('phishing','scam','spam','raid','harassment','selfbot','mass_dm','impersonation','other') NOT NULL,
            severity ENUM('critical','high','medium','low') NOT NULL,
            evidence TEXT NOT NULL,
            reason TEXT NOT NULL,
            status ENUM('pending','approved','denied','escalated') DEFAULT 'pending',
            votes_approve INT DEFAULT 0,
            votes_deny INT DEFAULT 0,
            votes_required INT DEFAULT 3,
            global_ban_entry_id INT,
            reviewed_by VARCHAR(20),
            reviewed_at TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_target (target_user_id),
            INDEX idx_status (status),
            INDEX idx_reporter_guild (reporter_guild_id)
        )
    `);

    // Cross-guild verification votes
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS global_ban_votes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            report_id INT NOT NULL,
            voter_id VARCHAR(20) NOT NULL,
            voter_guild_id VARCHAR(20) NOT NULL,
            vote ENUM('approve','deny') NOT NULL,
            reason TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_report_voter (report_id, voter_id),
            INDEX idx_report (report_id)
        )
    `);

    // Appeals from flagged users
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS global_ban_appeals (
            id INT AUTO_INCREMENT PRIMARY KEY,
            global_ban_entry_id INT NOT NULL,
            user_id VARCHAR(20) NOT NULL,
            reason TEXT NOT NULL,
            evidence TEXT,
            status ENUM('pending','under_review','approved','denied') DEFAULT 'pending',
            reviewer_id VARCHAR(20),
            reviewer_response TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            reviewed_at TIMESTAMP NULL,
            INDEX idx_entry (global_ban_entry_id),
            INDEX idx_user (user_id),
            INDEX idx_status (status)
        )
    `);

    // Cross-guild action tracking for auto-aggregation
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS global_ban_auto_aggregate (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id VARCHAR(20) NOT NULL,
            guild_id VARCHAR(20) NOT NULL,
            action_type ENUM('ban','kick','mute','warn') NOT NULL,
            infraction_reason TEXT,
            moderator_id VARCHAR(20),
            occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            processed TINYINT(1) DEFAULT 0,
            UNIQUE KEY uk_user_guild_action (user_id, guild_id, action_type, occurred_at),
            INDEX idx_user_unprocessed (user_id, processed),
            INDEX idx_occurred (occurred_at)
        )
    `);

    // Audit trail
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS global_ban_action_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            global_ban_entry_id INT,
            guild_id VARCHAR(20) NOT NULL,
            user_id VARCHAR(20) NOT NULL,
            action ENUM('ban','kick','alert','appeal_submitted','appeal_approved','appeal_denied','report_created','report_approved','report_denied','entry_created','entry_expired','entry_removed') NOT NULL,
            performed_by VARCHAR(20),
            details TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_guild (guild_id),
            INDEX idx_user (user_id),
            INDEX idx_entry (global_ban_entry_id)
        )
    `);
}

export async function down(pool) {
    await pool.execute('DROP TABLE IF EXISTS global_ban_action_log');
    await pool.execute('DROP TABLE IF EXISTS global_ban_auto_aggregate');
    await pool.execute('DROP TABLE IF EXISTS global_ban_appeals');
    await pool.execute('DROP TABLE IF EXISTS global_ban_votes');
    await pool.execute('DROP TABLE IF EXISTS global_ban_reports');
    await pool.execute('DROP TABLE IF EXISTS global_ban_config');
    await pool.execute('DROP TABLE IF EXISTS global_ban_entries');
}
