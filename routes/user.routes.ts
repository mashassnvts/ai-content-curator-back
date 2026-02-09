import { Router } from 'express';
import UserController from '../controllers/user.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.post('/register', UserController.register);
router.post('/login', UserController.login);

router.get('/profile', authMiddleware, UserController.getProfile);
router.get('/interests', authMiddleware, UserController.getInterests);
router.post('/interests', authMiddleware, UserController.updateInterests);
router.post('/interests/add', authMiddleware, UserController.addInterest);
router.get('/active-interests', authMiddleware, UserController.getActiveInterests);
router.post('/active-interests', authMiddleware, UserController.setActiveInterests);
router.get('/profile/tags', authMiddleware, UserController.getSemanticTags);
router.delete('/profile/tags/:tagId', authMiddleware, UserController.deleteSemanticTag);


export default router;
