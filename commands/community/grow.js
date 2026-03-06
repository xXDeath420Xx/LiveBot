import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import * as handlers from './grow-handlers.js';
import * as reminderHandlers from './grow-reminder-handler.js';
import * as statsHandlers from './grow-stats-handler.js';
import * as journalHandlers from './grow-journal-handler.js';

// VPD Chart data (Temperature °F vs Humidity %)
const VPD_CHART = {
    65: { 40: 0.73, 50: 0.55, 60: 0.37, 70: 0.18, 80: 0.00 },
    70: { 40: 0.88, 50: 0.67, 60: 0.46, 70: 0.25, 80: 0.04 },
    75: { 40: 1.05, 50: 0.81, 60: 0.57, 70: 0.33, 80: 0.09 },
    80: { 40: 1.25, 50: 0.97, 60: 0.70, 70: 0.42, 80: 0.14 },
    85: { 40: 1.47, 50: 1.16, 60: 0.85, 70: 0.53, 80: 0.22 }
};

// Nutrient deficiency data
const DEFICIENCIES = {
    nitrogen: { name: 'Nitrogen (N)', symptoms: 'Yellowing of lower/older leaves, starting from tips. Leaves may fall off. Slow growth, pale green color overall.', causes: 'Insufficient nitrogen in feed, pH lockout, overwatering', fix: 'Increase N in feeding schedule. Check pH (soil: 6.0-7.0, hydro: 5.5-6.5). Ensure proper drainage.', color: 0xFFFF00 },
    phosphorus: { name: 'Phosphorus (P)', symptoms: 'Dark green or purple/red stems and leaves. Brown spots on leaves. Slow growth, delayed flowering.', causes: 'Cold temperatures, pH lockout, insufficient P in feed', fix: 'Add phosphorus supplement. Ensure temps above 60°F. Check pH.', color: 0x800080 },
    potassium: { name: 'Potassium (K)', symptoms: 'Brown/burnt leaf edges and tips. Yellowing between veins. Weak stems.', causes: 'pH lockout, salt buildup, insufficient K in feed', fix: 'Flush medium, add potassium supplement. Check pH.', color: 0x8B4513 },
    calcium: { name: 'Calcium (Ca)', symptoms: 'Brown spots on new growth. Curled/distorted new leaves. Stunted growth.', causes: 'Low pH, using RO/distilled water without cal-mag, humidity issues', fix: 'Add cal-mag supplement. Raise pH if too low. Check humidity.', color: 0xD2691E },
    magnesium: { name: 'Magnesium (Mg)', symptoms: 'Yellowing between veins on older leaves (interveinal chlorosis). Green veins with yellow leaves.', causes: 'pH lockout, excess potassium, cold roots', fix: 'Add Epsom salt (1 tsp/gallon) or cal-mag. Check pH.', color: 0x32CD32 },
    iron: { name: 'Iron (Fe)', symptoms: 'Yellowing of new growth with green veins. Bright yellow/white new leaves.', causes: 'High pH, overwatering, cold temperatures', fix: 'Lower pH. Add iron supplement. Improve drainage.', color: 0xC0C0C0 }
};

// Feed charts for popular brands
const FEED_CHARTS = {
    foxfarm: { name: 'Fox Farm Trio', url: 'https://foxfarm.com/feeding-schedules', veg: '**Week 1:** Big Bloom 2 TBS per gallon\n**Week 2-3:** Grow Big 2-3tsp + Big Bloom 2 TBS per gallon\n**Week 4:** Grow Big 3tsp + Big Bloom 2 TBS per gallon', flower: '**Week 1-2:** Tiger Bloom 2tsp + Big Bloom 1 TBS per gallon\n**Week 3-6:** Grow Big 2tsp + Tiger Bloom 2tsp + Big Bloom 1 TBS per gallon\n**Week 7+:** Tiger Bloom 2tsp + Big Bloom 1 TBS per gallon\n*Start at 1/2 strength in FFOF soil!*' },
    generalhydro: { name: 'General Hydroponics Flora Series', url: 'https://generalhydroponics.com/resources/flora-series-feedcharts/', veg: '**Seedling:** 2.5ml Micro + 2.5ml Gro + 2.5ml Bloom per gallon\n**Early Veg:** 5ml Micro + 5ml Gro + 2.5ml Bloom per gallon\n**Late Veg:** 6ml Micro + 10ml Gro + 3ml Bloom per gallon\n*Always add Micro first!*', flower: '**Early Flower:** 6ml Micro + 6ml Gro + 10ml Bloom per gallon\n**Mid Flower:** 6ml Micro + 3ml Gro + 12ml Bloom per gallon\n**Late Flower:** 6ml Micro + 0ml Gro + 15-20ml Bloom per gallon\n**Lucas Formula:** 0-8-16 (Micro-Bloom only)' },
    advancednutrients: { name: 'Advanced Nutrients pH Perfect', url: 'https://www.advancednutrients.com/feeding-chart/', veg: '**Veg:** 4ml Micro + 4ml Gro + 4ml Bloom per liter\nAdd B-52, Voodoo Juice as directed\n*pH Perfect = auto-adjusts pH!*', flower: '**Flower:** 4ml Micro + 4ml Gro + 4ml Bloom per liter\nAdd Big Bud weeks 2-4, Overdrive weeks 5-6\nFlush last week' },
    jacks: { name: "Jack's 321", url: 'https://www.growweedeasy.com/wp-content/uploads/2022/10/jacks-nutrients-321-schedule-for-growing-cannabis.pdf', veg: '**Full Strength:** 3g Part A + 2g Part B + 1g Epsom per gallon\n**Seedling (50%):** 1.5g Part A + 1g Part B + 0.5g Epsom per gallon\n*Mix order: Part A → Epsom → Part B (important!)*', flower: '**Same 3-2-1 ratio throughout!**\nSome growers increase to 4-2-1 in flower for PK boost\n*Simple, effective, budget-friendly!*' },
    athena: { name: 'Athena Pro Line', url: 'https://support.athenaag.com/hc/en-us/articles/17190427112859-Pro-Line-Feed-Schedules', veg: '**Clone:** Pro Grow 4.9g + Pro Core 2.9g + Cleanse 1ml per gallon (EC 2.0)\n**Veg:** Pro Grow 7.7g + Pro Core 4.6g + Cleanse 2-5ml per gallon (EC 3.0)\n**pH:** 5.8-6.2 (Coco/RW) | 6.0-6.4 (Peat)', flower: '**Flower W1-7:** Pro Bloom 7.7g + Pro Core 4.6g + Cleanse 2-5ml per gallon (EC 3.0)\n**Fade W8-9:** Pro Bloom 7.7g + Fade 19ml per gallon (swap Core for Fade)\n**Flush:** RO + Cleanse 10ml/gal, last 3 days (coco) or last day (RW)' },
    cropsalt: { name: 'CropSalt', url: 'https://cropsalt.com/pages/grow-documents-1', veg: '**Seedling:** 1.53g Veg A + 1.03g Veg B per gallon\n**Veg (through Day 21 of Flower):** 4.6g Veg A + 3.1g Veg B per gallon\n**EC Target:** 2.2-2.3 (same EC start to finish!)\n*No cal-mag needed - properly formulated*', flower: '**Bloom (Day 22 - Week 7):** 5.1g Bloom A + 2.6g Bloom B per gallon\n**Cake Finisher (Last 14 days):** 3g Cake per gallon\n*Cake has no nitrogen - locks out N during finish for color/terps*\n**EC Target:** 2.2-2.3' },
    canna: { name: 'CANNA Coco', url: 'https://www.cannagardening.com/sites/united_states/files/2024-02/downloads-grow-schedule-coco.pdf', veg: '**Seedling:** 0.5-1ml A + 0.5-1ml B per liter (EC 0.6-1.0)\n**Veg:** 2-3ml A + 2-3ml B per liter + Rhizotonic\n**EC Target:** 1.3-1.7 | **pH:** 5.8-6.0', flower: '**Early Flower:** 2.5-3ml A + 2.5-3ml B per liter\n**Mid Flower:** 3-4ml A + 3-4ml B + PK 13/14 + Boost per liter\n**EC Target:** 1.8-2.2\n*Official chart has high doses - start at 50%!*' },
    biobizz: { name: 'BioBizz Organic', url: 'https://biobizz.com/wp-content/uploads/2025/05/Nutrient-Schedule-EN-PF-2025.pdf', veg: '**Week 1-2:** Bio-Grow 1ml + Root-Juice 2ml per liter\n**Week 3-4:** Bio-Grow 2-4ml + Root-Juice 2ml + Bio-Heaven 2ml per liter', flower: '**Week 1-2:** Bio-Grow 1ml + Bio-Bloom 1-2ml + Top-Max 1ml per liter\n**Week 3-6:** Bio-Bloom 3-4ml + Top-Max 3-4ml + Bio-Heaven 3ml per liter\n**Week 7+:** Bio-Bloom 4ml + Top-Max 4ml per liter\n*100% Organic - no pH adjustment needed in soil!*' },
    houseandgarden: { name: 'House & Garden', url: 'https://house-garden.us/feeding-schedules/', veg: '**Week 1:** A+B 5ml each per gallon + Root Excelurator\n**Week 2-4:** A+B 8-10ml each per gallon\n**EC Target:** 1.2-1.8 | *Always equal parts A & B*', flower: '**Week 1-2:** A+B 10-12ml each + Bud XL per gallon\n**Week 3-5:** A+B 15-17ml each + Top Booster per gallon\n**Week 6-7:** A+B 12ml each + Shooting Powder per gallon\n**EC Target:** 2.0-2.8' },
    floraflex: { name: 'FloraFlex Nutrients', url: 'https://www.floraflex.com/pages/feed-chart', veg: '**Seedling:** V1 + V2 at 2-3g each per gallon (EC 0.8-1.2)\n**Veg:** V1 + V2 at 3g each per gallon (EC 1.5-1.8)\n*Mix V1 first, let dissolve, then V2*', flower: '**Flower:** B1 + B2 at 3g each per gallon (EC 1.6-2.2)\n*B1 contains calcium - no cal-mag needed*\nAdd Bulky B or Full Tilt for boost\n**pH:** 5.3-6.3' },
    megacrop: { name: 'Greenleaf MegaCrop', url: 'https://greenleafnutrients.com/mega-crop-1-part-calculator/', veg: '**Seedling:** 1-2g per gallon\n**Veg:** 3-4g per gallon\nOne-part powder! Add Sweet Candy 1g/gal optional', flower: '**Early Flower:** 4-6g MegaCrop per gallon\n**Mid Flower:** 3-4g MegaCrop + 1-2g Bud Explosion per gallon\n**Late Flower:** 2-3g MegaCrop + 2-3g Bud Explosion per gallon\n*Budget-friendly & effective!*' },
    botanicare: { name: 'Botanicare Kind', url: 'https://www.botanicare.com/', veg: '**Seedling:** Base 5ml + Grow 2ml per gallon\n**Veg:** Base 10ml + Grow 5-10ml per gallon\nAdd Cal-Mag 5ml/gal if using RO/coco', flower: '**Early Flower:** Base 10ml + Bloom 5ml per gallon\n**Mid Flower:** Base 15ml + Bloom 10-15ml per gallon\n**Late Flower:** Reduce by 50%, flush last week\n**pH:** 5.5-6.5' }
};

// Light cycle recommendations
const LIGHT_CYCLES = {
    seedling: { hours: '18/6 or 20/4', ppfd: '200-400', dli: '12-18', notes: 'Keep lights higher, seedlings are sensitive' },
    veg: { hours: '18/6', ppfd: '400-600', dli: '25-40', notes: 'Some growers use 24/0 but plants benefit from dark period' },
    flower: { hours: '12/12', ppfd: '600-900', dli: '40-50', notes: 'Uninterrupted dark period is critical!' },
    auto_seedling: { hours: '20/4 or 18/6', ppfd: '200-400', dli: '15-20', notes: 'Autos can handle more light early' },
    auto_veg: { hours: '20/4 or 18/6', ppfd: '400-700', dli: '30-45', notes: 'No need to change light cycle' },
    auto_flower: { hours: '20/4 or 18/6', ppfd: '600-900', dli: '40-55', notes: 'More light = more yield with autos' }
};

export default {
    category: 'community',
    data: new SlashCommandBuilder()
        .setName('grow')
        .setDescription('Complete growing toolkit - calculators, database, timers, and more')
        // ===== TOOLS SUBCOMMAND GROUP =====
        .addSubcommandGroup(group =>
            group.setName('tools')
                .setDescription('Growing calculators and reference guides')
                .addSubcommand(sub => sub.setName('vpd').setDescription('Calculate Vapor Pressure Deficit')
                    .addIntegerOption(opt => opt.setName('temp').setDescription('Temperature in °F').setRequired(true).setMinValue(50).setMaxValue(100))
                    .addIntegerOption(opt => opt.setName('humidity').setDescription('Relative Humidity %').setRequired(true).setMinValue(20).setMaxValue(90)))
                .addSubcommand(sub => sub.setName('dli').setDescription('Calculate Daily Light Integral')
                    .addIntegerOption(opt => opt.setName('ppfd').setDescription('PPFD (μmol/m²/s)').setRequired(true).setMinValue(50).setMaxValue(2000))
                    .addIntegerOption(opt => opt.setName('hours').setDescription('Hours of light per day').setRequired(true).setMinValue(1).setMaxValue(24)))
                .addSubcommand(sub => sub.setName('deficiency').setDescription('Diagnose nutrient deficiencies')
                    .addStringOption(opt => opt.setName('nutrient').setDescription('Which deficiency').setRequired(true)
                        .addChoices({ name: 'Nitrogen (N)', value: 'nitrogen' }, { name: 'Phosphorus (P)', value: 'phosphorus' }, { name: 'Potassium (K)', value: 'potassium' }, { name: 'Calcium (Ca)', value: 'calcium' }, { name: 'Magnesium (Mg)', value: 'magnesium' }, { name: 'Iron (Fe)', value: 'iron' })))
                .addSubcommand(sub => sub.setName('feedchart').setDescription('View feeding schedules')
                    .addStringOption(opt => opt.setName('brand').setDescription('Nutrient brand').setRequired(true)
                        .addChoices({ name: 'Athena Pro Line', value: 'athena' }, { name: 'BioBizz Organic', value: 'biobizz' }, { name: 'Botanicare Kind', value: 'botanicare' }, { name: 'CANNA Coco', value: 'canna' }, { name: 'CropSalt', value: 'cropsalt' }, { name: 'FloraFlex', value: 'floraflex' }, { name: 'Fox Farm Trio', value: 'foxfarm' }, { name: 'General Hydroponics', value: 'generalhydro' }, { name: 'MegaCrop', value: 'megacrop' }, { name: 'House & Garden', value: 'houseandgarden' }, { name: "Jack's 321", value: 'jacks' }, { name: 'Advanced Nutrients', value: 'advancednutrients' })))
                .addSubcommand(sub => sub.setName('lightcycle').setDescription('Recommended light schedules')
                    .addStringOption(opt => opt.setName('stage').setDescription('Growth stage').setRequired(true)
                        .addChoices({ name: 'Seedling (Photo)', value: 'seedling' }, { name: 'Vegetative (Photo)', value: 'veg' }, { name: 'Flowering (Photo)', value: 'flower' }, { name: 'Seedling (Auto)', value: 'auto_seedling' }, { name: 'Veg (Auto)', value: 'auto_veg' }, { name: 'Flower (Auto)', value: 'auto_flower' })))
                .addSubcommand(sub => sub.setName('flush').setDescription('Pre-harvest flushing guide'))
                .addSubcommand(sub => sub.setName('drying').setDescription('Drying and curing best practices'))
                .addSubcommand(sub => sub.setName('tip').setDescription('Get a random grow tip')
                    .addStringOption(opt => opt.setName('category').setDescription('Specific category')
                        .addChoices({ name: 'Watering', value: 'watering' }, { name: 'Nutrients', value: 'nutrients' }, { name: 'Environment', value: 'environment' }, { name: 'Lighting', value: 'lighting' }, { name: 'Training', value: 'training' }, { name: 'Harvest', value: 'harvest' }, { name: 'Drying', value: 'drying' }, { name: 'Curing', value: 'curing' }, { name: 'pH', value: 'ph' }, { name: 'Genetics', value: 'genetics' }))))
        // ===== STRAIN SUBCOMMAND GROUP =====
        .addSubcommandGroup(group =>
            group.setName('strain')
                .setDescription('Community strain database')
                .addSubcommand(sub => sub.setName('add').setDescription('Add a strain to the database')
                    .addStringOption(opt => opt.setName('name').setDescription('Strain name').setRequired(true))
                    .addStringOption(opt => opt.setName('breeder').setDescription('Breeder/Seed bank').setRequired(true))
                    .addStringOption(opt => opt.setName('type').setDescription('Type').setRequired(true).addChoices({ name: 'Indica', value: 'indica' }, { name: 'Sativa', value: 'sativa' }, { name: 'Hybrid', value: 'hybrid' }, { name: 'Indica Dominant', value: 'indica_dominant' }, { name: 'Sativa Dominant', value: 'sativa_dominant' }))
                    .addIntegerOption(opt => opt.setName('flower_days').setDescription('Flowering time in days').setRequired(true).setMinValue(30).setMaxValue(150))
                    .addIntegerOption(opt => opt.setName('difficulty').setDescription('Grow difficulty 1-5').setRequired(true).setMinValue(1).setMaxValue(5))
                    .addStringOption(opt => opt.setName('effects').setDescription('Effects'))
                    .addStringOption(opt => opt.setName('flavors').setDescription('Flavors/terpenes'))
                    .addStringOption(opt => opt.setName('thc').setDescription('THC percentage range'))
                    .addStringOption(opt => opt.setName('notes').setDescription('Your grow notes/tips')))
                .addSubcommand(sub => sub.setName('search').setDescription('Search for a strain')
                    .addStringOption(opt => opt.setName('query').setDescription('Strain name to search').setRequired(true)))
                .addSubcommand(sub => sub.setName('info').setDescription('Get detailed strain info')
                    .addIntegerOption(opt => opt.setName('id').setDescription('Strain ID').setRequired(true)))
                .addSubcommand(sub => sub.setName('random').setDescription('Get a random strain suggestion'))
                .addSubcommand(sub => sub.setName('top').setDescription('View recently added strains')))
        // ===== SEEDBANK SUBCOMMAND GROUP =====
        .addSubcommandGroup(group =>
            group.setName('seedbank')
                .setDescription('Community seed bank directory')
                .addSubcommand(sub => sub.setName('add').setDescription('Add a seed bank')
                    .addStringOption(opt => opt.setName('name').setDescription('Seed bank name').setRequired(true))
                    .addStringOption(opt => opt.setName('website').setDescription('Website URL').setRequired(true))
                    .addStringOption(opt => opt.setName('ships_to').setDescription('Where they ship').setRequired(true))
                    .addIntegerOption(opt => opt.setName('rating').setDescription('Your rating 1-5').setRequired(true).setMinValue(1).setMaxValue(5))
                    .addStringOption(opt => opt.setName('payment').setDescription('Payment methods'))
                    .addStringOption(opt => opt.setName('notes').setDescription('Your experience/notes')))
                .addSubcommand(sub => sub.setName('list').setDescription('List all seed banks'))
                .addSubcommand(sub => sub.setName('search').setDescription('Search for a seed bank')
                    .addStringOption(opt => opt.setName('query').setDescription('Search by name').setRequired(true)))
                .addSubcommand(sub => sub.setName('info').setDescription('Get seed bank details')
                    .addIntegerOption(opt => opt.setName('id').setDescription('Seed bank ID').setRequired(true))))
        // ===== TIMER SUBCOMMAND GROUP =====
        .addSubcommandGroup(group =>
            group.setName('timer')
                .setDescription('Track your grow from seed to harvest')
                .addSubcommand(sub => sub.setName('start').setDescription('Start tracking a new grow')
                    .addStringOption(opt => opt.setName('strain').setDescription('Strain name').setRequired(true))
                    .addStringOption(opt => opt.setName('stage').setDescription('Current stage').setRequired(true).addChoices({ name: 'Seedling', value: 'seedling' }, { name: 'Vegetative', value: 'veg' }, { name: 'Flowering', value: 'flower' }))
                    .addIntegerOption(opt => opt.setName('flower_days').setDescription('Expected flowering time in days').setMinValue(30).setMaxValue(150)))
                .addSubcommand(sub => sub.setName('flip').setDescription('Mark your plant as flipped to flower')
                    .addIntegerOption(opt => opt.setName('grow_id').setDescription('Grow ID').setRequired(true)))
                .addSubcommand(sub => sub.setName('status').setDescription('Check status of your grows'))
                .addSubcommand(sub => sub.setName('update').setDescription('Update grow stage')
                    .addIntegerOption(opt => opt.setName('grow_id').setDescription('Grow ID').setRequired(true))
                    .addStringOption(opt => opt.setName('stage').setDescription('New stage').setRequired(true).addChoices({ name: 'Seedling', value: 'seedling' }, { name: 'Vegetative', value: 'veg' }, { name: 'Flowering', value: 'flower' }, { name: 'Harvested', value: 'harvest' }, { name: 'Complete/Cured', value: 'complete' })))
                .addSubcommand(sub => sub.setName('end').setDescription('End/remove a grow timer')
                    .addIntegerOption(opt => opt.setName('grow_id').setDescription('Grow ID to remove').setRequired(true))))
        // ===== CALC SUBCOMMAND GROUP =====
        .addSubcommandGroup(group =>
            group.setName('calc')
                .setDescription('Equipment calculators')
                .addSubcommand(sub => sub.setName('tent').setDescription('Calculate equipment for your tent size')
                    .addStringOption(opt => opt.setName('size').setDescription('Tent dimensions (e.g., 4x4)').setRequired(true)))
                .addSubcommand(sub => sub.setName('cfm').setDescription('Calculate exhaust fan CFM needed')
                    .addIntegerOption(opt => opt.setName('length').setDescription('Tent length in feet').setRequired(true).setMinValue(1).setMaxValue(20))
                    .addIntegerOption(opt => opt.setName('width').setDescription('Tent width in feet').setRequired(true).setMinValue(1).setMaxValue(20))
                    .addIntegerOption(opt => opt.setName('height').setDescription('Tent height in feet').setRequired(true).setMinValue(3).setMaxValue(12))
                    .addBooleanOption(opt => opt.setName('carbon_filter').setDescription('Using a carbon filter?'))
                    .addBooleanOption(opt => opt.setName('hps_lights').setDescription('Using HPS/HID lights?')))
                .addSubcommand(sub => sub.setName('light').setDescription('Calculate light coverage and wattage')
                    .addIntegerOption(opt => opt.setName('sqft').setDescription('Grow area in square feet').setRequired(true).setMinValue(1).setMaxValue(100))
                    .addStringOption(opt => opt.setName('light_type').setDescription('Type of light').setRequired(true).addChoices({ name: 'LED (Modern)', value: 'led' }, { name: 'HPS/HID', value: 'hps' }, { name: 'CMH/LEC', value: 'cmh' }, { name: 'Fluorescent', value: 'fluoro' })))
                .addSubcommand(sub => sub.setName('pot').setDescription('Calculate pot size for your grow style')
                    .addStringOption(opt => opt.setName('medium').setDescription('Growing medium').setRequired(true).addChoices({ name: 'Soil', value: 'soil' }, { name: 'Coco Coir', value: 'coco' }, { name: 'Hydro', value: 'hydro' }))
                    .addStringOption(opt => opt.setName('style').setDescription('Training style').setRequired(true).addChoices({ name: 'SOG', value: 'sog' }, { name: 'Natural', value: 'natural' }, { name: 'LST/Topped', value: 'lst' }, { name: 'SCROG', value: 'scrog' }))
                    .addIntegerOption(opt => opt.setName('veg_weeks').setDescription('Planned veg time in weeks').setMinValue(1).setMaxValue(16)))
                .addSubcommand(sub => sub.setName('yield').setDescription('Estimate potential yield')
                    .addIntegerOption(opt => opt.setName('watts').setDescription('Total light wattage').setRequired(true).setMinValue(50).setMaxValue(5000))
                    .addStringOption(opt => opt.setName('light_type').setDescription('Type of light').setRequired(true).addChoices({ name: 'LED (Quality)', value: 'led_good' }, { name: 'LED (Budget)', value: 'led_budget' }, { name: 'HPS', value: 'hps' }, { name: 'CMH/LEC', value: 'cmh' }))
                    .addStringOption(opt => opt.setName('skill').setDescription('Your experience level').setRequired(true).addChoices({ name: 'First Grow', value: 'beginner' }, { name: 'A Few Grows', value: 'intermediate' }, { name: 'Experienced', value: 'advanced' }))))
        // ===== MENTOR SUBCOMMAND GROUP =====
        .addSubcommandGroup(group =>
            group.setName('mentor')
                .setDescription('Grow mentor system')
                .addSubcommand(sub => sub.setName('register').setDescription('Register as a mentor')
                    .addStringOption(opt => opt.setName('specialties').setDescription('Your specialties').setRequired(true)))
                .addSubcommand(sub => sub.setName('list').setDescription('List available mentors'))
                .addSubcommand(sub => sub.setName('find').setDescription('Find a mentor for your needs')
                    .addStringOption(opt => opt.setName('topic').setDescription('What do you need help with?').setRequired(true)))
                .addSubcommand(sub => sub.setName('status').setDescription('Toggle your availability as a mentor'))
                .addSubcommand(sub => sub.setName('unregister').setDescription('Remove yourself as a mentor')))
        // ===== COMPETITION SUBCOMMAND GROUP =====
        .addSubcommandGroup(group =>
            group.setName('competition')
                .setDescription('Grow photo competitions')
                .addSubcommand(sub => sub.setName('create').setDescription('Create a new competition (Mod only)')
                    .addStringOption(opt => opt.setName('title').setDescription('Competition title').setRequired(true))
                    .addIntegerOption(opt => opt.setName('days').setDescription('Duration in days').setRequired(true).setMinValue(1).setMaxValue(30))
                    .addStringOption(opt => opt.setName('description').setDescription('Competition description/rules')))
                .addSubcommand(sub => sub.setName('enter').setDescription('Enter the current competition')
                    .addAttachmentOption(opt => opt.setName('photo').setDescription('Your entry photo').setRequired(true))
                    .addStringOption(opt => opt.setName('description').setDescription('Description of your entry')))
                .addSubcommand(sub => sub.setName('view').setDescription('View current competition'))
                .addSubcommand(sub => sub.setName('entries').setDescription('View all entries'))
                .addSubcommand(sub => sub.setName('end').setDescription('End competition and announce winner (Mod only)')))
        // ===== REMINDER SUBCOMMAND GROUP =====
        .addSubcommandGroup(group =>
            group.setName('reminder')
                .setDescription('Grow-related reminders')
                .addSubcommand(sub => sub.setName('set').setDescription('Set a new grow reminder')
                    .addStringOption(opt => opt.setName('type').setDescription('Type of reminder').setRequired(true)
                        .addChoices({ name: 'Water Plants', value: 'water' }, { name: 'Feed/Nutrients', value: 'feed' }, { name: 'Check Plants', value: 'check' }, { name: 'Defoliate', value: 'defoliate' }, { name: 'Training (LST/HST)', value: 'train' }, { name: 'Flip to Flower', value: 'flip' }, { name: 'Harvest Check', value: 'harvest' }, { name: 'Custom', value: 'custom' }))
                    .addStringOption(opt => opt.setName('time').setDescription('When to remind (e.g., "2h", "1d", "3d 6h")').setRequired(true))
                    .addStringOption(opt => opt.setName('repeat').setDescription('Repeat interval')
                        .addChoices({ name: 'Every 12 hours', value: '12' }, { name: 'Every day', value: '24' }, { name: 'Every 2 days', value: '48' }, { name: 'Every 3 days', value: '72' }, { name: 'Every week', value: '168' }, { name: 'No repeat', value: '0' }))
                    .addStringOption(opt => opt.setName('message').setDescription('Custom message (required for custom type)'))
                    .addBooleanOption(opt => opt.setName('dm').setDescription('Send reminder via DM'))
                    .addIntegerOption(opt => opt.setName('journal').setDescription('Link to a specific journal')))
                .addSubcommand(sub => sub.setName('list').setDescription('View your active reminders'))
                .addSubcommand(sub => sub.setName('delete').setDescription('Delete a reminder')
                    .addIntegerOption(opt => opt.setName('id').setDescription('Reminder ID to delete').setRequired(true)))
                .addSubcommand(sub => sub.setName('pause').setDescription('Pause/unpause a reminder')
                    .addIntegerOption(opt => opt.setName('id').setDescription('Reminder ID').setRequired(true)))
                .addSubcommand(sub => sub.setName('snooze').setDescription('Snooze a reminder')
                    .addIntegerOption(opt => opt.setName('id').setDescription('Reminder ID').setRequired(true))
                    .addStringOption(opt => opt.setName('duration').setDescription('How long to snooze').setRequired(true)
                        .addChoices({ name: '1 hour', value: '1' }, { name: '2 hours', value: '2' }, { name: '6 hours', value: '6' }, { name: '12 hours', value: '12' }, { name: '1 day', value: '24' }))))
        // ===== STATS SUBCOMMAND GROUP =====
        .addSubcommandGroup(group =>
            group.setName('stats')
                .setDescription('Community grow statistics and leaderboards')
                .addSubcommand(sub => sub.setName('community').setDescription('View overall community grow statistics'))
                .addSubcommand(sub => sub.setName('leaderboard').setDescription('View grow leaderboards')
                    .addStringOption(opt => opt.setName('type').setDescription('Leaderboard type').setRequired(true)
                        .addChoices({ name: 'Most Active Growers', value: 'active' }, { name: 'Most Grows Completed', value: 'completed' }, { name: 'Best Harvests', value: 'harvests' }, { name: 'Most Journal Entries', value: 'entries' }, { name: 'Top Traders', value: 'traders' })))
                .addSubcommand(sub => sub.setName('strains').setDescription('View popular strains in the community'))
                .addSubcommand(sub => sub.setName('personal').setDescription('View personal grow statistics')
                    .addUserOption(opt => opt.setName('user').setDescription('View another user\'s stats')))
                .addSubcommand(sub => sub.setName('trends').setDescription('View growing trends and insights')))
        // ===== JOURNAL SUBCOMMAND GROUP =====
        .addSubcommandGroup(group =>
            group.setName('journal')
                .setDescription('Manage your grow journals')
                .addSubcommand(sub => sub.setName('create').setDescription('Start a new grow journal')
                    .addStringOption(opt => opt.setName('title').setDescription('Name for this grow (e.g., "Winter 2024 Grow")').setRequired(true))
                    .addStringOption(opt => opt.setName('strain').setDescription('Strain name').setRequired(true))
                    .addStringOption(opt => opt.setName('medium').setDescription('Growing medium').setRequired(true)
                        .addChoices({ name: 'Soil', value: 'soil' }, { name: 'Coco Coir', value: 'coco' }, { name: 'Hydroponics', value: 'hydro' }, { name: 'DWC (Deep Water Culture)', value: 'dwc' }, { name: 'Aeroponics', value: 'aero' }, { name: 'Other', value: 'other' }))
                    .addStringOption(opt => opt.setName('type').setDescription('Indoor or outdoor grow').setRequired(true)
                        .addChoices({ name: 'Indoor', value: 'indoor' }, { name: 'Outdoor', value: 'outdoor' }, { name: 'Greenhouse', value: 'greenhouse' }))
                    .addStringOption(opt => opt.setName('breeder').setDescription('Breeder/seed bank')))
                .addSubcommand(sub => sub.setName('log').setDescription('Add a daily log entry')
                    .addIntegerOption(opt => opt.setName('journal_id').setDescription('Journal ID (use /grow journal list to see IDs)')))
                .addSubcommand(sub => sub.setName('list').setDescription('View your grow journals')
                    .addUserOption(opt => opt.setName('user').setDescription('View another user\'s public journals')))
                .addSubcommand(sub => sub.setName('view').setDescription('View a specific journal')
                    .addIntegerOption(opt => opt.setName('journal_id').setDescription('Journal ID').setRequired(true)))
                .addSubcommand(sub => sub.setName('stage').setDescription('Update the current growth stage')
                    .addIntegerOption(opt => opt.setName('journal_id').setDescription('Journal ID').setRequired(true))
                    .addStringOption(opt => opt.setName('stage').setDescription('New growth stage').setRequired(true)
                        .addChoices({ name: 'Germination', value: 'germination' }, { name: 'Seedling', value: 'seedling' }, { name: 'Vegetative', value: 'vegetative' }, { name: 'Transition', value: 'transition' }, { name: 'Flowering', value: 'flowering' }, { name: 'Harvest', value: 'harvest' }, { name: 'Curing', value: 'cure' }, { name: 'Complete', value: 'complete' })))
                .addSubcommand(sub => sub.setName('milestone').setDescription('Record a milestone')
                    .addIntegerOption(opt => opt.setName('journal_id').setDescription('Journal ID').setRequired(true))
                    .addStringOption(opt => opt.setName('type').setDescription('Milestone type').setRequired(true)
                        .addChoices({ name: 'Germination (seed cracked)', value: 'germination' }, { name: 'First True Leaves', value: 'first_leaves' }, { name: 'Transplant', value: 'transplant' }, { name: 'Topped', value: 'topped' }, { name: 'LST Started', value: 'lst_started' }, { name: 'Flipped to Flower (12/12)', value: 'flip_to_flower' }, { name: 'First Pistils/Pre-flower', value: 'first_pistils' }, { name: 'Trichomes Cloudy', value: 'trichomes_cloudy' }, { name: 'Harvest Day', value: 'harvest' }, { name: 'Dry Complete', value: 'dry_complete' }, { name: 'Cure Started', value: 'cure_start' }))
                    .addStringOption(opt => opt.setName('notes').setDescription('Notes about this milestone')))
                .addSubcommand(sub => sub.setName('privacy').setDescription('Toggle journal visibility')
                    .addIntegerOption(opt => opt.setName('journal_id').setDescription('Journal ID').setRequired(true)))
                .addSubcommand(sub => sub.setName('complete').setDescription('Mark a grow as complete with final stats')
                    .addIntegerOption(opt => opt.setName('journal_id').setDescription('Journal ID').setRequired(true))
                    .addStringOption(opt => opt.setName('wet_weight').setDescription('Wet weight at harvest (e.g., "500g")'))
                    .addStringOption(opt => opt.setName('dry_weight').setDescription('Dry weight after cure (e.g., "100g")')))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        // Route to appropriate handler based on group
        switch (group) {
            case 'tools':
                switch (subcommand) {
                    case 'vpd': await handleVPD(interaction); break;
                    case 'dli': await handleDLI(interaction); break;
                    case 'deficiency': await handleDeficiency(interaction); break;
                    case 'feedchart': await handleFeedChart(interaction); break;
                    case 'lightcycle': await handleLightCycle(interaction); break;
                    case 'flush': await handleFlush(interaction); break;
                    case 'drying': await handleDrying(interaction); break;
                    case 'tip': await handlers.handleTip(interaction); break;
                }
                break;
            case 'strain':
                switch (subcommand) {
                    case 'add': await handlers.handleStrainAdd(interaction); break;
                    case 'search': await handlers.handleStrainSearch(interaction); break;
                    case 'info': await handlers.handleStrainInfo(interaction); break;
                    case 'random': await handlers.handleStrainRandom(interaction); break;
                    case 'top': await handlers.handleStrainTop(interaction); break;
                }
                break;
            case 'seedbank':
                switch (subcommand) {
                    case 'add': await handlers.handleSeedbankAdd(interaction); break;
                    case 'list': await handlers.handleSeedbankList(interaction); break;
                    case 'search': await handlers.handleSeedbankSearch(interaction); break;
                    case 'info': await handlers.handleSeedbankInfo(interaction); break;
                }
                break;
            case 'timer':
                switch (subcommand) {
                    case 'start': await handlers.handleTimerStart(interaction); break;
                    case 'flip': await handlers.handleTimerFlip(interaction); break;
                    case 'status': await handlers.handleTimerStatus(interaction); break;
                    case 'update': await handlers.handleTimerUpdate(interaction); break;
                    case 'end': await handlers.handleTimerEnd(interaction); break;
                }
                break;
            case 'calc':
                switch (subcommand) {
                    case 'tent': await handlers.handleCalcTent(interaction); break;
                    case 'cfm': await handlers.handleCalcCfm(interaction); break;
                    case 'light': await handlers.handleCalcLight(interaction); break;
                    case 'pot': await handlers.handleCalcPot(interaction); break;
                    case 'yield': await handlers.handleCalcYield(interaction); break;
                }
                break;
            case 'mentor':
                switch (subcommand) {
                    case 'register': await handlers.handleMentorRegister(interaction); break;
                    case 'list': await handlers.handleMentorList(interaction); break;
                    case 'find': await handlers.handleMentorFind(interaction); break;
                    case 'status': await handlers.handleMentorStatus(interaction); break;
                    case 'unregister': await handlers.handleMentorUnregister(interaction); break;
                }
                break;
            case 'competition':
                switch (subcommand) {
                    case 'create': await handlers.handleCompetitionCreate(interaction); break;
                    case 'enter': await handlers.handleCompetitionEnter(interaction); break;
                    case 'view': await handlers.handleCompetitionView(interaction); break;
                    case 'entries': await handlers.handleCompetitionEntries(interaction); break;
                    case 'end': await handlers.handleCompetitionEnd(interaction); break;
                }
                break;
            case 'reminder':
                switch (subcommand) {
                    case 'set': await reminderHandlers.handleReminderSet(interaction); break;
                    case 'list': await reminderHandlers.handleReminderList(interaction); break;
                    case 'delete': await reminderHandlers.handleReminderDelete(interaction); break;
                    case 'pause': await reminderHandlers.handleReminderPause(interaction); break;
                    case 'snooze': await reminderHandlers.handleReminderSnooze(interaction); break;
                }
                break;
            case 'stats':
                switch (subcommand) {
                    case 'community': await statsHandlers.handleStatsCommunity(interaction); break;
                    case 'leaderboard': await statsHandlers.handleStatsLeaderboard(interaction); break;
                    case 'strains': await statsHandlers.handleStatsStrains(interaction); break;
                    case 'personal': await statsHandlers.handleStatsPersonal(interaction); break;
                    case 'trends': await statsHandlers.handleStatsTrends(interaction); break;
                }
                break;
            case 'journal':
                switch (subcommand) {
                    case 'create': await journalHandlers.handleCreate(interaction); break;
                    case 'log': await journalHandlers.handleLog(interaction); break;
                    case 'list': await journalHandlers.handleList(interaction); break;
                    case 'view': await journalHandlers.handleView(interaction); break;
                    case 'stage': await journalHandlers.handleStage(interaction); break;
                    case 'milestone': await journalHandlers.handleMilestone(interaction); break;
                    case 'privacy': await journalHandlers.handlePrivacy(interaction); break;
                    case 'complete': await journalHandlers.handleComplete(interaction); break;
                }
                break;
        }
    }
};

// ===== LOCAL TOOL HANDLERS =====
async function handleVPD(interaction) {
    const temp = interaction.options.getInteger('temp');
    const humidity = interaction.options.getInteger('humidity');
    const leafTemp = temp - 2;
    const tempC = (leafTemp - 32) * 5/9;
    const svp = 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
    const vpd = svp * (1 - humidity / 100);

    let status, color, recommendation;
    if (vpd < 0.4) { status = 'TOO LOW'; color = 0x3498DB; recommendation = 'Risk of mold/mildew. Increase temperature or decrease humidity.'; }
    else if (vpd < 0.8) { status = 'IDEAL FOR SEEDLINGS/CLONES'; color = 0x2ECC71; recommendation = 'Perfect for early growth stages.'; }
    else if (vpd < 1.2) { status = 'IDEAL FOR VEG'; color = 0x27AE60; recommendation = 'Optimal range for vegetative growth.'; }
    else if (vpd < 1.6) { status = 'IDEAL FOR FLOWER'; color = 0x16A085; recommendation = 'Perfect for flowering stage.'; }
    else { status = 'TOO HIGH'; color = 0xE74C3C; recommendation = 'Plant stress! Decrease temperature or increase humidity.'; }

    const embed = new EmbedBuilder().setColor(color).setTitle('VPD Calculator')
        .addFields(
            { name: 'Temperature', value: `${temp}°F`, inline: true },
            { name: 'Humidity', value: `${humidity}%`, inline: true },
            { name: 'VPD', value: `**${vpd.toFixed(2)} kPa**`, inline: true },
            { name: 'Status', value: status, inline: false },
            { name: 'Recommendation', value: recommendation, inline: false },
            { name: 'Ideal Ranges', value: '• Seedlings/Clones: 0.4-0.8 kPa\n• Veg: 0.8-1.2 kPa\n• Flower: 1.2-1.6 kPa', inline: false }
        ).setFooter({ text: 'VPD = Vapor Pressure Deficit' });
    await interaction.reply({ embeds: [embed] });
}

async function handleDLI(interaction) {
    const ppfd = interaction.options.getInteger('ppfd');
    const hours = interaction.options.getInteger('hours');
    const dli = (ppfd * hours * 3600) / 1000000;

    let status, color, recommendation;
    if (dli < 15) { status = 'TOO LOW'; color = 0xE74C3C; recommendation = 'Plants will stretch. Increase light intensity or duration.'; }
    else if (dli < 25) { status = 'LOW - OK FOR SEEDLINGS'; color = 0xF39C12; recommendation = 'Good for seedlings and clones.'; }
    else if (dli < 40) { status = 'GOOD FOR VEG'; color = 0x2ECC71; recommendation = 'Solid range for vegetative growth.'; }
    else if (dli < 55) { status = 'IDEAL FOR FLOWER'; color = 0x27AE60; recommendation = 'Optimal for flowering. Maximum yields!'; }
    else { status = 'TOO HIGH'; color = 0xE74C3C; recommendation = 'Risk of light burn. Reduce intensity.'; }

    const embed = new EmbedBuilder().setColor(color).setTitle('DLI Calculator')
        .addFields(
            { name: 'PPFD', value: `${ppfd} μmol/m²/s`, inline: true },
            { name: 'Light Hours', value: `${hours} hours`, inline: true },
            { name: 'DLI', value: `**${dli.toFixed(1)} mol/m²/day**`, inline: true },
            { name: 'Status', value: status, inline: false },
            { name: 'Recommendation', value: recommendation, inline: false },
            { name: 'Target DLI', value: '• Seedlings: 15-20\n• Veg: 25-40\n• Flower: 40-55', inline: false }
        ).setFooter({ text: 'DLI = Daily Light Integral' });
    await interaction.reply({ embeds: [embed] });
}

async function handleDeficiency(interaction) {
    const nutrient = interaction.options.getString('nutrient');
    const def = DEFICIENCIES[nutrient];
    const embed = new EmbedBuilder().setColor(def.color).setTitle(`${def.name} Deficiency`)
        .addFields(
            { name: 'Symptoms', value: def.symptoms, inline: false },
            { name: 'Common Causes', value: def.causes, inline: false },
            { name: 'How to Fix', value: def.fix, inline: false }
        ).setFooter({ text: 'Always check pH first - most deficiencies are caused by pH lockout!' });
    await interaction.reply({ embeds: [embed] });
}

async function handleFeedChart(interaction) {
    const brand = interaction.options.getString('brand');
    const chart = FEED_CHARTS[brand];
    const embed = new EmbedBuilder().setColor(0x2ECC71).setTitle(`${chart.name} Feed Schedule`)
        .addFields(
            { name: 'Vegetative', value: chart.veg, inline: false },
            { name: 'Flowering', value: chart.flower, inline: false }
        ).setFooter({ text: 'Start at 1/4 strength for seedlings. Always check pH!' });
    if (chart.url) { embed.setURL(chart.url).addFields({ name: 'Full Schedule', value: `[View Official Chart](${chart.url})`, inline: false }); }
    await interaction.reply({ embeds: [embed] });
}

async function handleLightCycle(interaction) {
    const stage = interaction.options.getString('stage');
    const cycle = LIGHT_CYCLES[stage];
    const isAuto = stage.startsWith('auto_');
    const embed = new EmbedBuilder().setColor(0xF1C40F).setTitle(`Light Schedule: ${stage.replace('auto_', 'Auto ').replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}`)
        .addFields(
            { name: 'Light Cycle', value: cycle.hours, inline: true },
            { name: 'Target PPFD', value: `${cycle.ppfd} μmol/m²/s`, inline: true },
            { name: 'Target DLI', value: `${cycle.dli} mol/m²/day`, inline: true },
            { name: 'Notes', value: cycle.notes, inline: false }
        ).setFooter({ text: isAuto ? 'Autoflowers flower based on age, not light cycle' : 'Photoperiods need 12/12 to trigger flowering' });
    await interaction.reply({ embeds: [embed] });
}

async function handleFlush(interaction) {
    const embed = new EmbedBuilder().setColor(0x3498DB).setTitle('Pre-Harvest Flush Guide')
        .setDescription('Flushing removes excess nutrients for smoother smoke.')
        .addFields(
            { name: 'When to Flush', value: '• **Soil:** Last 1-2 weeks\n• **Coco:** Last 5-7 days\n• **Hydro:** Last 3-5 days', inline: false },
            { name: 'Harvest Readiness Signs', value: '• 70-90% pistils brown/orange\n• Trichomes milky white\n• Some amber for body effect', inline: false },
            { name: 'How to Flush', value: '• Use plain pH\'d water only\n• Run 2-3x container volume through\n• Continue until runoff PPM < 200', inline: false }
        ).setFooter({ text: 'Some growers skip flushing - results vary!' });
    await interaction.reply({ embeds: [embed] });
}

async function handleDrying(interaction) {
    const embed = new EmbedBuilder().setColor(0x8B4513).setTitle('Drying & Curing Guide')
        .setDescription('Proper drying and curing is crucial for quality!')
        .addFields(
            { name: 'Drying Conditions', value: '• **Temp:** 60-70°F\n• **Humidity:** 55-65% RH\n• **Duration:** 7-14 days', inline: false },
            { name: 'Ready to Cure When', value: '• Small stems snap (not bend)\n• Outside feels dry, slightly crispy\n• Buds spring back when squeezed', inline: false },
            { name: 'Curing Process', value: '• Place in mason jars (fill 75%)\n• **Week 1:** Burp 2-3x daily\n• **Week 2-4:** Burp 1x daily\n• Ideal cure: 4-8 weeks minimum', inline: false },
            { name: 'Target Cure Humidity', value: '58-62% RH in jars (Boveda 62 packs)', inline: false }
        ).setFooter({ text: 'Patience pays off - well-cured buds are worth the wait!' });
    await interaction.reply({ embeds: [embed] });
}
