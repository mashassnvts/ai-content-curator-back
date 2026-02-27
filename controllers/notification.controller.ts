import { Response } from 'express';
import AppNotification from '../models/AppNotification';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

export const getNotifications = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ message: 'Unauthorized' });

        const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
        const unreadOnly = req.query.unreadOnly === 'true';

        const where: any = { userId };
        if (unreadOnly) where.read = false;

        const notifications = await AppNotification.findAll({
            where,
            order: [['createdAt', 'DESC']],
            limit,
        });

        const unreadCount = await AppNotification.count({
            where: { userId, read: false },
        });

        return res.json({
            notifications: notifications.map(n => ({
                id: n.id,
                message: n.message,
                channelUsername: n.channelUsername,
                analyzedCount: n.analyzedCount,
                read: n.read,
                createdAt: n.createdAt,
            })),
            unreadCount,
        });
    } catch (error: any) {
        console.error('Error getting notifications:', error);
        return res.status(500).json({ message: 'Error getting notifications' });
    }
};

export const markAsRead = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ message: 'Unauthorized' });

        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ message: 'Invalid ID' });

        const notification = await AppNotification.findOne({
            where: { id, userId },
        });
        if (!notification) return res.status(404).json({ message: 'Notification not found' });

        await notification.update({ read: true });
        return res.json({ success: true });
    } catch (error: any) {
        console.error('Error marking notification as read:', error);
        return res.status(500).json({ message: 'Error updating notification' });
    }
};

export const markAllAsRead = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ message: 'Unauthorized' });

        await AppNotification.update(
            { read: true },
            { where: { userId } }
        );
        return res.json({ success: true });
    } catch (error: any) {
        console.error('Error marking all as read:', error);
        return res.status(500).json({ message: 'Error updating notifications' });
    }
};
