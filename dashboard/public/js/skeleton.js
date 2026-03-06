/**
 * Loading Skeleton System
 * Creates shimmer loading placeholders for content
 *
 * Usage:
 *   <div class="skeleton skeleton-text"></div>
 *   <div class="skeleton skeleton-avatar"></div>
 *   <div class="skeleton skeleton-card"></div>
 *
 * Or programmatically:
 *   showSkeleton(element);
 *   hideSkeleton(element);
 */

(function() {
    // Add skeleton styles
    const style = document.createElement('style');
    style.textContent = `
        .skeleton {
            background: linear-gradient(
                90deg,
                rgba(255, 255, 255, 0.03) 0%,
                rgba(255, 255, 255, 0.08) 50%,
                rgba(255, 255, 255, 0.03) 100%
            );
            background-size: 200% 100%;
            animation: skeleton-shimmer 1.5s infinite;
            border-radius: 8px;
            position: relative;
            overflow: hidden;
        }

        @keyframes skeleton-shimmer {
            0% {
                background-position: 200% 0;
            }
            100% {
                background-position: -200% 0;
            }
        }

        /* Skeleton variants */
        .skeleton-text {
            height: 1rem;
            width: 100%;
            margin-bottom: 0.5rem;
        }

        .skeleton-text.short {
            width: 60%;
        }

        .skeleton-text.medium {
            width: 80%;
        }

        .skeleton-title {
            height: 1.5rem;
            width: 50%;
            margin-bottom: 1rem;
        }

        .skeleton-avatar {
            width: 48px;
            height: 48px;
            border-radius: 50%;
            flex-shrink: 0;
        }

        .skeleton-avatar.sm {
            width: 32px;
            height: 32px;
        }

        .skeleton-avatar.lg {
            width: 64px;
            height: 64px;
        }

        .skeleton-card {
            height: 120px;
            width: 100%;
            border-radius: 12px;
        }

        .skeleton-button {
            height: 40px;
            width: 120px;
            border-radius: 8px;
        }

        .skeleton-image {
            height: 200px;
            width: 100%;
            border-radius: 12px;
        }

        .skeleton-stat {
            height: 80px;
            width: 100%;
            border-radius: 12px;
        }

        /* Skeleton container for replacing content */
        .skeleton-container {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
        }

        .skeleton-row {
            display: flex;
            align-items: center;
            gap: 1rem;
        }

        .skeleton-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        /* Hide real content when loading */
        [data-skeleton-loading="true"] > *:not(.skeleton-wrapper) {
            display: none !important;
        }

        .skeleton-wrapper {
            display: none;
        }

        [data-skeleton-loading="true"] .skeleton-wrapper {
            display: block;
        }
    `;
    document.head.appendChild(style);

    /**
     * Create a skeleton placeholder
     * @param {string} type - Type of skeleton: 'text', 'avatar', 'card', 'button', 'image', 'stat'
     * @param {object} options - Optional settings { width, height, className }
     */
    window.createSkeleton = function(type = 'text', options = {}) {
        const el = document.createElement('div');
        el.className = `skeleton skeleton-${type} ${options.className || ''}`;

        if (options.width) el.style.width = options.width;
        if (options.height) el.style.height = options.height;

        return el;
    };

    /**
     * Create a skeleton row (avatar + text lines)
     */
    window.createSkeletonRow = function() {
        const row = document.createElement('div');
        row.className = 'skeleton-row';
        row.innerHTML = `
            <div class="skeleton skeleton-avatar"></div>
            <div class="skeleton-content">
                <div class="skeleton skeleton-text medium"></div>
                <div class="skeleton skeleton-text short"></div>
            </div>
        `;
        return row;
    };

    /**
     * Create a skeleton card
     */
    window.createSkeletonCard = function() {
        const card = document.createElement('div');
        card.className = 'skeleton-container';
        card.innerHTML = `
            <div class="skeleton skeleton-image" style="height: 120px;"></div>
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton skeleton-text"></div>
            <div class="skeleton skeleton-text short"></div>
        `;
        return card;
    };

    /**
     * Show skeleton loading state for an element
     * @param {HTMLElement} element - The element to show loading for
     * @param {string} skeletonType - Type of skeleton to show
     */
    window.showSkeleton = function(element, skeletonType = 'card') {
        if (!element) return;

        // Check if skeleton wrapper already exists
        let wrapper = element.querySelector('.skeleton-wrapper');
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.className = 'skeleton-wrapper';

            // Create appropriate skeleton based on type
            if (skeletonType === 'row') {
                wrapper.appendChild(createSkeletonRow());
            } else if (skeletonType === 'card') {
                wrapper.appendChild(createSkeletonCard());
            } else {
                wrapper.appendChild(createSkeleton(skeletonType));
            }

            element.appendChild(wrapper);
        }

        element.setAttribute('data-skeleton-loading', 'true');
    };

    /**
     * Hide skeleton loading state for an element
     * @param {HTMLElement} element - The element to hide loading for
     */
    window.hideSkeleton = function(element) {
        if (!element) return;
        element.removeAttribute('data-skeleton-loading');
    };

    /**
     * Show skeleton for multiple elements
     * @param {string} selector - CSS selector for elements
     * @param {string} skeletonType - Type of skeleton
     */
    window.showSkeletons = function(selector, skeletonType = 'card') {
        document.querySelectorAll(selector).forEach(el => {
            showSkeleton(el, skeletonType);
        });
    };

    /**
     * Hide skeleton for multiple elements
     * @param {string} selector - CSS selector for elements
     */
    window.hideSkeletons = function(selector) {
        document.querySelectorAll(selector).forEach(el => {
            hideSkeleton(el);
        });
    };
})();
