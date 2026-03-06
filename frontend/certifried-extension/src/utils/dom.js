/**
 * CertiFried Extension - DOM Utilities
 */

/**
 * Create element with attributes and children
 * @param {string} tag - HTML tag name
 * @param {object} attrs - Attributes to set
 * @param {...(Node|string)} children - Child elements or text
 */
export function createElement(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);

    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class' || key === 'className') {
            el.className = Array.isArray(value) ? value.join(' ') : value;
        } else if (key === 'style' && typeof value === 'object') {
            Object.assign(el.style, value);
        } else if (key.startsWith('on') && typeof value === 'function') {
            el.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'dataset') {
            Object.assign(el.dataset, value);
        } else if (value !== null && value !== undefined && value !== false) {
            el.setAttribute(key, value === true ? '' : value);
        }
    }

    // Flatten arrays and handle all children
    const flatChildren = children.flat(Infinity);
    for (const child of flatChildren) {
        // Filter out null, undefined, false, and empty strings (common in conditional rendering)
        if (child !== null && child !== undefined && child !== false && child !== '') {
            el.append(typeof child === 'string' ? document.createTextNode(child) : child);
        }
    }

    return el;
}

/**
 * Shorthand for createElement
 */
export const h = createElement;

/**
 * Query selector with optional context
 * @param {string} selector
 * @param {Element} [context=document]
 */
export function $(selector, context = document) {
    return context.querySelector(selector);
}

/**
 * Query selector all with optional context
 * @param {string} selector
 * @param {Element} [context=document]
 */
export function $$(selector, context = document) {
    return Array.from(context.querySelectorAll(selector));
}

/**
 * Add event listener with optional delegation
 * @param {Element} el - Target element
 * @param {string} event - Event type
 * @param {string|function} selectorOrHandler - Selector for delegation or handler
 * @param {function} [handler] - Handler if using delegation
 */
export function on(el, event, selectorOrHandler, handler) {
    if (typeof selectorOrHandler === 'function') {
        el.addEventListener(event, selectorOrHandler);
        return () => el.removeEventListener(event, selectorOrHandler);
    }

    const delegatedHandler = (e) => {
        const target = e.target.closest(selectorOrHandler);
        if (target && el.contains(target)) {
            handler.call(target, e);
        }
    };

    el.addEventListener(event, delegatedHandler);
    return () => el.removeEventListener(event, delegatedHandler);
}

/**
 * Toggle class on element
 * @param {Element} el
 * @param {string} className
 * @param {boolean} [force]
 */
export function toggleClass(el, className, force) {
    return el.classList.toggle(className, force);
}

/**
 * Set multiple CSS custom properties
 * @param {Element} el
 * @param {object} props
 */
export function setCssVars(el, props) {
    for (const [key, value] of Object.entries(props)) {
        el.style.setProperty(key.startsWith('--') ? key : `--${key}`, value);
    }
}

/**
 * Wait for element to appear in DOM
 * @param {string} selector
 * @param {number} [timeout=5000]
 */
export function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);

        const observer = new MutationObserver(() => {
            const el = document.querySelector(selector);
            if (el) {
                observer.disconnect();
                resolve(el);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Element not found: ${selector}`));
        }, timeout);
    });
}

/**
 * Debounce function
 * @param {function} fn
 * @param {number} delay
 */
export function debounce(fn, delay) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

/**
 * Throttle function
 * @param {function} fn
 * @param {number} limit
 */
export function throttle(fn, limit) {
    let inThrottle;
    return function (...args) {
        if (!inThrottle) {
            fn.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

/**
 * Build DOM tree from structured object
 * Safer alternative to innerHTML templates
 * @param {object} spec - Element specification
 * @returns {Element}
 * @example
 * buildElement({
 *   tag: 'div',
 *   class: 'container',
 *   children: [
 *     { tag: 'h1', text: 'Title' },
 *     { tag: 'p', text: 'Content' }
 *   ]
 * })
 */
export function buildElement(spec) {
    if (typeof spec === 'string') {
        return document.createTextNode(spec);
    }

    const { tag = 'div', text, children, ...attrs } = spec;
    const el = createElement(tag, attrs);

    if (text) {
        el.textContent = text;
    }

    if (children) {
        for (const child of children) {
            el.appendChild(buildElement(child));
        }
    }

    return el;
}

/**
 * Animate element with Web Animations API
 * @param {Element} el
 * @param {Keyframe[]} keyframes
 * @param {KeyframeAnimationOptions} options
 */
export function animate(el, keyframes, options = {}) {
    return el.animate(keyframes, {
        duration: 300,
        easing: 'ease-out',
        fill: 'forwards',
        ...options
    });
}

/**
 * Fade in animation
 * @param {Element} el
 * @param {number} duration
 */
export function fadeIn(el, duration = 300) {
    el.style.display = '';
    return animate(el, [
        { opacity: 0 },
        { opacity: 1 }
    ], { duration });
}

/**
 * Fade out animation
 * @param {Element} el
 * @param {number} duration
 */
export async function fadeOut(el, duration = 300) {
    await animate(el, [
        { opacity: 1 },
        { opacity: 0 }
    ], { duration }).finished;
    el.style.display = 'none';
}

/**
 * Slide down animation
 * @param {Element} el
 * @param {number} duration
 */
export function slideDown(el, duration = 300) {
    el.style.display = '';
    const height = el.scrollHeight;
    return animate(el, [
        { height: 0, opacity: 0, overflow: 'hidden' },
        { height: `${height}px`, opacity: 1, overflow: 'hidden' }
    ], { duration });
}

export default {
    createElement,
    h,
    $,
    $$,
    on,
    toggleClass,
    setCssVars,
    waitForElement,
    debounce,
    throttle,
    buildElement,
    animate,
    fadeIn,
    fadeOut,
    slideDown
};
