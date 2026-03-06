/**
 * CertiFried Extension - Notifications Panel Component
 * Persistent notification history and management
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';

const NOTIFICATION_ICONS = {
    harvest_ready: { icon: 'plant', color: '#22c55e' },
    trade_offer: { icon: 'trade', color: '#3b82f6' },
    trade_accepted: { icon: 'check', color: '#22c55e' },
    gift_received: { icon: 'gift', color: '#a855f7' },
    quest_complete: { icon: 'star', color: '#f59e0b' },
    achievement: { icon: 'trophy', color: '#f59e0b' },
    level_up: { icon: 'level', color: '#22c55e' },
    market_sale: { icon: 'dollar', color: '#22c55e' },
    worker_action: { icon: 'worker', color: '#3b82f6' },
    system: { icon: 'info', color: '#6b7280' }
};

class CFNotifications extends CFBaseComponent {
    constructor() {
        super();
        this._notifications = [];
        this._isLoading = true;
        this._unreadCount = 0;
    }

    onMount() {
        this._loadNotifications();

        // Mark as read
        this.on('click', '.cf-notification', async (e) => {
            const notif = e.target.closest('.cf-notification');
            if (!notif) return;
            const notifId = parseInt(notif.dataset.notifId, 10);
            if (notif.classList.contains('cf-notification--unread')) {
                await this._markAsRead(notifId);
            }
        });

        // Mark all as read
        this.on('click', '#mark-all-read', async () => {
            await this._markAllAsRead();
        });
    }

    async _loadNotifications() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._notifications.length === 0;

        if (isFirstLoad) {
            this._isLoading = true;
            this.render();
        }

        try {
            const data = await api.getNotifications();
            this._notifications = data.notifications || [];
            this._unreadCount = this._notifications.filter(n => !n.isRead).length;

        } catch (error) {
            console.error('Failed to load notifications:', error);
        } finally {
            this._isLoading = false;
            this.scheduleRender();
        }
    }

    async _markAsRead(notificationId) {
        try {
            await api.markNotificationRead(notificationId);

            // Update local state
            const notif = this._notifications.find(n => n.id === notificationId);
            if (notif) {
                notif.isRead = true;
                this._unreadCount = Math.max(0, this._unreadCount - 1);
            }

            this.render();

        } catch (error) {
            console.error('Failed to mark notification as read:', error);
        }
    }

    async _markAllAsRead() {
        try {
            await api.markAllNotificationsRead();

            // Update local state
            for (const notif of this._notifications) {
                notif.isRead = true;
            }
            this._unreadCount = 0;

            this.emit('notification', {
                type: 'success',
                message: 'All notifications marked as read'
            });

            this.render();

        } catch (error) {
            console.error('Failed to mark all as read:', error);
        }
    }

    render() {
        this.className = 'cf-section cf-notifications';
        this.setContent(
            // Header
            h('div', { class: 'cf-section__header' },
                h('h2', { class: 'cf-section__title' }, 'Notifications'),
                this._unreadCount > 0 && h('span', { class: 'cf-badge cf-badge--warning' },
                    `${this._unreadCount} unread`
                )
            ),

            // Actions
            this._notifications.length > 0 && this._unreadCount > 0 && h('div', { class: 'cf-notifications__actions mb-3' },
                h('button', {
                    id: 'mark-all-read',
                    class: 'cf-btn cf-btn--secondary cf-btn--sm'
                }, 'Mark All as Read')
            ),

            // Loading
            this._isLoading && h('div', { class: 'cf-loading' },
                h('div', { class: 'cf-spinner' })
            ),

            // Empty state
            !this._isLoading && this._notifications.length === 0 && h('div', { class: 'cf-empty' },
                this._renderEmptyIcon(),
                h('p', { class: 'cf-empty__title' }, 'No Notifications'),
                h('p', { class: 'cf-empty__description' }, 'Game events and updates will appear here')
            ),

            // Notification list
            !this._isLoading && this._notifications.length > 0 && h('div', { class: 'cf-notification-list' },
                ...this._notifications.map(notif => this._renderNotification(notif))
            )
        );
    }

    _renderNotification(notif) {
        const iconInfo = NOTIFICATION_ICONS[notif.type] || NOTIFICATION_ICONS.system;
        const isUnread = !notif.isRead;

        return h('div', {
            class: `cf-notification ${isUnread ? 'cf-notification--unread' : ''}`,
            dataset: { notifId: notif.id.toString() }
        },
            // Icon
            h('div', {
                class: 'cf-notification__icon',
                style: { background: iconInfo.color }
            }, this._renderIcon(iconInfo.icon)),

            // Content
            h('div', { class: 'cf-notification__content' },
                h('div', { class: 'cf-notification__title' }, notif.title),
                h('div', { class: 'cf-notification__message text-sm text-muted' }, notif.message)
            ),

            // Time
            h('div', { class: 'cf-notification__time text-xs text-muted' },
                this._formatTimeAgo(notif.createdAt)
            ),

            // Unread indicator
            isUnread && h('div', { class: 'cf-notification__dot' })
        );
    }

    _renderIcon(iconType) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'white');
        svg.setAttribute('stroke-width', '2');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

        switch (iconType) {
            case 'plant':
                path.setAttribute('d', 'M12 2v6m0 0l3-3m-3 3l-3-3M5 12h14m-7 10v-6');
                break;
            case 'trade':
                path.setAttribute('d', 'M8 7h12l-4 4h4l-8 8 4-8h-4l4-4H8');
                break;
            case 'check':
                path.setAttribute('d', 'M20 6L9 17l-5-5');
                break;
            case 'gift':
                path.setAttribute('d', 'M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z');
                break;
            case 'star':
                path.setAttribute('d', 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z');
                break;
            case 'trophy':
                path.setAttribute('d', 'M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2z');
                break;
            case 'level':
                path.setAttribute('d', 'M13 2L3 14h9l-1 8 10-12h-9l1-8z');
                break;
            case 'dollar':
                path.setAttribute('d', 'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6');
                break;
            case 'worker':
                path.setAttribute('d', 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z');
                break;
            default:
                path.setAttribute('d', 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 16v-4M12 8h.01');
        }

        svg.appendChild(path);
        return svg;
    }

    _renderEmptyIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'cf-empty__icon');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.5');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0');
        svg.appendChild(path);

        return svg;
    }

    _formatTimeAgo(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        return date.toLocaleDateString();
    }
}

registerComponent('cf-notifications', CFNotifications);
export default CFNotifications;
