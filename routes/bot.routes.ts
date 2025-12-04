import { Router } from 'express';
import BotController from '../controllers/bot.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.post('/link-code', authMiddleware, BotController.generateLinkCode);
router.get('/link-code', authMiddleware, BotController.getLinkCode);
router.post('/link', BotController.linkTelegram);
router.post('/unlink', authMiddleware, BotController.unlinkTelegram);

export default router;

