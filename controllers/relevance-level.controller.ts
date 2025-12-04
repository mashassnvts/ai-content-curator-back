import { Response } from 'express';
import contentService from '../services/content.service';
import { analyzeRelevanceLevel, UserLevel } from '../services/relevance-level.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import UserInterestLevel from '../models/UserInterestLevel';

/**
 * Анализирует уровень релевантности контента по URL
 * POST /api/relevance-level/analyze
 */
export const analyzeRelevanceLevelForUrl = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const userId = req.user?.userId;
        const { url, interests } = req.body;

        if (!url) {
            return res.status(400).json({ error: true, message: 'URL is required' });
        }

        if (!interests) {
            return res.status(400).json({ error: true, message: 'Interests are required' });
        }

        console.log(`🔍 Relevance Level Analysis Request:`);
        console.log(`   URL: ${url}`);
        console.log(`   User ID: ${userId || 'guest'}`);
        console.log(`   Interests: ${interests}`);

        // Извлекаем контент из URL
        const { content } = await contentService.extractContentFromUrl(url);

        // Получаем уровни пользователя по интересам
        let userLevels: UserLevel[] = [];
        if (userId) {
            const interestsList = interests.split(',').map((i: string) => i.trim().toLowerCase());
            const userLevelsRecords = await UserInterestLevel.findAll({
                where: {
                    userId,
                    interest: interestsList,
                },
            });

            userLevels = userLevelsRecords.map(ul => ({
                interest: ul.interest,
                level: ul.level,
            }));

            console.log(`📊 Found ${userLevels.length} user levels for interests`);
        }

        // Анализируем уровень релевантности
        const relevanceResult = await analyzeRelevanceLevel(content, userLevels, interests);

        return res.status(200).json({
            url,
            ...relevanceResult,
        });

    } catch (error: any) {
        console.error(`[Relevance Level Controller] Error: ${error.message}`);
        return res.status(500).json({
            error: true,
            message: error.message || 'Failed to analyze relevance level',
        });
    }
};

/**
 * Устанавливает или обновляет уровень пользователя по интересу
 * POST /api/relevance-level/set-level
 */
export const setUserInterestLevel = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const userId = (req as AuthenticatedRequest).user?.userId;

        if (!userId) {
            return res.status(401).json({ error: true, message: 'Authentication required' });
        }

        const { interest, level } = req.body;

        if (!interest || !level) {
            return res.status(400).json({ error: true, message: 'Interest and level are required' });
        }

        const validLevels = ['novice', 'amateur', 'professional'];
        if (!validLevels.includes(level)) {
            return res.status(400).json({ error: true, message: `Level must be one of: ${validLevels.join(', ')}` });
        }

        const [userLevel, created] = await UserInterestLevel.findOrCreate({
            where: {
                userId,
                interest: interest.toLowerCase().trim(),
            },
            defaults: {
                userId,
                interest: interest.toLowerCase().trim(),
                level,
            },
        });

        if (!created) {
            userLevel.level = level;
            await userLevel.save();
        }

        console.log(`${created ? 'Created' : 'Updated'} user level: ${userId} - ${interest}: ${level}`);

        return res.status(200).json({
            success: true,
            interest: userLevel.interest,
            level: userLevel.level,
            created,
        });

    } catch (error: any) {
        console.error(`[Relevance Level Controller] Error setting level: ${error.message}`);
        return res.status(500).json({
            error: true,
            message: error.message || 'Failed to set user interest level',
        });
    }
};

/**
 * Получает уровни пользователя по интересам
 * GET /api/relevance-level/user-levels
 */
export const getUserInterestLevels = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const userId = (req as AuthenticatedRequest).user?.userId;

        if (!userId) {
            return res.status(401).json({ error: true, message: 'Authentication required' });
        }

        const userLevels = await UserInterestLevel.findAll({
            where: { userId },
            attributes: ['interest', 'level', 'createdAt', 'updatedAt'],
        });

        return res.status(200).json({
            levels: userLevels.map(ul => ({
                interest: ul.interest,
                level: ul.level,
                updatedAt: ul.updatedAt,
            })),
        });

    } catch (error: any) {
        console.error(`[Relevance Level Controller] Error getting levels: ${error.message}`);
        return res.status(500).json({
            error: true,
            message: error.message || 'Failed to get user interest levels',
        });
    }
};

