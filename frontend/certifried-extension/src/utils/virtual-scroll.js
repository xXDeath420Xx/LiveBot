/**
 * Virtual Scrolling Utility
 * Efficiently renders large lists by only showing visible items
 */

/**
 * Create a virtual scroller
 * @param {object} options
 * @param {HTMLElement} options.container - Scrollable container
 * @param {number} options.itemHeight - Height of each item in pixels
 * @param {number} options.overscan - Number of items to render outside viewport (default: 3)
 * @param {function} options.renderItem - Function to render an item: (item, index) => HTMLElement
 * @param {function} options.getKey - Function to get unique key for item: (item, index) => string
 * @returns {VirtualScroller}
 */
export function createVirtualScroller(options) {
    return new VirtualScroller(options);
}

class VirtualScroller {
    constructor({
        container,
        itemHeight,
        overscan = 3,
        renderItem,
        getKey = (_, i) => String(i)
    }) {
        this.container = container;
        this.itemHeight = itemHeight;
        this.overscan = overscan;
        this.renderItem = renderItem;
        this.getKey = getKey;

        this.items = [];
        this.content = null;
        this.topSpacer = null;
        this.bottomSpacer = null;
        this.itemsContainer = null;

        this._lastStartIndex = -1;
        this._lastEndIndex = -1;
        this._rafId = null;
        this._boundHandleScroll = this._handleScroll.bind(this);

        this._setup();
    }

    _setup() {
        // Create wrapper structure
        this.content = document.createElement('div');
        this.content.className = 'vs-content';
        this.content.style.position = 'relative';

        this.topSpacer = document.createElement('div');
        this.topSpacer.className = 'vs-spacer vs-spacer--top';

        this.itemsContainer = document.createElement('div');
        this.itemsContainer.className = 'vs-items';

        this.bottomSpacer = document.createElement('div');
        this.bottomSpacer.className = 'vs-spacer vs-spacer--bottom';

        this.content.appendChild(this.topSpacer);
        this.content.appendChild(this.itemsContainer);
        this.content.appendChild(this.bottomSpacer);

        this.container.appendChild(this.content);

        // Set up scroll listener
        this.container.addEventListener('scroll', this._boundHandleScroll, { passive: true });
    }

    /**
     * Update the list of items
     * @param {Array} items - Array of items to render
     */
    setItems(items) {
        this.items = items;
        this._lastStartIndex = -1;
        this._lastEndIndex = -1;
        this._update();
    }

    /**
     * Force a re-render of visible items
     */
    refresh() {
        this._lastStartIndex = -1;
        this._lastEndIndex = -1;
        this._update();
    }

    _handleScroll() {
        if (this._rafId) return;
        this._rafId = requestAnimationFrame(() => {
            this._rafId = null;
            this._update();
        });
    }

    _update() {
        const totalItems = this.items.length;
        if (totalItems === 0) {
            this.topSpacer.style.height = '0px';
            this.bottomSpacer.style.height = '0px';
            this.itemsContainer.replaceChildren();
            return;
        }

        const totalHeight = totalItems * this.itemHeight;
        const scrollTop = this.container.scrollTop;
        const viewportHeight = this.container.clientHeight;

        // Calculate visible range
        const startIndex = Math.max(0, Math.floor(scrollTop / this.itemHeight) - this.overscan);
        const endIndex = Math.min(
            totalItems,
            Math.ceil((scrollTop + viewportHeight) / this.itemHeight) + this.overscan
        );

        // Only update if range changed
        if (startIndex === this._lastStartIndex && endIndex === this._lastEndIndex) {
            return;
        }

        this._lastStartIndex = startIndex;
        this._lastEndIndex = endIndex;

        // Update spacers
        const topHeight = startIndex * this.itemHeight;
        const bottomHeight = (totalItems - endIndex) * this.itemHeight;

        this.topSpacer.style.height = `${topHeight}px`;
        this.bottomSpacer.style.height = `${bottomHeight}px`;

        // Render visible items
        const fragment = document.createDocumentFragment();
        for (let i = startIndex; i < endIndex; i++) {
            const item = this.items[i];
            const el = this.renderItem(item, i);
            el.dataset.vsKey = this.getKey(item, i);
            el.dataset.vsIndex = String(i);
            fragment.appendChild(el);
        }

        this.itemsContainer.replaceChildren(fragment);
    }

    /**
     * Scroll to a specific index
     * @param {number} index - Item index to scroll to
     */
    scrollToIndex(index) {
        const offset = index * this.itemHeight;
        this.container.scrollTop = offset;
    }

    /**
     * Get the currently visible range
     * @returns {{start: number, end: number}}
     */
    getVisibleRange() {
        return {
            start: this._lastStartIndex,
            end: this._lastEndIndex
        };
    }

    /**
     * Clean up event listeners
     */
    destroy() {
        this.container.removeEventListener('scroll', this._boundHandleScroll);
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
        }
        this.content.remove();
    }
}

/**
 * Check if virtual scrolling should be used
 * @param {number} itemCount - Number of items
 * @param {number} threshold - Minimum items to trigger virtual scrolling (default: 50)
 * @returns {boolean}
 */
export function shouldUseVirtualScroll(itemCount, threshold = 50) {
    return itemCount > threshold;
}

export default createVirtualScroller;
