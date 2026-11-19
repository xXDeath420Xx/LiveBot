// Number and time formatting, the same everywhere: $940, $1.2k, $3.4M; "4 m 20 s", "1 h 20 m".

function compact(n) {
    const abs = Math.abs(n);
    const fmt = (v, unit) => {
        const digits = v < 10 ? 1 : v < 100 ? 1 : 0;
        return `${Number(v.toFixed(digits))}${unit}`;
    };
    if (abs < 1000) return String(Math.round(n));
    if (abs < 1e6) return fmt(n / 1e3, 'k');
    if (abs < 1e9) return fmt(n / 1e6, 'M');
    if (abs < 1e12) return fmt(n / 1e9, 'B');
    return fmt(n / 1e12, 'T');
}

export const money = (n) => `$${compact(Number(n) || 0)}`;
export const count = (n) => compact(Number(n) || 0);
export const exactMoney = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

/** "45 s", "4 m 20 s", "34 m", "1 h 20 m", "2 d 3 h". */
export function duration(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 10) return s % 60 ? `${m} m ${String(s % 60).padStart(2, '0')} s` : `${m} m`;
    if (m < 60) return `${m} m`;
    const hrs = Math.floor(m / 60);
    if (hrs < 24) return m % 60 ? `${hrs} h ${m % 60} m` : `${hrs} h`;
    const d = Math.floor(hrs / 24);
    return hrs % 24 ? `${d} d ${hrs % 24} h` : `${d} d`;
}

export function date(ms) {
    try {
        return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
        return new Date(ms).toISOString().slice(0, 10);
    }
}
