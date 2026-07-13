/**
 * Migration 090: OwO catalog seed data.
 *
 * Seeds the 5 global catalog tables from upstream's public data dump:
 *   animals_rank: 14 rows
 *   animals: 20 rows
 *   weapon: 22 rows
 *   weapon_passive: 21 rows
 *   gem: 35 rows
 *
 * INSERT IGNORE so re-runs are safe. Only populates global catalogs — never
 * touches per-guild user state.
 *
 * See LICENSE-OWO-NOTICE.md.
 */

const STATEMENTS = [
  "INSERT IGNORE INTO `owo_animals_rank` VALUES ('bot'),('common'),('cpatreon'),('distorted'),('epic'),('fabled'),('gem'),('hidden'),('legendary'),('mythical'),('patreon'),('rare'),('special'),('uncommon');",
  "INSERT IGNORE INTO `owo_animals` VALUES (':bee:','common',1,5,2,3,3,1,'How do bees go to school?\\n~   On the school buzz!','bee,wasp'),(':beetle:','common',4,2,2,3,2,2,'Are they all female?','beetle,ladybug'),(':bug:','common',3,2,2,4,2,2,'It\\'s a worm.','bug,worm,caterpillar'),(':butterfly:','common',1,1,1,5,5,2,'Why did you throw butter out the window?\\n~ To see a butter fly!','butterfly'),(':snail:','common',8,1,2,3,5,1,'The slowest animal, but the toughest in the zoo','snail,slug'),(':crocodile:','epic',3,4,4,2,1,4,'How do you tell the difference between an alligator and an crocodile?\\n~ You will see one later and one in a while','crocodile,alligator'),(':elephant:','epic',5,5,3,1,1,3,'They don\\'t actually eat peanuts','elephant'),(':penguin:','epic',2,1,2,6,5,2,'The birds that can\\'t fly','penguin'),(':tiger2:','epic',4,6,2,1,3,2,'Just a very large kitty','tiger,tiger2,cheetah'),(':whale:','epic',7,1,3,1,2,4,'whale, whale, whale, look what we have here','whale'),(':cat2:','rare',3,1,1,6,3,3,'They shoot lazers.','cat,cat2,kitty,kitten'),(':cow2:','rare',5,4,3,1,1,3,'Some say that they are highly sought-after','cow,cow2'),(':dog2:','rare',4,6,3,1,1,2,'Very loyal and protective','dog,dog2,doggy,puppy,wolf'),(':pig2:','rare',4,2,3,2,2,4,'aka ur mum','pig,pig2'),(':sheep:','rare',5,2,2,3,1,4,'Tastes like cotten candy!','sheep,ram,goat'),(':baby_chick:','uncommon',3,2,3,3,3,2,'chirp chirp! It\\'s so cute!','chick,baby_chick'),(':chipmunk:','uncommon',3,5,2,3,2,1,'Don\\'t mess with them.','chipmunk,squirrel'),(':mouse2:','uncommon',3,3,2,3,3,2,'~~sqeak~~ squeak!','mouse,mouse2,rat'),(':rabbit2:','uncommon',3,4,2,3,2,2,'There\\'s a ton of them.','rabbit,rabbit2,bunny'),(':rooster:','uncommon',3,4,3,2,2,2,'The alarm cluck','chicken,rooster');",
  "INSERT IGNORE INTO `owo_weapon` VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14),(15),(16),(17),(18),(19),(20),(21),(22);",
  "INSERT IGNORE INTO `owo_weapon_passive` VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14),(15),(16),(17),(18),(19),(20),(21);",
  "INSERT IGNORE INTO `owo_gem` VALUES ('cgem1','multi'),('cgem2','patreon'),('cgem3','empow'),('cgem4','lucky'),('cgem5','special'),('egem1','multi'),('egem2','patreon'),('egem3','empow'),('egem4','lucky'),('egem5','special'),('fgem1','multi'),('fgem2','patreon'),('fgem3','empow'),('fgem4','lucky'),('fgem5','special'),('lgem1','multi'),('lgem2','patreon'),('lgem3','empow'),('lgem4','lucky'),('lgem5','special'),('mgem1','multi'),('mgem2','patreon'),('mgem3','empow'),('mgem4','lucky'),('mgem5','special'),('rgem1','multi'),('rgem2','patreon'),('rgem3','empow'),('rgem4','lucky'),('rgem5','special'),('ugem1','multi'),('ugem2','patreon'),('ugem3','empow'),('ugem4','lucky'),('ugem5','special');"
];

export async function up(db) {
    for (const stmt of STATEMENTS) {
        await db.execute(stmt);
    }
}

export async function down(db) {
    // Safe: only deletes catalog rows. User zoo data in owo_animal lives
    // in a different table and is unaffected.
    await db.execute('DELETE FROM `owo_animals`');
    await db.execute('DELETE FROM `owo_animals_rank`');
    await db.execute('DELETE FROM `owo_weapon_passive`');
    await db.execute('DELETE FROM `owo_weapon`');
    await db.execute('DELETE FROM `owo_gem`');
}
