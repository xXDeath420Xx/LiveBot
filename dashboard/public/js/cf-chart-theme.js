/*
 * cf-chart-theme.js — one look for every Chart.js chart on the analytics pages
 * (Twitch analytics, session detail). Load it right after chart.umd.min.js.
 *
 * - Sets Chart.defaults (font, ink, grid, tooltip) from the --cf-* tokens in cf-ui.css,
 *   so charts follow the site theme instead of hard-coded greys.
 * - window.cfViz.series: the fixed categorical order (slot 1 first, never cycled), stepped
 *   for the light or the dark surface. Status colours are separate and only mean status.
 * - cfViz.alpha(hex, a) for fills, cfViz.csv(filename, rows) for client-side CSV export
 *   (cells that start with = + - @ are prefixed so a spreadsheet does not run them).
 */
(function () {
    'use strict';
    var root = document.documentElement;
    function token(name, fallback) {
        try {
            var v = getComputedStyle(root).getPropertyValue(name).trim();
            return v || fallback;
        } catch (e) { return fallback; }
    }
    var theme = root.getAttribute('data-theme') || 'dark';
    var light = theme === 'light' || theme === 'sand';
    // Categorical slots: blue, orange, aqua, yellow, magenta, green, violet, red.
    var SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
    var SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];

    function alpha(hex, a) {
        var h = String(hex || '').replace('#', '');
        if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
        var n = parseInt(h, 16);
        if (!isFinite(n) || h.length !== 6) return hex;
        return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }

    function csvCell(v) {
        if (v === null || v === undefined) return '';
        var s = String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        s = s.replace(/"/g, '""');
        return /[",\n\r]/.test(s) ? '"' + s + '"' : s;
    }
    function csv(filename, rows) {
        var text = rows.map(function (r) { return r.map(csvCell).join(','); }).join('\n') + '\n';
        var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    }

    var viz = {
        light: light,
        series: light ? SERIES_LIGHT : SERIES_DARK,
        status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' },
        text: token('--cf-text', light ? '#16171a' : '#ececef'),
        text2: token('--cf-text-2', light ? '#4b4e57' : '#a7a9b1'),
        muted: token('--cf-text-3', light ? '#6b6e78' : '#8a8c95'),
        grid: token('--cf-border', light ? '#e3e4e8' : '#25272c'),
        surface: token('--cf-surface', light ? '#ffffff' : '#151619'),
        alpha: alpha,
        csv: csv,
    };
    window.cfViz = viz;

    if (window.Chart && Chart.defaults) {
        var d = Chart.defaults;
        d.font.family = token('--cf-font', 'system-ui, sans-serif');
        d.font.size = 11;
        d.color = viz.muted;
        d.borderColor = viz.grid;
        d.elements.line.borderWidth = 2;
        d.elements.line.tension = 0.25;
        d.elements.point.radius = 0;
        d.elements.point.hoverRadius = 4;
        d.elements.bar.borderRadius = 4;
        d.elements.bar.borderSkipped = 'start';
        d.elements.arc.borderColor = viz.surface;
        d.elements.arc.borderWidth = 2;
        d.interaction.mode = 'index';
        d.interaction.intersect = false;
        d.plugins.legend.labels.usePointStyle = true;
        d.plugins.legend.labels.boxWidth = 8;
        d.plugins.legend.labels.color = viz.text2;
        d.plugins.tooltip.backgroundColor = token('--cf-surface-3', light ? '#ffffff' : '#23262b');
        d.plugins.tooltip.titleColor = viz.text;
        d.plugins.tooltip.bodyColor = viz.text2;
        d.plugins.tooltip.borderColor = token('--cf-border-strong', viz.grid);
        d.plugins.tooltip.borderWidth = 1;
        d.plugins.tooltip.padding = 8;
        d.plugins.tooltip.boxPadding = 4;
        d.plugins.tooltip.usePointStyle = true;
        d.maintainAspectRatio = true;
        d.responsive = true;
        if (d.scale) {
            d.scale.grid.color = viz.grid;
            d.scale.ticks.color = viz.muted;
        }
    }
})();
