/**
 * Toast Notification System
 * Usage:
 *   showToast('Message here', 'success');
 *   showToast('Error message', 'error');
 *   showToast('Info message', 'info');
 *   showToast('Warning message', 'warning');
 */

(function() {
    // Create toast container if it doesn't exist
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = `
            position: fixed;
            bottom: 1.5rem;
            right: 1.5rem;
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
            max-width: 400px;
            pointer-events: none;
        `;
        document.body.appendChild(container);
    }

    // Add toast styles
    const style = document.createElement('style');
    style.textContent = `
        .toast {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 1rem 1.25rem;
            border-radius: 12px;
            background: rgba(15, 19, 22, 0.95);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #fff;
            font-size: 0.9rem;
            font-weight: 500;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
            pointer-events: auto;
            transform: translateX(120%);
            opacity: 0;
            transition: transform 0.3s ease, opacity 0.3s ease;
        }

        .toast.show {
            transform: translateX(0);
            opacity: 1;
        }

        .toast.hide {
            transform: translateX(120%);
            opacity: 0;
        }

        .toast-icon {
            font-size: 1.1rem;
            flex-shrink: 0;
        }

        .toast-message {
            flex: 1;
            line-height: 1.4;
        }

        .toast-close {
            background: none;
            border: none;
            color: rgba(255, 255, 255, 0.5);
            cursor: pointer;
            padding: 0.25rem;
            font-size: 1rem;
            transition: color 0.2s;
            flex-shrink: 0;
        }

        .toast-close:hover {
            color: #fff;
        }

        .toast-success {
            border-left: 4px solid #34d399;
        }
        .toast-success .toast-icon {
            color: #34d399;
        }

        .toast-error {
            border-left: 4px solid #f87171;
        }
        .toast-error .toast-icon {
            color: #f87171;
        }

        .toast-warning {
            border-left: 4px solid #fbbf24;
        }
        .toast-warning .toast-icon {
            color: #fbbf24;
        }

        .toast-info {
            border-left: 4px solid #60a5fa;
        }
        .toast-info .toast-icon {
            color: #60a5fa;
        }

        @media (max-width: 480px) {
            #toast-container {
                left: 1rem;
                right: 1rem;
                max-width: none;
            }
        }
    `;
    document.head.appendChild(style);

    // Icon mapping
    const icons = {
        success: '<i class="fas fa-check-circle toast-icon"></i>',
        error: '<i class="fas fa-exclamation-circle toast-icon"></i>',
        warning: '<i class="fas fa-exclamation-triangle toast-icon"></i>',
        info: '<i class="fas fa-info-circle toast-icon"></i>'
    };

    /**
     * Show a toast notification
     * @param {string} message - The message to display
     * @param {string} type - The type: 'success', 'error', 'warning', 'info'
     * @param {number} duration - Duration in ms (default: 4000)
     */
    window.showToast = function(message, type = 'info', duration = 4000) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            ${icons[type] || icons.info}
            <span class="toast-message">${message}</span>
            <button class="toast-close" aria-label="Close notification">
                <i class="fas fa-times"></i>
            </button>
        `;

        // Close button handler
        toast.querySelector('.toast-close').addEventListener('click', () => {
            removeToast(toast);
        });

        container.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        // Auto remove after duration
        if (duration > 0) {
            setTimeout(() => {
                removeToast(toast);
            }, duration);
        }

        return toast;
    };

    function removeToast(toast) {
        if (!toast || !toast.parentNode) return;

        toast.classList.remove('show');
        toast.classList.add('hide');

        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }

    // Expose for module usage
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { showToast: window.showToast };
    }
})();
