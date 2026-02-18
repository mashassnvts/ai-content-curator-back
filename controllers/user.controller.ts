import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User';
import dotenv from 'dotenv';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import UserInterest from '../models/UserInterest';
import UserService from '../services/user.service';
import { CreateUserDTO, LoginUserDTO } from '../interfaces/user.interface';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET as string;

if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined in the environment variables');
}

class UserController {
    async register(req: Request, res: Response): Promise<void> {
        try {
            const userData: CreateUserDTO = req.body;
            
            // Валидация входных данных
            if (!userData.email || !userData.password || !userData.name) {
                res.status(400).json({ message: 'Все поля обязательны для заполнения' });
                return;
            }
            
            // Проверка формата email
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(userData.email)) {
                res.status(400).json({ message: 'Неверный формат email' });
                return;
            }
            
            const newUser = await UserService.createUser(userData);
            
            // Генерируем токен для нового пользователя
            const token = jwt.sign({ userId: newUser.id }, JWT_SECRET, { expiresIn: '7d' });
            
            res.status(201).json({ 
                user: {
                    id: newUser.id,
                    name: newUser.name,
                    email: newUser.email
                },
                token 
            });
        } catch (error: any) {
            console.error('Registration error:', error);
            
            // Обработка ошибки дубликата email
            if (error.message && error.message.includes('уже существует')) {
                res.status(409).json({ message: error.message });
                return;
            }
            
            // Обработка ошибки Sequelize unique constraint
            if (error.name === 'SequelizeUniqueConstraintError') {
                res.status(409).json({ message: 'Пользователь с таким email уже существует. Используйте другой email или войдите в существующий аккаунт.' });
                return;
            }
            
            res.status(500).json({ message: 'Ошибка при регистрации пользователя', error: error.message || 'Неизвестная ошибка' });
        }
    }

    async login(req: Request, res: Response): Promise<Response | void> {
        try {
            const credentials: LoginUserDTO = req.body;
            const token = await UserService.loginUser(credentials);

            if (!token) {
                return res.status(401).json({ message: 'Invalid email or password' });
            }

            return res.status(200).json({ token });
        } catch (error) {
            return res.status(500).json({ message: 'Server error', error });
        }
    }

    async getProfile(req: AuthenticatedRequest, res: Response): Promise<Response | void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                return res.status(401).json({ message: 'Unauthorized' });
            }
            const user = await UserService.getUserById(userId);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }
            return res.status(200).json(user);
        } catch (error) {
            return res.status(500).json({ message: 'Server error', error });
        }
    }

    async getInterests(req: AuthenticatedRequest, res: Response): Promise<Response | void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                return res.status(401).json({ message: 'Unauthorized' });
            }
            const interests = await UserService.getInterests(userId);
            // Явно маппим чтобы убедиться что isActive включен
            const mappedInterests = interests.map(interest => ({
                id: interest.id,
                interest: interest.interest,
                isActive: interest.isActive !== undefined ? interest.isActive : true, // По умолчанию true для старых записей
                lastUsedAt: interest.lastUsedAt,
                createdAt: interest.createdAt,
                updatedAt: interest.updatedAt
            }));
            return res.status(200).json(mappedInterests);
        } catch (error) {
            return res.status(500).json({ message: 'Server error', error });
        }
    }

    async updateInterests(req: AuthenticatedRequest, res: Response): Promise<Response | void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                return res.status(401).json({ message: 'Unauthorized' });
            }
            const { interests } = req.body;
            if (!Array.isArray(interests)) {
                return res.status(400).json({ message: 'Interests must be an array of strings or objects with {interest, level}' });
            }
            const updatedInterests = await UserService.updateInterests(userId, interests);
            return res.status(200).json(updatedInterests);
        } catch (error) {
            return res.status(500).json({ message: 'Server error', error });
        }
    }
    
    /**
     * Добавляет один интерес с опциональным уровнем
     * POST /api/auth/interests/add
     * Body: { interest: "танцы", level?: "novice" }
     */
    async addInterest(req: AuthenticatedRequest, res: Response): Promise<Response | void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                return res.status(401).json({ message: 'Unauthorized' });
            }
            const { interest, level } = req.body;
            if (!interest || typeof interest !== 'string') {
                return res.status(400).json({ message: 'Interest is required and must be a string' });
            }
            
            const validLevels = ['novice', 'amateur', 'professional'];
            if (level && !validLevels.includes(level)) {
                return res.status(400).json({ message: `Level must be one of: ${validLevels.join(', ')}` });
            }
            
            const result = await UserService.addInterest(userId, interest, level);
            return res.status(200).json({
                interest: result.interest,
                level: result.level || null,
            });
        } catch (error: any) {
            return res.status(500).json({ message: 'Server error', error: error.message });
        }
    }

    async getActiveInterests(req: AuthenticatedRequest, res: Response): Promise<Response | void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                return res.status(401).json({ message: 'Unauthorized' });
            }
            const activeInterests = await UserService.getActiveInterests(userId);
            return res.status(200).json(activeInterests);
        } catch (error) {
            return res.status(500).json({ message: 'Server error', error });
        }
    }

    async setActiveInterests(req: AuthenticatedRequest, res: Response): Promise<Response | void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                return res.status(401).json({ message: 'Unauthorized' });
            }
            const { interestIds } = req.body;
            if (!Array.isArray(interestIds)) {
                return res.status(400).json({ message: 'interestIds must be an array of numbers' });
            }
            await UserService.setActiveInterests(userId, interestIds);
            return res.status(200).json({ message: 'Active interests updated' });
        } catch (error) {
            return res.status(500).json({ message: 'Server error', error });
        }
    }

    /**
     * Получает семантические теги пользователя (для "облака смыслов")
     * GET /api/profile/tags?limit=20&sortBy=weight
     * 
     * Query параметры:
     * - limit (number, опционально) - максимальное количество тегов для возврата
     * - sortBy ('weight' | 'date', опционально) - способ сортировки: по весу (важности) или по дате использования
     * 
     * Важно: Семантические теги (темы) - это НЕ интересы пользователя!
     * - Интересы: пользователь сам выбирает категории (например, "AI", "программирование")
     * - Теги: AI автоматически извлекает темы из проанализированных статей (например, "нейронные сети", "оптимизация")
     * Теги накапливаются в "облаке смыслов" на основе того, какие статьи пользователь анализировал.
     */
    async getSemanticTags(req: AuthenticatedRequest, res: Response): Promise<Response | void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                return res.status(401).json({ message: 'Unauthorized' });
            }
            
            // Парсим query-параметры
            const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
            const sortBy = req.query.sortBy === 'date' ? 'date' : 'weight';
            
            // Валидация limit
            if (limit !== undefined && (isNaN(limit) || limit < 1 || limit > 1000)) {
                return res.status(400).json({ 
                    message: 'Invalid limit parameter. Must be a number between 1 and 1000.' 
                });
            }
            
            const tags = await UserService.getSemanticTags(userId, { limit, sortBy });
            
            // Форматируем ответ для удобства использования на фронтенде
            const formattedTags = tags.map(tag => ({
                id: tag.id,
                tag: tag.tag,
                weight: parseFloat(tag.weight.toString()),
                lastUsedAt: tag.lastUsedAt,
                createdAt: tag.createdAt,
                updatedAt: tag.updatedAt,
            }));
            
            return res.status(200).json({
                tags: formattedTags,
                count: formattedTags.length,
            });
        } catch (error) {
            return res.status(500).json({ message: 'Server error', error });
        }
    }

    /**
     * Удаляет семантический тег пользователя
     * DELETE /api/profile/tags/:tagId
     */
    async deleteSemanticTag(req: AuthenticatedRequest, res: Response): Promise<Response | void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                return res.status(401).json({ message: 'Unauthorized' });
            }

            const tagId = parseInt(req.params.tagId, 10);
            if (isNaN(tagId)) {
                return res.status(400).json({ message: 'Invalid tag ID' });
            }

            const deleted = await UserService.deleteSemanticTag(userId, tagId);
            
            if (!deleted) {
                return res.status(404).json({ message: 'Tag not found' });
            }

            return res.status(200).json({ 
                message: 'Tag deleted successfully',
                deleted: true 
            });
        } catch (error) {
            return res.status(500).json({ message: 'Server error', error });
        }
    }

    /**
     * Сохраняет комментарий к анализу и извлекает дополнительные теги из комментария
     * POST /api/analysis/:historyId/comment
     * Body: { comment: string }
     */
    async saveAnalysisComment(req: AuthenticatedRequest, res: Response): Promise<Response | void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                return res.status(401).json({ message: 'Unauthorized' });
            }

            const historyId = parseInt(req.params.historyId, 10);
            if (isNaN(historyId)) {
                return res.status(400).json({ message: 'Invalid history ID' });
            }

            const { comment, articleThemes } = req.body;
            if (!comment || typeof comment !== 'string' || comment.trim().length === 0) {
                return res.status(400).json({ message: 'Comment is required' });
            }

            // Сохраняем комментарий немедленно, анализ тональности делаем асинхронно (в фоне)
            try {
                const AnalysisHistory = (await import('../models/AnalysisHistory')).default;
                const historyRecord = await AnalysisHistory.findByPk(historyId);
                
                if (historyRecord && historyRecord.userId === userId) {
                    // Сохраняем комментарий с временной тональностью "neutral" (будет обновлена асинхронно)
                    const commentData = {
                        comment: comment,
                        articleThemes: articleThemes || [],
                        sentiment: 'neutral' as const, // Временное значение, будет обновлено асинхронно
                        createdAt: new Date().toISOString()
                    };
                    
                    // Добавляем к существующему reasoning или создаем новый
                    let updatedReasoning = historyRecord.reasoning || '';
                    if (updatedReasoning.includes('[COMMENT_DATA]')) {
                        // Заменяем существующий комментарий
                        updatedReasoning = updatedReasoning.replace(
                            /\[COMMENT_DATA\][\s\S]*?\[END_COMMENT_DATA\]/,
                            `[COMMENT_DATA]${JSON.stringify(commentData)}[END_COMMENT_DATA]`
                        );
                    } else {
                        // Добавляем новый комментарий
                        updatedReasoning += `\n\n[COMMENT_DATA]${JSON.stringify(commentData)}[END_COMMENT_DATA]`;
                    }
                    
                    await historyRecord.update({ reasoning: updatedReasoning });
                    console.log(`💾 [saveAnalysisComment] Saved comment and ${articleThemes?.length || 0} article themes to analysis_history ID: ${historyId}`);
                    
                    // Анализируем тональность асинхронно (в фоне) - не блокируем ответ пользователю
                    setImmediate(async () => {
                        try {
                            const { analyzeCommentSentiment } = await import('../services/semantic.service');
                            const sentimentResult = await analyzeCommentSentiment(comment);
                            
                            // Обновляем тональность в сохраненном комментарии
                            const updatedRecord = await AnalysisHistory.findByPk(historyId);
                            if (updatedRecord && updatedRecord.reasoning) {
                                const commentDataMatch = updatedRecord.reasoning.match(/\[COMMENT_DATA\]([\s\S]*?)\[END_COMMENT_DATA\]/);
                                if (commentDataMatch) {
                                    try {
                                        const existingData = JSON.parse(commentDataMatch[1]);
                                        existingData.sentiment = sentimentResult.sentiment;
                                        
                                        const updatedCommentData = `[COMMENT_DATA]${JSON.stringify(existingData)}[END_COMMENT_DATA]`;
                                        const newReasoning = updatedRecord.reasoning.replace(
                                            /\[COMMENT_DATA\][\s\S]*?\[END_COMMENT_DATA\]/,
                                            updatedCommentData
                                        );
                                        
                                        await updatedRecord.update({ reasoning: newReasoning });
                                        console.log(`✅ [saveAnalysisComment] Updated sentiment to ${sentimentResult.sentiment} for comment in history ID: ${historyId}`);
                                    } catch (parseError) {
                                        console.warn(`⚠️ [saveAnalysisComment] Failed to update sentiment: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
                                    }
                                }
                            }
                        } catch (sentimentError: any) {
                            console.warn(`⚠️ [saveAnalysisComment] Failed to analyze sentiment asynchronously: ${sentimentError.message}`);
                            // Игнорируем ошибки анализа тональности - комментарий уже сохранен
                        }
                    });
                }
            } catch (dbError: any) {
                console.warn(`⚠️ [saveAnalysisComment] Failed to save comment to DB: ${dbError.message}`);
                throw dbError; // Пробрасываем ошибку, чтобы вернуть 500
            }

            // Возвращаем ответ немедленно, не дожидаясь анализа тональности
            return res.status(200).json({ 
                message: 'Comment saved successfully',
                commentSaved: true
            });
        } catch (error: any) {
            console.error('Error saving comment:', error);
            return res.status(500).json({ 
                message: 'Server error', 
                error: error.message || 'Unknown error' 
            });
        }
    }

    /**
     * Запрашивает восстановление пароля
     * POST /api/auth/forgot-password
     * Body: { email: string }
     */
    async requestPasswordReset(req: Request, res: Response): Promise<Response | void> {
        try {
            const { email } = req.body;

            if (!email || typeof email !== 'string') {
                return res.status(400).json({ message: 'Email обязателен для заполнения' });
            }

            // Проверка формата email
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return res.status(400).json({ message: 'Неверный формат email' });
            }

            // Запрашиваем восстановление пароля (возвращает код для отображения)
            const result = await UserService.requestPasswordReset(email);

            // Если пользователь не найден - возвращаем общее сообщение для безопасности
            if (!result.success) {
                return res.status(200).json({
                    message: 'Если указанный email существует в системе, код восстановления будет показан на странице.',
                    success: false,
                });
            }

            // Возвращаем код для отображения на странице
            return res.status(200).json({
                success: true,
                resetCode: result.resetCode,
                expiresAt: result.expiresAt,
                message: 'Код восстановления пароля сгенерирован.',
            });
        } catch (error: any) {
            console.error('Error requesting password reset:', error);
            return res.status(500).json({
                message: 'Ошибка при запросе восстановления пароля',
                error: error.message || 'Unknown error',
            });
        }
    }

    /**
     * Сбрасывает пароль по коду восстановления
     * POST /api/auth/reset-password
     * Body: { email: string, resetCode: string, password: string }
     */
    async resetPassword(req: Request, res: Response): Promise<Response | void> {
        try {
            const { email, resetCode, password } = req.body;

            if (!email || typeof email !== 'string') {
                return res.status(400).json({ message: 'Email обязателен' });
            }

            if (!resetCode || typeof resetCode !== 'string') {
                return res.status(400).json({ message: 'Код восстановления обязателен' });
            }

            if (!password || typeof password !== 'string') {
                return res.status(400).json({ message: 'Новый пароль обязателен' });
            }

            // Сбрасываем пароль
            const result = await UserService.resetPassword(email, resetCode, password);

            if (!result.success) {
                return res.status(400).json({ message: result.message });
            }

            return res.status(200).json({
                message: result.message,
            });
        } catch (error: any) {
            console.error('Error resetting password:', error);
            return res.status(500).json({
                message: 'Ошибка при сбросе пароля',
                error: error.message || 'Unknown error',
            });
        }
    }
}
export default new UserController();
