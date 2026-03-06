/**
 * Loading Manager - Centralized loading state management
 * Handles skeleton screens, spinners, overlays, and API loading states
 */

class LoadingManager {
    constructor() {
        this.loadingStack = [];
        this.isLoading = false;
        this.init();
    }

    /**
     * Initialize loading manager
     */
    init() {
        this.pageLoadingOverlay = document.getElementById('page-loading-overlay');
        this.pageLoadingBar = document.getElementById('page-loading-bar');
        this.toastContainer = document.getElementById('toast-container');

        // Initialize event listeners
        this.initializeEventListeners();
        console.log('✅ Loading Manager initialized');
    }

    /**
     * Initialize event listeners
     */
    initializeEventListeners() {
        // Show loading on form submit
        document.addEventListener('submit', (e) => {
            const form = e.target;
            if (!form.dataset.noLoading) {
                this.showFormLoading(form);
            }
        });

        // Show loading on fetch intercepts
        this.interceptFetch();

        // Fade in loaded content
        document.addEventListener('DOMContentLoaded', () => {
            const content = document.querySelector('main');
            if (content) {
                content.classList.add('fade-in');
            }
        });
    }

    /**
     * Intercept fetch calls to show loading state
     */
    interceptFetch() {
        const originalFetch = window.fetch;
        window.fetch = (...args) => {
            this.showLoadingBar();

            return originalFetch.apply(this, args)
                .then(response => {
                    this.hideLoadingBar();
                    return response;
                })
                .catch(error => {
                    this.hideLoadingBar();
                    throw error;
                });
        };
    }

    /**
     * Show page loading overlay
     * @param {string} message - Loading message
     */
    showPageLoading(message = 'Loading...') {
        if (this.pageLoadingOverlay) {
            const messageEl = this.pageLoadingOverlay.querySelector('.page-loading-text');
            if (messageEl) {
                messageEl.textContent = message;
            }
            this.pageLoadingOverlay.classList.add('active');
            this.isLoading = true;
            this.loadingStack.push('page');
        }
    }

    /**
     * Hide page loading overlay
     */
    hidePageLoading() {
        if (this.pageLoadingOverlay) {
            this.pageLoadingOverlay.classList.remove('active');
            this.loadingStack = this.loadingStack.filter(x => x !== 'page');
            this.isLoading = this.loadingStack.length > 0;
        }
    }

    /**
     * Show loading bar (top of page)
     */
    showLoadingBar() {
        if (this.pageLoadingBar) {
            this.pageLoadingBar.style.display = 'block';
        }
    }

    /**
     * Hide loading bar
     */
    hideLoadingBar() {
        if (this.pageLoadingBar) {
            this.pageLoadingBar.style.display = 'none';
        }
    }

    /**
     * Show loading state for a form
     * @param {HTMLElement} form - Form element
     */
    showFormLoading(form) {
        if (!form) return;

        // Add loading class to form
        form.classList.add('form-loading');

        // Disable all inputs
        form.querySelectorAll('input, select, textarea, button').forEach(el => {
            el.disabled = true;
        });

        // Find and animate submit button
        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) {
            submitBtn.classList.add('btn-loading');
            const originalText = submitBtn.innerHTML;
            submitBtn.setAttribute('data-original-text', originalText);
        }
    }

    /**
     * Hide loading state for a form
     * @param {HTMLElement} form - Form element
     */
    hideFormLoading(form) {
        if (!form) return;

        form.classList.remove('form-loading');

        // Enable all inputs
        form.querySelectorAll('input, select, textarea, button').forEach(el => {
            el.disabled = false;
        });

        // Restore submit button
        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) {
            submitBtn.classList.remove('btn-loading');
            const originalText = submitBtn.getAttribute('data-original-text');
            if (originalText) {
                submitBtn.innerHTML = originalText;
                submitBtn.removeAttribute('data-original-text');
            }
        }
    }

    /**
     * Show skeleton loading for server list
     * @param {HTMLElement} container - Container to fill with skeletons
     * @param {number} count - Number of skeleton cards to show
     */
    showServerListSkeleton(container, count = 3) {
        if (!container) return;

        container.innerHTML = '';
        const template = document.getElementById('server-card-skeleton-template');

        if (template) {
            for (let i = 0; i < count; i++) {
                const clone = template.content.cloneNode(true);
                container.appendChild(clone);
            }
        }

        container.classList.add('loading-state', 'active');
    }

    /**
     * Hide server list skeleton
     * @param {HTMLElement} container - Container to hide skeleton from
     */
    hideServerListSkeleton(container) {
        if (container) {
            container.classList.remove('loading-state', 'active');
        }
    }

    /**
     * Show skeleton loading for manage page
     * @param {HTMLElement} container - Container to fill with skeleton
     */
    showManagePageSkeleton(container) {
        if (!container) return;

        const template = document.getElementById('manage-page-skeleton-template');
        if (template) {
            container.innerHTML = '';
            const clone = template.content.cloneNode(true);
            container.appendChild(clone);
            container.classList.add('loading-state', 'active');
        }
    }

    /**
     * Hide manage page skeleton
     * @param {HTMLElement} container - Container to hide skeleton from
     */
    hideManagePageSkeleton(container) {
        if (container) {
            container.classList.remove('loading-state', 'active');
        }
    }

    /**
     * Show data loading indicator
     * @param {HTMLElement} container - Container for loading indicator
     * @param {string} message - Loading message
     */
    showDataLoading(container, message = 'Loading data...') {
        if (!container) return;

        const template = document.getElementById('data-loading-template');
        if (template) {
            container.innerHTML = '';
            const clone = template.content.cloneNode(true);

            const messageEl = clone.querySelector('#loading-message');
            if (messageEl) {
                messageEl.textContent = message;
            }

            container.appendChild(clone);
            container.classList.add('data-loading', 'loading-state', 'active');
        }
    }

    /**
     * Hide data loading indicator
     * @param {HTMLElement} container - Container to clear
     */
    hideDataLoading(container) {
        if (container) {
            container.classList.remove('data-loading', 'loading-state', 'active');
        }
    }

    /**
     * Show toast notification
     * @param {string} message - Toast message
     * @param {string} type - Toast type (success, error, info, warning)
     * @param {number} duration - Duration in ms (default 3000)
     */
    showToast(message, type = 'info', duration = 3000) {
        if (!this.toastContainer) {
            console.error('Toast container not found');
            return;
        }

        const toastBgClass = {
            'success': 'bg-success',
            'error': 'bg-danger',
            'danger': 'bg-danger',
            'warning': 'bg-warning',
            'info': 'bg-info'
        }[type] || 'bg-info';

        const toast = document.createElement('div');
        toast.className = `toast align-items-center text-white ${toastBgClass} border-0`;
        toast.setAttribute('role', 'alert');
        toast.setAttribute('aria-live', 'assertive');
        toast.setAttribute('aria-atomic', 'true');

        const icon = {
            'success': 'fa-check-circle',
            'error': 'fa-exclamation-circle',
            'danger': 'fa-exclamation-circle',
            'warning': 'fa-exclamation-triangle',
            'info': 'fa-info-circle'
        }[type] || 'fa-info-circle';

        toast.innerHTML = `
            <div class="d-flex">
                <i class="fas ${icon} me-2"></i>
                <div class="toast-body">${message}</div>
                <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
            </div>
        `;

        this.toastContainer.appendChild(toast);

        const bsToast = new bootstrap.Toast(toast, {
            autohide: true,
            delay: duration
        });

        bsToast.show();

        // Remove toast element after it's hidden
        toast.addEventListener('hidden.bs.toast', () => toast.remove());
    }

    /**
     * Wrap async operation with loading state
     * @param {Function} asyncFn - Async function to execute
     * @param {HTMLElement} container - Loading indicator container
     * @param {string} message - Loading message
     * @returns {Promise}
     */
    async withLoading(asyncFn, container = null, message = 'Loading...') {
        try {
            if (container) {
                this.showDataLoading(container, message);
            }

            const result = await asyncFn();

            if (container) {
                this.hideDataLoading(container);
            }

            return result;
        } catch (error) {
            if (container) {
                this.hideDataLoading(container);
            }
            this.showToast('An error occurred', 'error');
            console.error('Loading operation failed:', error);
            throw error;
        }
    }

    /**
     * Handle API call with loading state
     * @param {string} url - API endpoint
     * @param {Object} options - Fetch options
     * @param {HTMLElement} container - Loading indicator container
     * @returns {Promise}
     */
    async fetchWithLoading(url, options = {}, container = null) {
        return this.withLoading(
            () => fetch(url, options).then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            }),
            container,
            options.loadingMessage || 'Loading...'
        );
    }

    /**
     * Handle form submission with loading state
     * @param {HTMLElement} form - Form element
     * @param {Function} onSubmit - Submit handler
     */
    async submitForm(form, onSubmit) {
        if (!form) return;

        try {
            this.showFormLoading(form);
            await onSubmit();
            this.hideFormLoading(form);
        } catch (error) {
            this.hideFormLoading(form);
            console.error('Form submission failed:', error);
            throw error;
        }
    }

    /**
     * Delay execution (for demo purposes)
     * @param {number} ms - Milliseconds to delay
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get current loading state
     * @returns {boolean}
     */
    getLoadingState() {
        return this.isLoading;
    }

    /**
     * Clear all loading states
     */
    clearAll() {
        this.hidePageLoading();
        this.hideLoadingBar();
        this.loadingStack = [];
        this.isLoading = false;

        // Clear all loading classes
        document.querySelectorAll('.form-loading, .data-loading').forEach(el => {
            el.classList.remove('form-loading', 'data-loading', 'loading-state', 'active');
        });
    }
}

// Initialize global loading manager
const loadingManager = new LoadingManager();

// Make it globally available
window.loadingManager = loadingManager;

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LoadingManager;
}

console.log('✅ Loading Manager loaded and ready');
