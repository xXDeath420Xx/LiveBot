/**
 * Toast Notification System
 * Displays non-intrusive notifications
 */

class ToastManager {
    constructor() {
        this.container = null;
        this.toasts = [];
        this.maxToasts = 5;
        this.defaultDuration = 4000;
    }

    /**
     * Initialize toast container
     */
    init() {
        if (this.container) return;

        this.container = document.createElement('div');
        this.container.id = 'toast-container';
        this.container.className = 'fixed bottom-4 right-4 z-50 flex flex-col gap-2';
        document.body.appendChild(this.container);
    }

    /**
     * Show a toast notification
     * @param {string} type - Type of toast (success, error, warning, info)
     * @param {string} message - Message to display
     * @param {Object} options - Additional options
     */
    show(type, message, options = {}) {
        this.init();

        const {
            duration = this.defaultDuration,
            title = null,
            closeable = true,
            icon = null
        } = options;

        // Remove oldest toast if at max
        if (this.toasts.length >= this.maxToasts) {
            this.remove(this.toasts[0]);
        }

        // Create toast element
        const toast = document.createElement('div');
        toast.className = this._getToastClasses(type);
        toast.innerHTML = this._getToastHTML(type, message, title, icon, closeable);

        // Add to container
        this.container.appendChild(toast);
        this.toasts.push(toast);

        // Trigger animation
        requestAnimationFrame(() => {
            toast.classList.add('animate-slide-up');
        });

        // Setup close button
        if (closeable) {
            const closeBtn = toast.querySelector('[data-close]');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => this.remove(toast));
            }
        }

        // Auto-remove after duration
        if (duration > 0) {
            setTimeout(() => this.remove(toast), duration);
        }

        return toast;
    }

    /**
     * Remove a toast
     * @param {HTMLElement} toast - Toast element to remove
     */
    remove(toast) {
        if (!toast || !this.container.contains(toast)) return;

        toast.classList.add('opacity-0', 'translate-x-full');
        toast.classList.remove('animate-slide-up');

        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
            const index = this.toasts.indexOf(toast);
            if (index > -1) {
                this.toasts.splice(index, 1);
            }
        }, 300);
    }

    /**
     * Clear all toasts
     */
    clear() {
        [...this.toasts].forEach(toast => this.remove(toast));
    }

    /**
     * Get toast CSS classes based on type
     * @param {string} type - Toast type
     * @returns {string} CSS classes
     */
    _getToastClasses(type) {
        const baseClasses = 'flex items-start gap-3 p-4 rounded-lg shadow-lg border max-w-sm transition-all duration-300 transform';
        const typeClasses = {
            success: 'bg-accent-green-dark/90 border-accent-green/30 text-white',
            error: 'bg-accent-red-dark/90 border-accent-red/30 text-white',
            warning: 'bg-accent-yellow-dark/90 border-accent-yellow/30 text-white',
            info: 'bg-primary-600/90 border-primary-500/30 text-white'
        };

        return `${baseClasses} ${typeClasses[type] || typeClasses.info}`;
    }

    /**
     * Get toast icon based on type
     * @param {string} type - Toast type
     * @returns {string} SVG icon
     */
    _getIcon(type) {
        const icons = {
            success: `<svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
            </svg>`,
            error: `<svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>`,
            warning: `<svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>`,
            info: `<svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>`
        };
        return icons[type] || icons.info;
    }

    /**
     * Get toast HTML content
     * @param {string} type - Toast type
     * @param {string} message - Message
     * @param {string|null} title - Optional title
     * @param {string|null} icon - Optional custom icon
     * @param {boolean} closeable - Show close button
     * @returns {string} HTML content
     */
    _getToastHTML(type, message, title, icon, closeable) {
        const iconHtml = icon || this._getIcon(type);
        const closeBtn = closeable ? `
            <button data-close class="ml-auto p-1 hover:opacity-70 transition-opacity">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                </svg>
            </button>
        ` : '';

        return `
            ${iconHtml}
            <div class="flex-1 min-w-0">
                ${title ? `<p class="font-semibold text-sm">${title}</p>` : ''}
                <p class="text-sm ${title ? 'opacity-90' : ''}">${message}</p>
            </div>
            ${closeBtn}
        `;
    }

    // Convenience methods
    success(message, options = {}) {
        return this.show('success', message, options);
    }

    error(message, options = {}) {
        return this.show('error', message, options);
    }

    warning(message, options = {}) {
        return this.show('warning', message, options);
    }

    info(message, options = {}) {
        return this.show('info', message, options);
    }
}

// Create global instance
const toastManager = new ToastManager();

// Global helper function
function showToast(type, message, options = {}) {
    return toastManager.show(type, message, options);
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ToastManager, toastManager, showToast };
}
