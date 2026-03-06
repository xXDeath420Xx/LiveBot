/**
 * CertiFried Extension - Toast Container Component
 * Displays notification toasts
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';

class CFToastContainer extends CFBaseComponent {
    _setupSubscriptions() {
        this.subscribe('ui.notifications');
    }

    onMount() {
        // Dismiss on click
        this.on('click', '.cf-toast__close', (e) => {
            const toast = e.target.closest('.cf-toast');
            if (!toast) return;
            const toastId = parseInt(toast.dataset.id, 10);
            this._dismissToast(toastId);
        });
    }

    render() {
        const notifications = this.getState('ui.notifications') || [];

        this.className = 'cf-toast-container';
        this.setContent(
            ...notifications.map(notification => this._renderToast(notification))
        );
    }

    _renderToast(notification) {
        return h('div', {
            class: `cf-toast cf-toast--${notification.type}`,
            dataset: { id: notification.id?.toString() }
        },
            this._renderIcon(notification.type),
            h('span', { class: 'cf-toast__message' }, notification.message),
            h('button', { class: 'cf-toast__close' },
                this._renderCloseIcon()
            )
        );
    }

    _renderIcon(type) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'cf-toast__icon');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

        const icons = {
            success: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
            error: 'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z',
            warning: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
            info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
        };

        path.setAttribute('d', icons[type] || icons.info);

        const colors = {
            success: 'var(--color-success)',
            error: 'var(--color-error)',
            warning: 'var(--color-warning)',
            info: 'var(--color-info)'
        };

        svg.style.color = colors[type] || colors.info;
        svg.appendChild(path);

        return svg;
    }

    _renderCloseIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.style.opacity = '0.5';

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M6 18L18 6M6 6l12 12');
        svg.appendChild(path);

        return svg;
    }

    _dismissToast(id) {
        const notifications = this.getState('ui.notifications') || [];
        this.setState('ui.notifications', notifications.filter(n => n.id !== id));
    }
}

registerComponent('cf-toast-container', CFToastContainer);
export default CFToastContainer;
