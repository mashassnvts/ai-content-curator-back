import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import {
    getUserChannels,
    addChannel,
    deleteChannel,
    updateChannel
} from '../controllers/telegram-channel.controller';

const router = Router();

// Все эндпоинты требуют аутентификации
router.get('/', authMiddleware, getUserChannels);
router.post('/', authMiddleware, addChannel);
router.delete('/:id', authMiddleware, deleteChannel);
router.patch('/:id', authMiddleware, updateChannel);

export default router;
