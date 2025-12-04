import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import {
    analyzeRelevanceLevelForUrl,
    setUserInterestLevel,
    getUserInterestLevels,
} from '../controllers/relevance-level.controller';

const router = Router();

// Анализ уровня релевантности контента
router.post('/analyze', authMiddleware, analyzeRelevanceLevelForUrl);

// Установка/обновление уровня пользователя по интересу
router.post('/set-level', authMiddleware, setUserInterestLevel);

// Получение уровней пользователя
router.get('/user-levels', authMiddleware, getUserInterestLevels);

export default router;

