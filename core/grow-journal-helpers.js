// Pure helpers for /grow journal (commands/community/grow-journal-handler.js). No DB/Discord imports.
//
// The log modal collects free text ("Temp: 75-80F, RH: 55-60%, VPD: 1.2", "1 gal, pH 6.2, EC 1.4");
// these turn it into the structured journal_entries columns. Every value is range-checked against
// what its column can hold, because the database runs STRICT_TRANS_TABLES: an out-of-range number
// would fail the whole INSERT and lose the user's log entry. The raw feeding text is always kept in
// journal_entries.nutrients_used, so nothing the user typed is lost when a value is dropped here.

const NUM = '(\\d+(?:\\.\\d+)?)';

function inRange(value, min, max) {
    return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/**
 * Journal stages (grow_journals.current_stage — the /grow journal stage choices) mapped onto
 * journal_entries.stage, whose ENUM uses shorter names and has no 'complete'.
 */
const ENTRY_STAGE = {
    germination: 'germination',
    seedling: 'seedling',
    vegetative: 'veg',
    transition: 'transition',
    flowering: 'flower',
    harvest: 'harvest',
    cure: 'cure',
    complete: 'cure'
};

export function entryStageFor(journalStage) {
    return ENTRY_STAGE[journalStage] || 'seedling';
}

/** journal_entries.stage values that differ from the journal stage keys, for display lookups. */
const DISPLAY_STAGE = { veg: 'vegetative', flower: 'flowering' };

export function displayStageKey(stage) {
    return DISPLAY_STAGE[stage] || stage;
}

/**
 * "Temp: 75-80F, RH: 55-60%, VPD: 1.2" → temp_high/low (decimal(4,1)), humidity_high/low (int), vpd (decimal(4,2)).
 */
export function parseEnvironment(text) {
    const out = { tempHigh: null, tempLow: null, humidityHigh: null, humidityLow: null, vpd: null };
    if (!text) return out;

    const temp = text.match(new RegExp(`temp(?:erature)?[:\\s]*${NUM}\\s*°?\\s*[fc]?\\s*(?:[-–]\\s*${NUM})?`, 'i'));
    if (temp) {
        const a = parseFloat(temp[1]);
        const b = temp[2] !== undefined ? parseFloat(temp[2]) : a;
        out.tempLow = inRange(Math.min(a, b), 0, 200);
        out.tempHigh = inRange(Math.max(a, b), 0, 200);
    }

    const rh = text.match(new RegExp(`(?:\\brh|humidity)[:\\s]*${NUM}\\s*%?\\s*(?:[-–]\\s*${NUM})?`, 'i'));
    if (rh) {
        const a = Math.round(parseFloat(rh[1]));
        const b = rh[2] !== undefined ? Math.round(parseFloat(rh[2])) : a;
        out.humidityLow = inRange(Math.min(a, b), 0, 100);
        out.humidityHigh = inRange(Math.max(a, b), 0, 100);
    }

    const vpd = text.match(new RegExp(`vpd[:\\s]*${NUM}`, 'i'));
    if (vpd) out.vpd = inRange(parseFloat(vpd[1]), 0, 10);

    return out;
}

/**
 * "1 gal, pH 6.2, EC 1.4, CalMag 2ml/gal" → ph_in (decimal(3,1)), ec_ppm (int), watered (tinyint).
 *
 * journal_entries stores nutrient strength as ppm. A PPM reading is used as-is; an EC reading is
 * converted on the 500 scale (1.0 mS/cm = 500 ppm; a value above 10 is taken as µS/cm). The raw
 * text — including the original EC figure — is stored alongside in nutrients_used.
 */
export function parseFeeding(text) {
    const out = { phIn: null, ecPpm: null, watered: 0 };
    if (!text || !text.trim()) return out;

    // The field is "Feeding/Watering": filling it in means the plant was watered or fed.
    out.watered = 1;

    const ph = text.match(new RegExp(`\\bph[:\\s]*${NUM}`, 'i'));
    if (ph) out.phIn = inRange(parseFloat(ph[1]), 0, 14);

    const ppm = text.match(new RegExp(`${NUM}\\s*ppm\\b`, 'i')) || text.match(new RegExp(`\\bppm[:\\s]*${NUM}`, 'i'));
    if (ppm) {
        out.ecPpm = inRange(Math.round(parseFloat(ppm[1])), 0, 100000);
    } else {
        const ec = text.match(new RegExp(`\\bec[:\\s]*${NUM}`, 'i'));
        if (ec) {
            const value = parseFloat(ec[1]);
            const ppmValue = value <= 10 ? value * 500 : value * 0.5;
            out.ecPpm = inRange(Math.round(ppmValue), 0, 100000);
        }
    }

    return out;
}

/** Plant height in cm (journal_entries.height_cm, decimal(6,1)). "45", "45cm", "45.5 cm" → number, else null. */
export function parseHeight(text) {
    if (!text) return null;
    const m = String(text).match(new RegExp(`^\\s*${NUM}\\s*(?:cm)?\\s*$`, 'i'));
    return m ? inRange(parseFloat(m[1]), 0, 10000) : null;
}

const GRAMS_PER = { g: 1, gram: 1, grams: 1, kg: 1000, kgs: 1000, oz: 28.3495, ozs: 28.3495, lb: 453.592, lbs: 453.592 };

/**
 * Harvest weight → grams for grow_harvest_stats.wet_weight_grams / dry_weight_grams (decimal(10,2)).
 * Accepts "500", "500g", "500 grams", "1.2kg", "3 oz", "1.5 lbs". A bare number is grams.
 * @returns {{ ok: boolean, grams: number|null }} ok=false when text was given but can't be read.
 */
export function parseWeightGrams(text) {
    if (text === null || text === undefined || String(text).trim() === '') return { ok: true, grams: null };
    const m = String(text).trim().match(new RegExp(`^${NUM}\\s*(g|grams?|kgs?|ozs?|lbs?)?\\.?$`, 'i'));
    if (!m) return { ok: false, grams: null };
    const unit = (m[2] || 'g').toLowerCase();
    const grams = Math.round(parseFloat(m[1]) * GRAMS_PER[unit] * 100) / 100;
    if (!(grams > 0) || grams >= 1e8) return { ok: false, grams: null };
    return { ok: true, grams };
}
