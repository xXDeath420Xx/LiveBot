/**
 * CertiFried Extension - Base Web Component
 * Abstract base class for all custom elements
 */

import { store } from '../state/store.js';

export class CFBaseComponent extends HTMLElement {
    /**
     * Observed attributes to trigger attributeChangedCallback
     * Override in subclass
     */
    static get observedAttributes() {
        return [];
    }

    constructor() {
        super();

        // Store subscriptions for cleanup
        this._subscriptions = [];

        // Bind methods that need 'this' context
        this._boundRender = this.render.bind(this);
    }

    /**
     * Called when element is added to DOM
     */
    connectedCallback() {
        this._setupSubscriptions();
        this.onMount();
        this.render();
    }

    /**
     * Called when element is removed from DOM
     */
    disconnectedCallback() {
        this._cleanupSubscriptions();
        this.onUnmount();
    }

    /**
     * Called when observed attribute changes
     */
    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue !== newValue) {
            this.onAttributeChange(name, oldValue, newValue);
            this.render();
        }
    }

    /**
     * Setup store subscriptions
     * Override to add subscriptions
     */
    _setupSubscriptions() {
        // Subclasses should call this.subscribe(path, callback)
    }

    /**
     * Clean up all subscriptions
     */
    _cleanupSubscriptions() {
        for (const unsubscribe of this._subscriptions) {
            unsubscribe();
        }
        this._subscriptions = [];
    }

    /**
     * Subscribe to store changes
     * @param {string} path - Store path to watch
     * @param {function} [callback] - Optional callback, defaults to scheduleRender (batched)
     * @param {object} [options] - Options: { immediate: false, throttle: 0 }
     */
    subscribe(path, callback, options = {}) {
        // Default to batched render via requestAnimationFrame
        let handler = callback || (() => this.scheduleRender());

        // Apply throttling if specified
        if (options.throttle > 0) {
            handler = this._throttle(handler, options.throttle);
        }

        const unsubscribe = store.subscribe(path, handler);
        this._subscriptions.push(unsubscribe);
        return unsubscribe;
    }

    /**
     * Throttle a function
     * @param {function} fn - Function to throttle
     * @param {number} delay - Throttle delay in ms
     */
    _throttle(fn, delay) {
        let lastCall = 0;
        let timeoutId = null;
        return (...args) => {
            const now = Date.now();
            const remaining = delay - (now - lastCall);

            if (remaining <= 0) {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
                lastCall = now;
                fn.apply(this, args);
            } else if (!timeoutId) {
                timeoutId = setTimeout(() => {
                    lastCall = Date.now();
                    timeoutId = null;
                    fn.apply(this, args);
                }, remaining);
            }
        };
    }

    /**
     * Get value from store
     * @param {string} path
     */
    getState(path) {
        return store.get(path);
    }

    /**
     * Set value in store
     * @param {string} path
     * @param {*} value
     */
    setState(path, value) {
        store.set(path, value);
    }

    /**
     * Lifecycle: Called after element is mounted
     * Override in subclass
     */
    onMount() {}

    /**
     * Lifecycle: Called before element is unmounted
     * Override in subclass
     */
    onUnmount() {}

    /**
     * Lifecycle: Called when observed attribute changes
     * Override in subclass
     */
    onAttributeChange(name, oldValue, newValue) {}

    /**
     * Render the component
     * Override in subclass - MUST be implemented
     */
    render() {
        throw new Error('render() must be implemented by subclass');
    }

    /**
     * Query selector within this element
     * @param {string} selector
     */
    $(selector) {
        return this.querySelector(selector);
    }

    /**
     * Query selector all within this element
     * @param {string} selector
     */
    $$(selector) {
        return Array.from(this.querySelectorAll(selector));
    }

    /**
     * Add event listener with auto-cleanup
     * @param {string} event
     * @param {string|function} selectorOrHandler
     * @param {function} [handler]
     */
    on(event, selectorOrHandler, handler) {
        if (typeof selectorOrHandler === 'function') {
            this.addEventListener(event, selectorOrHandler);
            this._subscriptions.push(() =>
                this.removeEventListener(event, selectorOrHandler)
            );
        } else {
            // Event delegation
            const delegatedHandler = (e) => {
                const target = e.target.closest(selectorOrHandler);
                if (target && this.contains(target)) {
                    handler.call(target, e);
                }
            };
            this.addEventListener(event, delegatedHandler);
            this._subscriptions.push(() =>
                this.removeEventListener(event, delegatedHandler)
            );
        }
    }

    /**
     * Emit custom event
     * @param {string} name
     * @param {*} detail
     */
    emit(name, detail = null) {
        this.dispatchEvent(new CustomEvent(name, {
            detail,
            bubbles: true,
            composed: true
        }));
    }

    /**
     * Get attribute as specific type
     */
    getAttr(name, defaultValue = null) {
        const value = this.getAttribute(name);
        if (value === null) return defaultValue;
        return value;
    }

    getAttrBool(name) {
        return this.hasAttribute(name);
    }

    getAttrNumber(name, defaultValue = 0) {
        const value = this.getAttribute(name);
        if (value === null) return defaultValue;
        const num = parseFloat(value);
        return isNaN(num) ? defaultValue : num;
    }

    getAttrJSON(name, defaultValue = null) {
        const value = this.getAttribute(name);
        if (value === null) return defaultValue;
        try {
            return JSON.parse(value);
        } catch {
            return defaultValue;
        }
    }

    /**
     * Schedule a render on next animation frame
     * Useful for batching multiple updates - multiple calls within same frame = single render
     */
    scheduleRender() {
        if (this._renderScheduled) return;
        this._renderScheduled = true;
        requestAnimationFrame(() => {
            this._renderScheduled = false;
            if (this.isConnected) {
                this.render();
            }
        });
    }

    /**
     * Update a specific DOM element's text content without full re-render
     * @param {string} selector - CSS selector for target element
     * @param {string|number} value - New text content
     */
    updateText(selector, value) {
        const el = this.$(selector);
        if (el && el.textContent !== String(value)) {
            el.textContent = value;
        }
    }

    /**
     * Update a specific DOM element's attribute
     * @param {string} selector - CSS selector for target element
     * @param {string} attr - Attribute name
     * @param {string} value - New attribute value
     */
    updateAttr(selector, attr, value) {
        const el = this.$(selector);
        if (el) {
            if (attr === 'style' && typeof value === 'object') {
                Object.assign(el.style, value);
            } else {
                el.setAttribute(attr, value);
            }
        }
    }

    /**
     * Subscribe to specific store path with targeted DOM update
     * Much faster than full re-render for frequently changing values
     * @param {string} storePath - Store path to watch
     * @param {string} selector - CSS selector for element to update
     * @param {function} [formatter] - Optional formatter function
     */
    bindText(storePath, selector, formatter = (v) => v) {
        return this.subscribe(storePath, (value) => {
            this.updateText(selector, formatter(value));
        });
    }

    /**
     * Set component content, filtering falsy values
     * Use instead of replaceChildren() to avoid "false" text nodes
     * @param {...(Node|string|null|undefined|false)} children
     */
    setContent(...children) {
        // Filter out null, undefined, false, and empty strings
        const filtered = children.filter(child =>
            child !== null && child !== undefined && child !== false && child !== ''
        );
        this.replaceChildren(...filtered);
    }

    /**
     * Show loading state
     */
    showLoading() {
        this.classList.add('is-loading');
    }

    /**
     * Hide loading state
     */
    hideLoading() {
        this.classList.remove('is-loading');
    }

    /**
     * Create skeleton loading element
     * @param {string} type - 'text' | 'title' | 'avatar' | 'card' | 'plot' | 'item' | 'btn'
     * @returns {HTMLElement}
     */
    createSkeleton(type = 'text') {
        const el = document.createElement('div');
        el.className = `cf-skeleton cf-skeleton--${type}`;
        return el;
    }

    /**
     * Create skeleton grid for plots/cards
     * @param {number} count - Number of skeleton items
     * @param {string} type - Skeleton type
     * @returns {HTMLElement}
     */
    createSkeletonGrid(count, type = 'plot') {
        const grid = document.createElement('div');
        grid.className = 'cf-skeleton-grid';
        for (let i = 0; i < count; i++) {
            grid.appendChild(this.createSkeleton(type));
        }
        return grid;
    }

    /**
     * Create skeleton list
     * @param {number} count - Number of skeleton items
     * @param {string} type - Skeleton type
     * @returns {HTMLElement}
     */
    createSkeletonList(count, type = 'item') {
        const list = document.createElement('div');
        list.className = 'cf-skeleton-list';
        for (let i = 0; i < count; i++) {
            list.appendChild(this.createSkeleton(type));
        }
        return list;
    }

    /**
     * Create loading spinner element
     * @param {string} text - Optional loading text
     * @returns {HTMLElement}
     */
    createLoadingSpinner(text = 'Loading...') {
        const container = document.createElement('div');
        container.className = 'cf-loading';

        const spinner = document.createElement('div');
        spinner.className = 'cf-loading__spinner';
        container.appendChild(spinner);

        if (text) {
            const textEl = document.createElement('span');
            textEl.className = 'cf-loading__text';
            textEl.textContent = text;
            container.appendChild(textEl);
        }

        return container;
    }

    /**
     * Show error state
     * @param {string} message
     */
    showError(message) {
        this.classList.add('has-error');
        this.dataset.error = message;
    }

    /**
     * Clear error state
     */
    clearError() {
        this.classList.remove('has-error');
        delete this.dataset.error;
    }

    /**
     * Execute an action with optimistic UI updates
     * Updates state immediately, then calls API - rolls back on failure
     *
     * @param {object} options
     * @param {function} options.optimisticUpdate - Function to apply optimistic state changes
     * @param {function} options.apiCall - Async API call to execute
     * @param {function} [options.onSuccess] - Called with API result on success
     * @param {function} [options.onError] - Called with error on failure
     * @param {object} [options.rollbackPaths] - Map of store paths -> values to restore on error
     * @returns {Promise} - Resolves with API result or rejects with error
     */
    async optimistic({ optimisticUpdate, apiCall, onSuccess, onError, rollbackPaths = {} }) {
        // Save current state for rollback
        const savedStates = {};
        for (const path of Object.keys(rollbackPaths)) {
            savedStates[path] = store.get(path);
        }

        try {
            // Apply optimistic update immediately
            if (optimisticUpdate) {
                optimisticUpdate();
            }

            // Execute API call
            const result = await apiCall();

            // Success callback
            if (onSuccess) {
                onSuccess(result);
            }

            return result;

        } catch (error) {
            // Rollback to saved state
            store.beginBatch?.();
            try {
                for (const [path, value] of Object.entries(savedStates)) {
                    store.set(path, value);
                }
            } finally {
                store.endBatch?.();
            }

            // Error callback
            if (onError) {
                onError(error);
            } else {
                // Default error notification
                this.emit('notification', {
                    type: 'error',
                    message: error.message || 'Action failed'
                });
            }

            throw error;
        }
    }
}

/**
 * Register a custom element
 * @param {string} name - Element name (must include hyphen)
 * @param {typeof CFBaseComponent} componentClass
 */
export function registerComponent(name, componentClass) {
    if (!customElements.get(name)) {
        customElements.define(name, componentClass);
    }
}

export default CFBaseComponent;
