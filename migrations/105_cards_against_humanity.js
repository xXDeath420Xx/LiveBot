/**
 * Migration 105: Cards Against Humanity
 *
 * Schema for a cross-platform CAH game played from Discord (slash commands +
 * ephemeral hand panels) and the dashboard (Socket.io). One game = one row in
 * `cah_games`; players from both surfaces sit in `cah_game_players`.
 *
 * Decks: built-in CAH base set seeded via a follow-up script, plus on-demand
 * imports from cast.clrtd.com (Cardcast-compatible API). Each game pins a
 * subset of decks via `cah_game_decks`.
 *
 * Game state lives in memory (core/cah-manager.js) and is snapshotted to
 * `cah_games.state_json` on every transition so a PM2 restart can resume.
 *
 * Tables:
 *   cah_decks            - imported deck metadata (cast | builtin | custom)
 *   cah_white_cards      - response cards (one row per card, FK -> cah_decks)
 *   cah_black_cards      - prompt cards with pick/draw counts
 *   cah_games            - live + recent game rows keyed by UUID
 *   cah_game_decks       - which decks each game pulls from
 *   cah_game_players     - player roster (discord or web), points, current hand
 *   cah_game_submissions - one row per player per round, ordered card ids
 *   cah_guild_config     - per-guild policy (NSFW gate, blank cards, defaults)
 */

async function tableExists(db, table) {
    const allowed = new Set([
        'cah_decks',
        'cah_white_cards',
        'cah_black_cards',
        'cah_games',
        'cah_game_decks',
        'cah_game_players',
        'cah_game_submissions',
        'cah_guild_config'
    ]);
    if (!allowed.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${table}'`
    );
    return rows[0].n > 0;
}

export async function up(db) {
    if (!(await tableExists(db, 'cah_decks'))) {
        await db.execute(`
            CREATE TABLE cah_decks (
                id                   INT AUTO_INCREMENT PRIMARY KEY,
                cast_id              VARCHAR(16) NULL,
                name                 VARCHAR(255) NOT NULL,
                description          TEXT NULL,
                source               ENUM('cast','builtin','custom') NOT NULL,
                author_username      VARCHAR(64) NULL,
                nsfw                 TINYINT(1) NOT NULL DEFAULT 0,
                imported_by_user_id  VARCHAR(20) NULL,
                imported_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                refreshed_at         TIMESTAMP NULL,
                UNIQUE KEY uq_cast_id (cast_id),
                INDEX idx_source (source)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }

    if (!(await tableExists(db, 'cah_white_cards'))) {
        await db.execute(`
            CREATE TABLE cah_white_cards (
                id      INT AUTO_INCREMENT PRIMARY KEY,
                deck_id INT NOT NULL,
                text    VARCHAR(500) NOT NULL,
                INDEX idx_deck (deck_id),
                CONSTRAINT fk_white_deck FOREIGN KEY (deck_id) REFERENCES cah_decks(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }

    if (!(await tableExists(db, 'cah_black_cards'))) {
        await db.execute(`
            CREATE TABLE cah_black_cards (
                id      INT AUTO_INCREMENT PRIMARY KEY,
                deck_id INT NOT NULL,
                text    VARCHAR(500) NOT NULL,
                pick    TINYINT NOT NULL DEFAULT 1,
                draw    TINYINT NOT NULL DEFAULT 0,
                INDEX idx_deck (deck_id),
                CONSTRAINT fk_black_deck FOREIGN KEY (deck_id) REFERENCES cah_decks(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }

    if (!(await tableExists(db, 'cah_games'))) {
        await db.execute(`
            CREATE TABLE cah_games (
                id                       VARCHAR(36) PRIMARY KEY,
                guild_id                 VARCHAR(20) NULL,
                channel_id               VARCHAR(20) NULL,
                host_user_id             VARCHAR(20) NOT NULL,
                visibility               ENUM('private','guild_only','public') NOT NULL DEFAULT 'guild_only',
                state                    ENUM('LOBBY','DEALING','SUBMITTING','JUDGING','SCORING','ROUND_END','GAME_END','ABANDONED') NOT NULL DEFAULT 'LOBBY',
                current_round            INT NOT NULL DEFAULT 0,
                current_black_card_id    INT NULL,
                current_czar_user_id     VARCHAR(20) NULL,
                settings_json            JSON NOT NULL,
                state_json               JSON NULL,
                created_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                ended_at                 TIMESTAMP NULL,
                INDEX idx_guild_state (guild_id, state),
                INDEX idx_channel_state (channel_id, state),
                INDEX idx_host (host_user_id),
                INDEX idx_public_lobby (visibility, state)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }

    if (!(await tableExists(db, 'cah_guild_config'))) {
        await db.execute(`
            CREATE TABLE cah_guild_config (
                guild_id              VARCHAR(20) PRIMARY KEY,
                nsfw_allowed          TINYINT(1) NOT NULL DEFAULT 0,
                blank_cards_allowed   TINYINT(1) NOT NULL DEFAULT 1,
                max_blank_cards       INT NOT NULL DEFAULT 5,
                allow_public_imports  TINYINT(1) NOT NULL DEFAULT 1,
                default_points        INT NOT NULL DEFAULT 7,
                default_max_rounds    INT NOT NULL DEFAULT 20,
                default_timeout_secs  INT NOT NULL DEFAULT 90,
                created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }

    if (!(await tableExists(db, 'cah_game_decks'))) {
        await db.execute(`
            CREATE TABLE cah_game_decks (
                game_id VARCHAR(36) NOT NULL,
                deck_id INT NOT NULL,
                PRIMARY KEY (game_id, deck_id),
                INDEX idx_deck (deck_id),
                CONSTRAINT fk_gd_game FOREIGN KEY (game_id) REFERENCES cah_games(id) ON DELETE CASCADE,
                CONSTRAINT fk_gd_deck FOREIGN KEY (deck_id) REFERENCES cah_decks(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }

    if (!(await tableExists(db, 'cah_game_players'))) {
        await db.execute(`
            CREATE TABLE cah_game_players (
                game_id          VARCHAR(36) NOT NULL,
                user_id          VARCHAR(64) NOT NULL,
                platform         ENUM('discord','web') NOT NULL,
                display_name     VARCHAR(64) NOT NULL,
                points           INT NOT NULL DEFAULT 0,
                hand_json        JSON NULL,
                timeout_strikes  INT NOT NULL DEFAULT 0,
                joined_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_active_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                left_at          TIMESTAMP NULL,
                PRIMARY KEY (game_id, user_id),
                INDEX idx_user (user_id),
                CONSTRAINT fk_gp_game FOREIGN KEY (game_id) REFERENCES cah_games(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }

    if (!(await tableExists(db, 'cah_game_submissions'))) {
        await db.execute(`
            CREATE TABLE cah_game_submissions (
                game_id       VARCHAR(36) NOT NULL,
                round         INT NOT NULL,
                user_id       VARCHAR(64) NOT NULL,
                card_ids_json JSON NOT NULL,
                submitted_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_winner     TINYINT(1) NOT NULL DEFAULT 0,
                PRIMARY KEY (game_id, round, user_id),
                INDEX idx_winner (game_id, is_winner),
                CONSTRAINT fk_gs_game FOREIGN KEY (game_id) REFERENCES cah_games(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS cah_game_submissions');
    await db.execute('DROP TABLE IF EXISTS cah_game_players');
    await db.execute('DROP TABLE IF EXISTS cah_game_decks');
    await db.execute('DROP TABLE IF EXISTS cah_guild_config');
    await db.execute('DROP TABLE IF EXISTS cah_games');
    await db.execute('DROP TABLE IF EXISTS cah_black_cards');
    await db.execute('DROP TABLE IF EXISTS cah_white_cards');
    await db.execute('DROP TABLE IF EXISTS cah_decks');
}
