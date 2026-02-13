import { Router } from 'express';
import { analyzeContent, guestAnalyzeContent, getAnalysisStatus, testExtractThemes, findSimilarArticlesEndpoint } from '../controllers/analysis.controller';
import { getHistory, getHistoryItem, reanalyzeFromHistory } from '../controllers/history.controller';
import UserController from '../controllers/user.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.post('/analyze', authMiddleware, analyzeContent);
router.post('/guest-analyze', guestAnalyzeContent);
router.get('/status/:jobId', getAnalysisStatus); // Polling для асинхронного анализа
router.post('/find-similar', authMiddleware, findSimilarArticlesEndpoint); // Поиск похожих статей по эмбеддингу
router.post('/test-extract-themes', testExtractThemes); // Тестовый эндпоинт для проверки извлечения тем
router.get('/history', authMiddleware, getHistory);
router.get('/history/:id', authMiddleware, getHistoryItem);
router.get('/history/:id/reanalyze', authMiddleware, reanalyzeFromHistory);
router.post('/history/:historyId/comment', authMiddleware, UserController.saveAnalysisComment); // Сохранение комментария к анализу

export default router;
