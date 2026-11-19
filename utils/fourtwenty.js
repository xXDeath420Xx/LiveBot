/**
 * 4:20 world clock — the zone list and the math, shared by the /420 OBS overlay
 * (rendered into the page) and the self-updating Discord panel.
 *
 * Zones cover every UTC offset in use on every day of the year (DST included:
 * a DST city leaves its standard offset for months, so each offset also has a
 * city that never shifts). tests/fourtwenty-zones.test.js enforces this.
 * Zones span every UTC offset so a 4:20 is never far away. IANA names
 * mean Intl handles DST; we only ever read each zone's real wall clock.
 */

export const ZONES = [
    { tz: 'Pacific/Kiritimati',  label: 'Kiritimati, Kiribati',  flag: '🇰🇮' },
    { tz: 'Pacific/Tongatapu',   label: 'Nukuʻalofa, Tonga',     flag: '🇹🇴' },
    { tz: 'Pacific/Auckland',    label: 'Auckland, New Zealand', flag: '🇳🇿' },
    { tz: 'Pacific/Chatham',     label: 'Chatham Islands',       flag: '🇳🇿' },
    { tz: 'Pacific/Fiji',        label: 'Suva, Fiji',            flag: '🇫🇯' },
    { tz: 'Pacific/Noumea',      label: 'Nouméa, New Caledonia', flag: '🇳🇨' },
    { tz: 'Australia/Lord_Howe', label: 'Lord Howe Island',      flag: '🇦🇺' },
    { tz: 'Australia/Sydney',    label: 'Sydney, Australia',     flag: '🇦🇺' },
    { tz: 'Australia/Brisbane',  label: 'Brisbane, Australia',   flag: '🇦🇺' },
    { tz: 'Australia/Adelaide',  label: 'Adelaide, Australia',   flag: '🇦🇺' },
    { tz: 'Australia/Darwin',    label: 'Darwin, Australia',     flag: '🇦🇺' },
    { tz: 'Asia/Tokyo',          label: 'Tokyo, Japan',          flag: '🇯🇵' },
    { tz: 'Asia/Seoul',          label: 'Seoul, South Korea',    flag: '🇰🇷' },
    { tz: 'Australia/Eucla',     label: 'Eucla, Australia',      flag: '🇦🇺' },
    { tz: 'Asia/Shanghai',       label: 'Shanghai, China',       flag: '🇨🇳' },
    { tz: 'Asia/Singapore',      label: 'Singapore',             flag: '🇸🇬' },
    { tz: 'Asia/Bangkok',        label: 'Bangkok, Thailand',     flag: '🇹🇭' },
    { tz: 'Asia/Yangon',         label: 'Yangon, Myanmar',       flag: '🇲🇲' },
    { tz: 'Asia/Dhaka',          label: 'Dhaka, Bangladesh',     flag: '🇧🇩' },
    { tz: 'Asia/Kathmandu',      label: 'Kathmandu, Nepal',      flag: '🇳🇵' },
    { tz: 'Asia/Kolkata',        label: 'Mumbai, India',         flag: '🇮🇳' },
    { tz: 'Asia/Karachi',        label: 'Karachi, Pakistan',     flag: '🇵🇰' },
    { tz: 'Asia/Kabul',          label: 'Kabul, Afghanistan',    flag: '🇦🇫' },
    { tz: 'Asia/Dubai',          label: 'Dubai, UAE',            flag: '🇦🇪' },
    { tz: 'Asia/Tehran',         label: 'Tehran, Iran',          flag: '🇮🇷' },
    { tz: 'Europe/Moscow',       label: 'Moscow, Russia',        flag: '🇷🇺' },
    { tz: 'Africa/Nairobi',      label: 'Nairobi, Kenya',        flag: '🇰🇪' },
    { tz: 'Europe/Athens',       label: 'Athens, Greece',        flag: '🇬🇷' },
    { tz: 'Europe/Paris',        label: 'Paris, France',         flag: '🇫🇷' },
    { tz: 'Europe/London',       label: 'London, UK',            flag: '🇬🇧' },
    { tz: 'Atlantic/Reykjavik',  label: 'Reykjavík, Iceland',    flag: '🇮🇸' },
    { tz: 'Atlantic/Cape_Verde', label: 'Cape Verde',            flag: '🇨🇻' },
    { tz: 'America/Noronha',     label: 'Fernando de Noronha',   flag: '🇧🇷' },
    { tz: 'America/Sao_Paulo',   label: 'São Paulo, Brazil',     flag: '🇧🇷' },
    { tz: 'America/St_Johns',    label: "St. John's, Canada",    flag: '🇨🇦' },
    { tz: 'America/Puerto_Rico', label: 'San Juan, Puerto Rico', flag: '🇵🇷' },
    { tz: 'America/New_York',    label: 'New York, USA',         flag: '🇺🇸' },
    { tz: 'America/Chicago',     label: 'Chicago, USA',          flag: '🇺🇸' },
    { tz: 'America/Denver',      label: 'Denver, USA',           flag: '🇺🇸' },
    { tz: 'America/Los_Angeles', label: 'Los Angeles, USA',      flag: '🇺🇸' },
    { tz: 'America/Anchorage',   label: 'Anchorage, USA',        flag: '🇺🇸' },
    { tz: 'Pacific/Gambier',     label: 'Gambier Islands',       flag: '🇵🇫' },
    { tz: 'Pacific/Marquesas',   label: 'Marquesas Islands',     flag: '🇵🇫' },
    { tz: 'Pacific/Honolulu',    label: 'Honolulu, Hawaii',      flag: '🇺🇸' },
    { tz: 'Pacific/Pago_Pago',   label: 'Pago Pago, Samoa',      flag: '🇦🇸' },
    { tz: 'Pacific/Niue',        label: 'Niue',                  flag: '🇳🇺' }
];

const AM = 4 * 3600 + 20 * 60;   // 04:20:00
const PM = 16 * 3600 + 20 * 60;  // 16:20:00
const DAY = 86400;

const fmtCache = new Map();
function fmt(tz) {
    let f = fmtCache.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        fmtCache.set(tz, f);
    }
    return f;
}

function secondsOfDay(tz, date) {
    let h = 0, m = 0, s = 0;
    for (const p of fmt(tz).formatToParts(date)) {
        if (p.type === 'hour') h = parseInt(p.value, 10);
        else if (p.type === 'minute') m = parseInt(p.value, 10);
        else if (p.type === 'second') s = parseInt(p.value, 10);
    }
    if (h === 24) h = 0;
    return h * 3600 + m * 60 + s;
}

/**
 * Where the world stands right now.
 *   lit      zones currently inside their 4:20 minute   [{ zone, ap }]
 *   upcoming every zone's NEXT 4:20, soonest first      [{ zone, ap, at }]   at = unix seconds
 *   last     the zone that most recently hit 4:20       { zone, ap, at }
 * A zone that is lit appears in `upcoming` with its following 4:20 (~12h out).
 */
export function snapshot(now = Date.now()) {
    const nowSec = Math.floor(now / 1000);
    const date = new Date(nowSec * 1000);
    const lit = [], upcoming = [];
    let last = null;

    for (const zone of ZONES) {
        let sod;
        try { sod = secondsOfDay(zone.tz, date); } catch { continue; }

        if (sod >= AM && sod < AM + 60) lit.push({ zone, ap: 'AM' });
        else if (sod >= PM && sod < PM + 60) lit.push({ zone, ap: 'PM' });

        const dAM = (AM - sod + DAY) % DAY || DAY;
        const dPM = (PM - sod + DAY) % DAY || DAY;
        upcoming.push(dAM <= dPM
            ? { zone, ap: 'AM', at: nowSec + dAM }
            : { zone, ap: 'PM', at: nowSec + dPM });

        const sAM = (sod - AM + DAY) % DAY, sPM = (sod - PM + DAY) % DAY;
        const since = Math.min(sAM, sPM);
        if (!last || since < nowSec - last.at) {
            last = { zone, ap: sAM <= sPM ? 'AM' : 'PM', at: nowSec - since };
        }
    }

    upcoming.sort((a, b) => a.at - b.at);
    return { now: nowSec, lit, upcoming, last };
}
