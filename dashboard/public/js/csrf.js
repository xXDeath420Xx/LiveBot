/**
 * Global CSRF protection - automatically adds CSRF token to all
 * fetch() calls and form submissions that modify state (POST/PUT/DELETE).
 *
 * Reads the token from <meta name="csrf-token" content="..."> tag.
 */
(function() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (!meta) return;

    const token = meta.getAttribute('content');
    if (!token) return;

    // Make token available globally for scripts that need it directly
    window.csrfToken = token;

    // Patch fetch() to automatically add X-CSRF-Token header on state-changing requests
    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
        options = options || {};
        const method = (options.method || 'GET').toUpperCase();

        if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
            options.headers = options.headers || {};

            // Support both Headers object and plain object
            if (options.headers instanceof Headers) {
                if (!options.headers.has('X-CSRF-Token')) {
                    options.headers.set('X-CSRF-Token', token);
                }
            } else {
                if (!options.headers['X-CSRF-Token']) {
                    options.headers['X-CSRF-Token'] = token;
                }
            }
        }

        return originalFetch.call(this, url, options);
    };

    // Auto-inject hidden _csrf field into all POST forms on submit
    document.addEventListener('submit', function(e) {
        const form = e.target;
        if (form.tagName !== 'FORM') return;
        if (form.method.toUpperCase() !== 'POST') return;

        // Skip if form already has a _csrf field
        if (form.querySelector('input[name="_csrf"]')) return;

        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = '_csrf';
        input.value = token;
        form.appendChild(input);
    }, true);
})();
