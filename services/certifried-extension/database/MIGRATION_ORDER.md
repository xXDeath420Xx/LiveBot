# CertiFried Extension - Database Migration Order

## CRITICAL: Required Migrations

The following migrations **MUST** be run in order for the game to function correctly.
Many of the current errors in production are due to these migrations not being executed.

### Base Schema (Required First)
```sql
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/schema.sql;
```

### Phase 1-5 Migrations (In Order)
```sql
-- Phase 1: Quality of Life features
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/add_phase1_features.sql;

-- Phase 2: Contracts, Extraction, Black Market
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/add_phase2_features.sql;

-- Phase 3: Research & Equipment
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/add_phase3_features.sql;

-- Phase 4: Social & Competition (Cartels, Turf Wars, Tournaments)
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/add_phase4_features.sql;

-- Phase 5: Events, Dispensary, Mini-games
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/add_phase5_features.sql;
```

### Worker System Migrations
```sql
-- Worker enhancements (types, traits, training)
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/add_worker_enhancements.sql;

-- Worker tracking
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/add_worker_tracking.sql;
```

### Raid System
```sql
-- DEA Raid system
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/add_raid_system.sql;
```

### Breeding System Fixes
```sql
-- Fix breeding operations columns
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/fix_breeding_columns.sql;

-- Add breeding columns to strains
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/add_breeding_columns.sql;
```

### Slot Configuration
```sql
-- Per-slot strain preferences, auto-buy settings
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/add_slot_configuration.sql;
```

### CRITICAL FIX MIGRATIONS (NEW - February 2026)
These migrations fix bugs found during deep analysis:

```sql
-- FIX: Player columns (last_online_at, cfx_player_stats)
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/fix_player_columns.sql;

-- FIX: Market engine (missing tables and columns)
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/fix_market_engine.sql;

-- FIX: Worker settings (workflow columns)
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/fix_worker_settings.sql;

-- FIX: Shop system (cfx_shop_rotation, cfx_shop_items)
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/fix_shop_system.sql;
```

### Seed Data
```sql
-- Ensure base strains exist
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/ensure_base_strains.sql;

-- Add skill nodes
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/fix_skill_nodes.sql;

-- Fix quests
SOURCE /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/fix_quests.sql;
```

## Quick Fix Command (All Critical Migrations)

Run this to apply all critical fix migrations at once:

```bash
mysql -u root -p certifried_extension < /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/fix_player_columns.sql && \
mysql -u root -p certifried_extension < /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/fix_market_engine.sql && \
mysql -u root -p certifried_extension < /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/fix_worker_settings.sql && \
mysql -u root -p certifried_extension < /home/death/CertiFriedUtility/services/certifried-extension/database/migrations/fix_shop_system.sql
```

## Bugs Fixed by These Migrations

### fix_player_columns.sql
- `cfx_players.last_online_at` column (used by raid-tick.js)
- `cfx_player_stats` table (used by raid system and stats tracking)
- `cfx_players.skill_points` column
- Initializes missing player data

### fix_market_engine.sql
- `cfx_market_prices.previous_price`, `price_change_pct`, `high_24h`, `low_24h`
- `cfx_market_prices.volume_24h`, `supply_volume`, `demand_score`
- `cfx_market_prices.trend`, `volatility`
- `cfx_strains.demand_weight`
- `cfx_market_listings.inventory_id`
- `cfx_npc_sales` table
- `cfx_market_price_history` table

### fix_worker_settings.sql
- `cfx_player_settings.workflow_mode`
- `cfx_player_settings.min_inventory_reserve`
- `cfx_player_settings.process_before_sell`
- `cfx_player_settings.sell_quality_threshold`
- `cfx_player_settings.reserve_rare_strains`
- `cfx_player_settings.max_auto_sell_percent`
- `cfx_extraction_slots.input_strain_id`
- `cfx_extraction_recipes.quality_retention`, `product_name`, `tier`

### fix_shop_system.sql
- `cfx_shop_rotation` table (daily/weekly deals)
- `cfx_shop_items` table (shop inventory)
- `cfx_player_shop_items` table (purchased items)
- Seeds shop items and basic workers

## After Running Migrations

**IMPORTANT**: Restart the server after running migrations to ensure all code picks up the schema changes.

```bash
pm2 restart certifried-server
# OR
systemctl restart certifried-extension
```
