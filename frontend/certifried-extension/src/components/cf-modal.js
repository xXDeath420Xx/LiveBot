/**
 * CertiFried Extension - Modal Component
 * Reusable modal dialog
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';

class CFModal extends CFBaseComponent {
    static get observedAttributes() {
        return ['open', 'title'];
    }

    onMount() {
        // Close on backdrop click
        this.on('click', (e) => {
            if (e.target === this) {
                this._close();
            }
        });

        // Close on close button
        this.on('click', '.cf-modal__close', () => {
            this._close();
        });

        // Close on escape key
        this._escHandler = (e) => {
            if (e.key === 'Escape' && this.hasAttribute('open')) {
                this._close();
            }
        };
        document.addEventListener('keydown', this._escHandler);
    }

    onUnmount() {
        document.removeEventListener('keydown', this._escHandler);
    }

    render() {
        const isOpen = this.hasAttribute('open');
        const title = this.getAttribute('title') || '';

        if (!isOpen) {
            this.className = '';
            this.style.display = 'none';
            this.setContent();
            return;
        }

        this.className = 'cf-modal-backdrop';
        this.style.display = 'flex';

        // Preserve existing content in the modal body
        const existingBody = this.$('.cf-modal__body');
        const bodyContent = existingBody ? Array.from(existingBody.children) : [];

        this.setContent(
            h('div', { class: 'cf-modal', role: 'dialog', 'aria-modal': 'true' },
                // Header
                h('div', { class: 'cf-modal__header' },
                    h('h3', { class: 'cf-modal__title' }, title),
                    h('button', { class: 'cf-modal__close', 'aria-label': 'Close' },
                        this._renderCloseIcon()
                    )
                ),

                // Body - slot for content
                h('div', { class: 'cf-modal__body' },
                    ...bodyContent
                ),

                // Footer slot
                h('div', { class: 'cf-modal__footer' })
            )
        );
    }

    _renderCloseIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '20');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M6 18L18 6M6 6l12 12');
        svg.appendChild(path);

        return svg;
    }

    _close() {
        this.removeAttribute('open');
        this.emit('close');
    }

    // Public API

    /**
     * Open the modal
     */
    open() {
        this.setAttribute('open', '');
    }

    /**
     * Close the modal
     */
    close() {
        this._close();
    }

    /**
     * Set modal body content
     * @param {...Node} nodes - DOM nodes to set as content
     */
    setContent(...nodes) {
        const body = this.$('.cf-modal__body');
        if (body) {
            body.replaceChildren(...nodes);
        }
    }

    /**
     * Set modal footer content (action buttons)
     * @param {...Node} nodes - DOM nodes to set as footer
     */
    setFooter(...nodes) {
        const footer = this.$('.cf-modal__footer');
        if (footer) {
            footer.replaceChildren(...nodes);
        }
    }
}

registerComponent('cf-modal', CFModal);
export default CFModal;
