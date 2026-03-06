/**
 * Theme Toggle System with LocalStorage Persistence
 * Usage: Include this script and call initTheme() on page load
 *
 * Themes: 'dark' (default), 'light', 'purple', 'blue'
 */

(function() {
    const THEME_KEY = 'certifired-theme';
    const DEFAULT_THEME = 'dark';

    // Theme color definitions
    const themes = {
        dark: {
            '--bg-primary': '#0b0f11',
            '--bg-secondary': '#0f1316',
            '--bg-card': 'rgba(255, 255, 255, 0.03)',
            '--bg-card-hover': 'rgba(255, 255, 255, 0.06)',
            '--border-color': 'rgba(255, 255, 255, 0.08)',
            '--text-primary': '#ffffff',
            '--text-secondary': 'rgba(255, 255, 255, 0.7)',
            '--text-muted': 'rgba(255, 255, 255, 0.5)',
            '--accent-purple': '#a78bfa',
            '--accent-blue': '#60a5fa',
            '--accent-green': '#34d399',
            '--accent-yellow': '#fbbf24',
            '--accent-red': '#f87171'
        },
        midnight: {
            '--bg-primary': '#0a0a0f',
            '--bg-secondary': '#12121a',
            '--bg-card': 'rgba(255, 255, 255, 0.02)',
            '--bg-card-hover': 'rgba(255, 255, 255, 0.05)',
            '--border-color': 'rgba(139, 92, 246, 0.15)',
            '--text-primary': '#ffffff',
            '--text-secondary': 'rgba(255, 255, 255, 0.7)',
            '--text-muted': 'rgba(255, 255, 255, 0.5)',
            '--accent-purple': '#8b5cf6',
            '--accent-blue': '#6366f1',
            '--accent-green': '#10b981',
            '--accent-yellow': '#f59e0b',
            '--accent-red': '#ef4444'
        },
        ocean: {
            '--bg-primary': '#0c1929',
            '--bg-secondary': '#0f2136',
            '--bg-card': 'rgba(255, 255, 255, 0.03)',
            '--bg-card-hover': 'rgba(255, 255, 255, 0.06)',
            '--border-color': 'rgba(96, 165, 250, 0.15)',
            '--text-primary': '#ffffff',
            '--text-secondary': 'rgba(255, 255, 255, 0.7)',
            '--text-muted': 'rgba(255, 255, 255, 0.5)',
            '--accent-purple': '#818cf8',
            '--accent-blue': '#38bdf8',
            '--accent-green': '#2dd4bf',
            '--accent-yellow': '#fbbf24',
            '--accent-red': '#fb7185'
        }
    };

    /**
     * Get the current theme from localStorage
     */
    function getTheme() {
        return localStorage.getItem(THEME_KEY) || DEFAULT_THEME;
    }

    /**
     * Set and apply a theme
     * @param {string} themeName - The theme to apply
     */
    function setTheme(themeName) {
        const theme = themes[themeName] || themes[DEFAULT_THEME];
        const root = document.documentElement;

        // Apply CSS variables
        Object.entries(theme).forEach(([property, value]) => {
            root.style.setProperty(property, value);
        });

        // Save to localStorage
        localStorage.setItem(THEME_KEY, themeName);

        // Update any theme toggle buttons
        document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.themeToggle === themeName);
        });

        // Dispatch event for other scripts
        window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: themeName } }));
    }

    /**
     * Initialize theme on page load
     */
    function initTheme() {
        const savedTheme = getTheme();
        setTheme(savedTheme);

        // Set up theme toggle buttons
        document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
            btn.addEventListener('click', () => {
                setTheme(btn.dataset.themeToggle);
            });
        });
    }

    /**
     * Cycle through themes
     */
    function cycleTheme() {
        const themeNames = Object.keys(themes);
        const currentTheme = getTheme();
        const currentIndex = themeNames.indexOf(currentTheme);
        const nextIndex = (currentIndex + 1) % themeNames.length;
        setTheme(themeNames[nextIndex]);
    }

    // Expose functions globally
    window.themeManager = {
        getTheme,
        setTheme,
        initTheme,
        cycleTheme,
        themes: Object.keys(themes)
    };

    // Auto-initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTheme);
    } else {
        initTheme();
    }
})();
