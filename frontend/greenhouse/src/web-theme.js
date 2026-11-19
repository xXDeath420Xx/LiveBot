// Website only (imported by web-entry.js, never by the Twitch panel's main.js): the site's colour theme.
// dashboard/routes/greenhouse.js puts it on <html> before the page is sent: data-theme="light" for Light,
// data-theme="light" data-theme-variant="sand" for Sand, data-theme-mode="auto" for Auto, nothing for Dark
// (the default) and the other dark themes. Auto is painted from CSS first (styles/web.css, a light set under
// prefers-color-scheme: light); this sets data-theme so the game's own [data-theme="light"] rules apply too,
// and follows the OS when it switches while the page is open.
const root = document.documentElement;
if (root.dataset.themeMode === 'auto' && window.matchMedia) {
    const light = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
        if (light.matches) root.dataset.theme = 'light';
        else delete root.dataset.theme;
    };
    apply();
    if (light.addEventListener) light.addEventListener('change', apply);
}
