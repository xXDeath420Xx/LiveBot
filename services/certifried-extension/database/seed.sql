-- CertiFried Extension Seed Data
-- Initial strains, skills, quests

-- ============================================
-- STARTER STRAINS (Common - easily accessible)
-- ============================================
INSERT INTO cfx_strains (name, slug, strain_type, rarity, base_grow_time_ms, base_yield_min, base_yield_max, base_quality_min, base_quality_max, base_price, gene_thc, gene_cbd, gene_yield, gene_speed, gene_quality, gene_resilience, effects, flavors, description, is_starter) VALUES
-- Common Strains (1-2 minute grow times for fun gameplay)
('Northern Lights', 'northern-lights', 'indica', 'common', 60000, 2, 4, 30, 60, 15.00, 55, 30, 50, 55, 50, 60, '["relaxed", "sleepy", "happy"]', '["earthy", "pine", "sweet"]', 'A classic indica known for relaxation and easy growing.', 1),
('Blue Dream', 'blue-dream', 'hybrid', 'common', 75000, 2, 5, 35, 65, 18.00, 60, 25, 55, 50, 55, 50, '["creative", "euphoric", "uplifted"]', '["blueberry", "sweet", "berry"]', 'A legendary hybrid with balanced effects.', 1),
('Sour Diesel', 'sour-diesel', 'sativa', 'common', 90000, 1, 4, 30, 55, 16.00, 65, 15, 45, 45, 50, 45, '["energetic", "euphoric", "focused"]', '["diesel", "citrus", "pungent"]', 'A fast-acting sativa with energizing effects.', 1),
('OG Kush', 'og-kush', 'hybrid', 'common', 80000, 2, 4, 35, 60, 17.00, 70, 20, 50, 48, 55, 55, '["relaxed", "happy", "euphoric"]', '["earthy", "pine", "woody"]', 'The backbone of countless hybrid strains.', 1),

-- Uncommon Strains (2-3 minute grow times)
('Girl Scout Cookies', 'gsc', 'hybrid', 'uncommon', 120000, 2, 5, 45, 70, 25.00, 75, 20, 50, 45, 65, 50, '["euphoric", "relaxed", "creative"]', '["sweet", "cookie", "minty"]', 'A potent hybrid with dessert-like flavors.', 0),
('Granddaddy Purple', 'granddaddy-purple', 'indica', 'uncommon', 135000, 2, 5, 40, 68, 23.00, 65, 25, 55, 42, 60, 60, '["relaxed", "sleepy", "happy"]', '["grape", "berry", "sweet"]', 'A famous purple-hued indica with grape flavors.', 0),
('Jack Herer', 'jack-herer', 'sativa', 'uncommon', 150000, 1, 4, 40, 65, 22.00, 65, 30, 45, 50, 58, 55, '["creative", "energetic", "uplifted"]', '["pine", "earthy", "spicy"]', 'Named after the cannabis activist, a clear-headed sativa.', 0),
('Gelato', 'gelato', 'hybrid', 'uncommon', 140000, 2, 5, 45, 72, 26.00, 72, 18, 52, 46, 68, 48, '["relaxed", "euphoric", "creative"]', '["sweet", "citrus", "lavender"]', 'A dessert strain with incredible bag appeal.', 0),

-- Rare Strains (3-5 minute grow times)
('Wedding Cake', 'wedding-cake', 'hybrid', 'rare', 180000, 3, 6, 55, 80, 40.00, 80, 15, 58, 42, 75, 52, '["relaxed", "euphoric", "uplifted"]', '["vanilla", "sweet", "earthy"]', 'A premium hybrid with exceptional potency.', 0),
('Zkittlez', 'zkittlez', 'indica', 'rare', 200000, 2, 5, 50, 78, 38.00, 68, 28, 52, 45, 72, 55, '["relaxed", "happy", "creative"]', '["tropical", "berry", "sweet"]', 'Taste the rainbow with this flavorful indica.', 0),
('Runtz', 'runtz', 'hybrid', 'rare', 210000, 2, 5, 55, 82, 45.00, 78, 18, 48, 40, 78, 50, '["euphoric", "giggly", "relaxed"]', '["candy", "tropical", "sweet"]', 'An incredibly rare and sought-after strain.', 0),
('Gorilla Glue #4', 'gg4', 'hybrid', 'rare', 190000, 3, 6, 50, 75, 42.00, 82, 12, 60, 44, 70, 58, '["relaxed", "euphoric", "creative"]', '["earthy", "pine", "diesel"]', 'Named for its sticky resin production.', 0),

-- Epic Strains (5-8 minute grow times)
('Purple Punch', 'purple-punch', 'indica', 'epic', 300000, 3, 7, 65, 88, 75.00, 72, 25, 62, 38, 85, 60, '["relaxed", "sleepy", "happy"]', '["grape", "blueberry", "vanilla"]', 'A knockout indica with dessert flavors.', 0),
('Mimosa', 'mimosa', 'sativa', 'epic', 320000, 2, 6, 60, 85, 70.00, 70, 22, 55, 45, 82, 55, '["uplifted", "energetic", "creative"]', '["citrus", "tropical", "sweet"]', 'Wake and bake perfection.', 0),
('GMO Cookies', 'gmo-cookies', 'indica', 'epic', 350000, 3, 7, 60, 88, 80.00, 85, 15, 58, 35, 88, 52, '["relaxed", "sleepy", "euphoric"]', '["garlic", "diesel", "coffee"]', 'Funky flavors with extreme potency.', 0),

-- Legendary Strains (10-15 minute grow times)
('Alien OG', 'alien-og', 'hybrid', 'legendary', 600000, 4, 8, 75, 95, 150.00, 88, 20, 65, 35, 92, 65, '["euphoric", "relaxed", "creative"]', '["pine", "lemon", "spicy"]', 'An otherworldly hybrid with cosmic effects.', 0),
('The White', 'the-white', 'hybrid', 'legendary', 720000, 3, 7, 78, 98, 175.00, 90, 18, 55, 30, 95, 60, '["relaxed", "euphoric", "uplifted"]', '["earthy", "woody", "pungent"]', 'Covered in so much trichomes it appears white.', 0),
('Pinkman Goo', 'pinkman-goo', 'indica', 'legendary', 900000, 4, 9, 80, 100, 250.00, 92, 25, 70, 28, 98, 70, '["relaxed", "sleepy", "euphoric"]', '["sweet", "berry", "floral"]', 'An extremely rare strain that oozes pink resin.', 0);

-- ============================================
-- SKILL NODES
-- ============================================
INSERT INTO cfx_skill_nodes (skill_key, name, description, category, max_rank, cost_per_rank, effect_type, effect_value_per_rank, requires_level, tree_x, tree_y) VALUES
-- Cultivation Tree
('green_thumb', 'Green Thumb', 'Increases base quality of all plants.', 'cultivation', 5, 1, 'quality_bonus', 0.03, 1, 0, 0),
('speed_growth', 'Speed Growth', 'Reduces grow time for all plants.', 'cultivation', 5, 1, 'grow_speed', 0.05, 1, 1, 0),
('heavy_yield', 'Heavy Yield', 'Increases harvest yield.', 'cultivation', 5, 1, 'yield_bonus', 0.04, 5, 2, 0),
('resilient_plants', 'Resilient Plants', 'Plants take longer to wither.', 'cultivation', 3, 2, 'wither_delay', 0.25, 10, 0, 1),
('master_grower', 'Master Grower', 'All cultivation bonuses increased.', 'cultivation', 3, 3, 'cultivation_multi', 0.10, 20, 1, 1),

-- Business Tree
('haggler', 'Haggler', 'Better NPC sell prices.', 'business', 5, 1, 'sell_bonus', 0.05, 1, 0, 0),
('market_insight', 'Market Insight', 'See market trends before they happen.', 'business', 3, 2, 'market_prediction', 0.10, 10, 1, 0),
('bulk_seller', 'Bulk Seller', 'Sell multiple items at once.', 'business', 1, 3, 'bulk_sell', 1.00, 15, 2, 0),
('investor', 'Investor', 'Earn passive income based on level.', 'business', 5, 2, 'passive_income', 0.02, 20, 0, 1),
('mogul', 'Mogul', 'All income sources increased.', 'business', 3, 3, 'income_multi', 0.10, 30, 1, 1),

-- Genetics Tree
('basic_breeding', 'Basic Breeding', 'Unlock the breeding lab.', 'genetics', 1, 2, 'unlock_breeding', 1.00, 5, 0, 0),
('mutation_chance', 'Mutation Expert', 'Increased chance of beneficial mutations.', 'genetics', 5, 2, 'mutation_bonus', 0.02, 10, 1, 0),
('trait_transfer', 'Trait Transfer', 'Better chance to inherit parent traits.', 'genetics', 3, 2, 'inheritance_bonus', 0.10, 15, 2, 0),
('legendary_potential', 'Legendary Potential', 'Can breed legendary strains.', 'genetics', 1, 5, 'unlock_legendary_breed', 1.00, 25, 0, 1),
('mad_scientist', 'Mad Scientist', 'All breeding bonuses increased.', 'genetics', 3, 3, 'genetics_multi', 0.10, 35, 1, 1),

-- Efficiency Tree
('quick_harvest', 'Quick Harvest', 'Faster harvest animations.', 'efficiency', 3, 1, 'harvest_speed', 0.20, 1, 0, 0),
('auto_water', 'Auto Watering', 'Plants never wither (with water supply).', 'efficiency', 1, 5, 'auto_water', 1.00, 15, 1, 0),
('extra_slots', 'Expansion', 'Unlock additional grow slots.', 'efficiency', 5, 2, 'extra_slots', 1.00, 10, 2, 0),
('harvest_all', 'Harvest All', 'Harvest all ready plants at once.', 'efficiency', 1, 3, 'harvest_all', 1.00, 20, 0, 1),
('bulk_plant', 'Bulk Plant', 'Plant in all empty slots at once.', 'efficiency', 1, 3, 'bulk_plant', 1.00, 25, 1, 1);

-- ============================================
-- QUEST DEFINITIONS
-- ============================================
INSERT INTO cfx_quest_definitions (name, description, quest_type, objective_type, objective_target, reward_cash, reward_xp, min_level) VALUES
-- Daily Quests
('Green Thumb', 'Harvest 5 plants of any type.', 'daily', 'harvest_count', 5, 50.00, 25, 1),
('Cash Flow', 'Sell products worth $100 or more.', 'daily', 'sell_value', 100, 75.00, 50, 1),
('Quality Control', 'Harvest a plant with quality 60 or higher.', 'daily', 'harvest_quality', 60, 100.00, 75, 5),
('Busy Farmer', 'Plant 10 seeds.', 'daily', 'plant_count', 10, 60.00, 30, 1),
('Level Grinder', 'Earn 100 XP today.', 'daily', 'earn_xp', 100, 50.00, 100, 3),

-- Weekly Quests
('Big Haul', 'Harvest 50 plants this week.', 'weekly', 'harvest_count', 50, 500.00, 300, 1),
('Market Mogul', 'Sell products worth $1,000 or more.', 'weekly', 'sell_value', 1000, 750.00, 500, 5),
('Rare Find', 'Harvest a rare or better plant.', 'weekly', 'harvest_rarity', 3, 1000.00, 750, 10),
('Breeding Program', 'Complete 3 breeding operations.', 'weekly', 'breed_count', 3, 800.00, 600, 10),
('Level Up!', 'Gain a level this week.', 'weekly', 'level_up', 1, 300.00, 200, 5),

-- Achievement/Story Quests
('First Harvest', 'Harvest your first plant!', 'achievement', 'harvest_count', 1, 25.00, 50, 1),
('Entrepreneur', 'Make your first sale.', 'achievement', 'sell_count', 1, 50.00, 75, 1),
('Collector', 'Discover 5 different strains.', 'achievement', 'discover_strains', 5, 200.00, 150, 1),
('Geneticist', 'Complete your first breeding.', 'achievement', 'breed_count', 1, 250.00, 200, 5),
('High Roller', 'Have $10,000 cash at once.', 'achievement', 'cash_amount', 10000, 1000.00, 1000, 10);

-- ============================================
-- ACHIEVEMENTS
-- ============================================
INSERT INTO cfx_achievements (achievement_key, name, description, condition_type, condition_value, reward_cash, reward_xp) VALUES
('first_harvest', 'First Harvest', 'Harvest your first plant', 'harvests', 1, 25, 50),
('harvest_10', 'Budding Farmer', 'Harvest 10 plants', 'harvests', 10, 100, 100),
('harvest_100', 'Master Grower', 'Harvest 100 plants', 'harvests', 100, 500, 500),
('harvest_1000', 'Cannabis Baron', 'Harvest 1000 plants', 'harvests', 1000, 2500, 2500),
('level_10', 'Rising Star', 'Reach level 10', 'level', 10, 200, 0),
('level_25', 'Expert Cultivator', 'Reach level 25', 'level', 25, 500, 0),
('level_50', 'Industry Leader', 'Reach level 50', 'level', 50, 2000, 0),
('cash_1k', 'Thousand Dollar Baby', 'Have $1,000 cash', 'cash', 1000, 0, 150),
('cash_10k', 'High Roller', 'Have $10,000 cash', 'cash', 10000, 0, 500),
('cash_100k', 'Mogul', 'Have $100,000 cash', 'cash', 100000, 0, 2000),
('breed_1', 'Geneticist', 'Complete your first breed', 'breeds', 1, 100, 200),
('breed_10', 'Strain Creator', 'Complete 10 breeds', 'breeds', 10, 500, 500),
('prestige_1', 'Reborn', 'Prestige for the first time', 'prestige', 1, 0, 0);

-- ============================================
-- INITIAL MARKET PRICES
-- ============================================
INSERT INTO cfx_market_prices (strain_id, current_price, demand_factor)
SELECT id, base_price, 1.00 FROM cfx_strains;
