import { Router } from 'express';
import { addFeedback } from '../controllers/feedback.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// Route to add feedback, protected by authentication
router.post('/', authMiddleware, addFeedback);

export default router;
