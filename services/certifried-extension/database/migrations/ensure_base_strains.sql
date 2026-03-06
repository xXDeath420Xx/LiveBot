-- Ensure all base strains exist
-- This migration adds any missing strains that should have been seeded

-- Common Strains
INSERT IGNORE INTO cfx_strains (name, slug, strain_type, rarity, base_grow_time_ms, base_yield_min, base_yield_max, base_quality_min, base_quality_max, base_price, gene_thc, gene_cbd, gene_yield, gene_speed, gene_quality, gene_resilience, effects, flavors, description, is_starter) VALUES
('Northern Lights', 'northern-lights', 'indica', 'common', 60000, 2, 4, 30, 60, 15.00, 55, 30, 50, 55, 50, 60, '["relaxed", "sleepy", "happy"]', '["earthy", "pine", "sweet"]', 'A classic indica known for relaxation and easy growing.', 1),
('Blue Dream', 'blue-dream', 'hybrid', 'common', 75000, 2, 5, 35, 65, 18.00, 60, 25, 55, 50, 55, 50, '["creative", "euphoric", "uplifted"]', '["blueberry", "sweet", "berry"]', 'A legendary hybrid with balanced effects.', 1),
('Sour Diesel', 'sour-diesel', 'sativa', 'common', 90000, 1, 4, 30, 55, 16.00, 65, 15, 45, 45, 50, 45, '["energetic", "euphoric", "focused"]', '["diesel", "citrus", "pungent"]', 'A fast-acting sativa with energizing effects.', 1),
('OG Kush', 'og-kush', 'hybrid', 'common', 80000, 2, 4, 35, 60, 17.00, 70, 20, 50, 48, 55, 55, '["relaxed", "happy", "euphoric"]', '["earthy", "pine", "woody"]', 'The backbone of countless hybrid strains.', 1);

-- Uncommon Strains
INSERT IGNORE INTO cfx_strains (name, slug, strain_type, rarity, base_grow_time_ms, base_yield_min, base_yield_max, base_quality_min, base_quality_max, base_price, gene_thc, gene_cbd, gene_yield, gene_speed, gene_quality, gene_resilience, effects, flavors, description, is_starter) VALUES
('Girl Scout Cookies', 'gsc', 'hybrid', 'uncommon', 120000, 2, 5, 45, 70, 25.00, 75, 20, 50, 45, 65, 50, '["euphoric", "relaxed", "creative"]', '["sweet", "cookie", "minty"]', 'A potent hybrid with dessert-like flavors.', 0),
('Granddaddy Purple', 'granddaddy-purple', 'indica', 'uncommon', 135000, 2, 5, 40, 68, 23.00, 65, 25, 55, 42, 60, 60, '["relaxed", "sleepy", "happy"]', '["grape", "berry", "sweet"]', 'A famous purple-hued indica with grape flavors.', 0),
('Jack Herer', 'jack-herer', 'sativa', 'uncommon', 150000, 1, 4, 40, 65, 22.00, 65, 30, 45, 50, 58, 55, '["creative", "energetic", "uplifted"]', '["pine", "earthy", "spicy"]', 'Named after the cannabis activist, a clear-headed sativa.', 0),
('Gelato', 'gelato', 'hybrid', 'uncommon', 140000, 2, 5, 45, 72, 26.00, 72, 18, 52, 46, 68, 48, '["relaxed", "euphoric", "creative"]', '["sweet", "citrus", "lavender"]', 'A dessert strain with incredible bag appeal.', 0),
('White Widow', 'white-widow', 'hybrid', 'uncommon', 110000, 2, 5, 40, 65, 20.00, 60, 25, 50, 52, 55, 55, '["euphoric", "relaxed", "creative"]', '["earthy", "woody", "pungent"]', 'A Dutch classic known for frosty trichomes.', 0),
('Gorilla Glue', 'gorilla-glue', 'hybrid', 'uncommon', 125000, 2, 5, 45, 68, 24.00, 78, 15, 55, 48, 62, 52, '["relaxed", "euphoric", "happy"]', '["earthy", "pine", "diesel"]', 'Named for its sticky resin production.', 0);

-- Rare Strains
INSERT IGNORE INTO cfx_strains (name, slug, strain_type, rarity, base_grow_time_ms, base_yield_min, base_yield_max, base_quality_min, base_quality_max, base_price, gene_thc, gene_cbd, gene_yield, gene_speed, gene_quality, gene_resilience, effects, flavors, description, is_starter) VALUES
('Wedding Cake', 'wedding-cake', 'hybrid', 'rare', 180000, 3, 6, 55, 80, 40.00, 80, 15, 58, 42, 75, 52, '["relaxed", "euphoric", "uplifted"]', '["vanilla", "sweet", "earthy"]', 'A premium hybrid with exceptional potency.', 0),
('Zkittlez', 'zkittlez', 'indica', 'rare', 200000, 2, 5, 50, 78, 38.00, 68, 28, 52, 45, 72, 55, '["relaxed", "happy", "creative"]', '["tropical", "berry", "sweet"]', 'Taste the rainbow with this flavorful indica.', 0),
('Runtz', 'runtz', 'hybrid', 'rare', 210000, 2, 5, 55, 82, 45.00, 78, 18, 48, 40, 78, 50, '["euphoric", "giggly", "relaxed"]', '["candy", "tropical", "sweet"]', 'An incredibly rare and sought-after strain.', 0),
('Gorilla Glue #4', 'gg4', 'hybrid', 'rare', 190000, 3, 6, 50, 75, 42.00, 82, 12, 60, 44, 70, 58, '["relaxed", "euphoric", "creative"]', '["earthy", "pine", "diesel"]', 'The original sticky icky.', 0),
('Purple Punch', 'purple-punch', 'indica', 'rare', 195000, 2, 5, 52, 78, 40.00, 72, 25, 55, 45, 75, 58, '["relaxed", "sleepy", "happy"]', '["grape", "blueberry", "vanilla"]', 'A knockout indica with dessert flavors.', 0),
('GDP', 'gdp', 'indica', 'rare', 185000, 2, 5, 50, 76, 38.00, 70, 22, 52, 46, 72, 60, '["relaxed", "sleepy", "happy"]', '["grape", "berry", "sweet"]', 'Granddaddy Purple - the OG purple strain.', 0);

-- Epic Strains
INSERT IGNORE INTO cfx_strains (name, slug, strain_type, rarity, base_grow_time_ms, base_yield_min, base_yield_max, base_quality_min, base_quality_max, base_price, gene_thc, gene_cbd, gene_yield, gene_speed, gene_quality, gene_resilience, effects, flavors, description, is_starter) VALUES
('Mimosa', 'mimosa', 'sativa', 'epic', 320000, 2, 6, 60, 85, 70.00, 70, 22, 55, 45, 82, 55, '["uplifted", "energetic", "creative"]', '["citrus", "tropical", "sweet"]', 'Wake and bake perfection.', 0),
('GMO Cookies', 'gmo-cookies', 'indica', 'epic', 350000, 3, 7, 60, 88, 80.00, 85, 15, 58, 35, 88, 52, '["relaxed", "sleepy", "euphoric"]', '["garlic", "diesel", "coffee"]', 'Funky flavors with extreme potency.', 0),
('Gary Payton', 'gary-payton', 'hybrid', 'epic', 300000, 3, 6, 62, 86, 75.00, 82, 18, 56, 42, 85, 55, '["euphoric", "relaxed", "creative"]', '["gas", "spicy", "herbal"]', 'Cookies collab with the NBA legend.', 0),
('Biscotti', 'biscotti', 'indica', 'epic', 310000, 3, 6, 58, 84, 72.00, 78, 20, 54, 44, 82, 58, '["relaxed", "euphoric", "happy"]', '["sweet", "cookie", "diesel"]', 'Italian dessert terps from the Cookie family.', 0);

-- Legendary Strains
INSERT IGNORE INTO cfx_strains (name, slug, strain_type, rarity, base_grow_time_ms, base_yield_min, base_yield_max, base_quality_min, base_quality_max, base_price, gene_thc, gene_cbd, gene_yield, gene_speed, gene_quality, gene_resilience, effects, flavors, description, is_starter) VALUES
('Alien OG', 'alien-og', 'hybrid', 'legendary', 600000, 4, 8, 75, 95, 150.00, 88, 20, 65, 35, 92, 65, '["euphoric", "relaxed", "creative"]', '["pine", "lemon", "spicy"]', 'An otherworldly hybrid with cosmic effects.', 0),
('The White', 'the-white', 'hybrid', 'legendary', 720000, 3, 7, 78, 98, 175.00, 90, 18, 55, 30, 95, 60, '["relaxed", "euphoric", "uplifted"]', '["earthy", "woody", "pungent"]', 'Covered in so much trichomes it appears white.', 0),
('Pinkman Goo', 'pinkman-goo', 'indica', 'legendary', 900000, 4, 9, 80, 100, 250.00, 92, 25, 70, 28, 98, 70, '["relaxed", "sleepy", "euphoric"]', '["sweet", "berry", "floral"]', 'An extremely rare strain that oozes pink resin.', 0),
('Ghost Train Haze', 'ghost-train-haze', 'sativa', 'legendary', 650000, 3, 7, 72, 94, 160.00, 95, 12, 58, 32, 90, 55, '["energetic", "euphoric", "creative"]', '["citrus", "floral", "sweet"]', 'Extreme potency warning. Mind-bending sativa.', 0),
('Bruce Banner', 'bruce-banner', 'hybrid', 'legendary', 680000, 4, 8, 74, 96, 165.00, 93, 15, 62, 34, 92, 62, '["euphoric", "creative", "uplifted"]', '["diesel", "sweet", "berry"]', 'Smash your expectations. Incredible THC levels.', 0);

-- Initialize market prices for new strains (using schema-correct columns)
INSERT IGNORE INTO cfx_market_prices (strain_id, current_price, price_24h_ago, demand_factor, supply_count)
SELECT id, base_price, base_price, 1.00, 0
FROM cfx_strains s
WHERE NOT EXISTS (SELECT 1 FROM cfx_market_prices mp WHERE mp.strain_id = s.id);
