// DOM helpers. Everything the game shows is built with createElement and text nodes; no HTML string is
// ever parsed in this app (Twitch guideline 2.7, and no XSS sinks for player names or server text).

const SVG_NS = 'http://www.w3.org/2000/svg';

function append(parent, children) {
    for (const child of children) {
        if (child == null || child === false || child === true) continue;
        if (Array.isArray(child)) append(parent, child);
        else if (child instanceof Node) parent.appendChild(child);
        else parent.appendChild(document.createTextNode(String(child)));
    }
}

function applyAttrs(el, attrs, isSvg) {
    if (!attrs) return;
    for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === 'on') {
            for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
        } else if (key === 'class') {
            el.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : value);
        } else if (key === 'dataset') {
            for (const [k, v] of Object.entries(value)) if (v != null) el.dataset[k] = String(v);
        } else if (!isSvg && (key === 'value' || key === 'checked' || key === 'selected')) {
            el[key] = value;
        } else if (value === true) {
            el.setAttribute(key, '');
        } else {
            el.setAttribute(key, String(value));
        }
    }
}

/** h('button', { class: 'btn', on: { click } }, 'Text', child, [more]) */
export function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    applyAttrs(el, attrs, false);
    append(el, children);
    return el;
}

/** The same for SVG elements. */
export function s(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    applyAttrs(el, attrs, true);
    append(el, children);
    return el;
}

/** Replace all children of el. */
export function fill(el, ...children) {
    while (el.firstChild) el.removeChild(el.firstChild);
    append(el, children);
    return el;
}

/** Set a CSS custom property through the CSSOM (allowed under a strict style-src). */
export function setVar(el, name, value) {
    el.style.setProperty(name, value);
    return el;
}
