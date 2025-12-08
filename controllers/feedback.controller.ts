import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import UserFeedback from '../models/UserFeedback';
import AnalysisHistory from '../models/AnalysisHistory';
import ContentRelevanceScore from '../models/ContentRelevanceScore';
import contentService from '../services/content.service';
import { analyzeRelevanceLevel } from '../services/relevance-level.service';
import UserInterestLevel from '../models/UserInterestLevel';

export const addFeedback = async (req: AuthenticatedRequest, res: Response) => {
    const { analysisHistoryId, wasCorrect, comment } = req.body;
    const userId = req.user?.userId;

    if (!userId || !analysisHistoryId || wasCorrect === undefined) {
        return res.status(400).json({ message: 'User ID, Analysis History ID, and correctness status are required.' });
    }

    try {
        // Verify that the analysis history entry belongs to the user
        const historyEntry = await AnalysisHistory.findOne({ where: { id: analysisHistoryId, userId } });
        if (!historyEntry) {
            return res.status(404).json({ message: 'Analysis history not found or does not belong to the user.' });
        }

        // Create or update the feedback
        const [feedback, created] = await UserFeedback.upsert({
            userId,
            analysisHistoryId,
            aiVerdict: historyEntry.verdict,
            aiReasoning: historyEntry.reasoning,
            userInterests: historyEntry.interests,
            url: historyEntry.url,
            aiAssessmentWasCorrect: wasCorrect,
            userComment: comment,
        });

        // Обновляем оценки релевантности только при положительной обратной связи
        if (wasCorrect) {
            try {
                console.log(`📊 [Feedback] Updating relevance scores for positive feedback (wasCorrect=true)`);
                const interestsList = historyEntry.interests.split(',').map((i: string) => i.trim().toLowerCase());
                
                // Получаем уровни пользователя
                const userLevelsRecords = await UserInterestLevel.findAll({
                    where: {
                        userId,
                        interest: interestsList,
                    },
                });

                const userLevels = userLevelsRecords.map(ul => ({
                    interest: ul.interest,
                    level: ul.level,
                }));

                if (userLevels.length > 0) {
                    // Извлекаем контент и анализируем заново для каждого интереса отдельно
                    const { content } = await contentService.extractContentFromUrl(historyEntry.url);
                    const { analyzeRelevanceLevelForInterest } = await import('../services/relevance-level.service');
                    
                    // Обновляем оценки для каждого интереса отдельно
                    for (const interest of interestsList) {
                        const userLevel = userLevels.find(ul => ul.interest.toLowerCase() === interest);
                        if (userLevel) {
                            const relevanceResult = await analyzeRelevanceLevelForInterest(content, interest, userLevel.level);
                            await ContentRelevanceScore.upsert({
                                userId,
                                interest: interest.toLowerCase(),
                                url: historyEntry.url,
                                contentLevel: relevanceResult.contentLevel,
                                relevanceScore: relevanceResult.relevanceScore,
                                explanation: relevanceResult.explanation,
                            });
                            console.log(`💾 Updated relevance score for interest "${interest}" after positive feedback: ${relevanceResult.relevanceScore}/100 (content level: ${relevanceResult.contentLevel})`);
                        }
                    }
                }
            } catch (error: any) {
                console.warn(`⚠️ Failed to update relevance scores after feedback: ${error.message}`);
                // Не прерываем сохранение обратной связи, если обновление оценок не удалось
            }
        } else {
            console.log(`⏭️ [Feedback] Skipping relevance score update: negative feedback (wasCorrect=false)`);
        }

        res.status(201).json(feedback);
    } catch (error: any) {
        console.error('Error adding feedback:', error);
        console.error('Error stack:', error.stack);
        
        // Убеждаемся, что CORS заголовки установлены даже при ошибке
        const origin = req.headers.origin;
        if (origin) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
        
        // Если ошибка связана с БД, возвращаем более информативное сообщение
        if (error.name === 'SequelizeDatabaseError' || error.name === 'SequelizeConnectionError') {
            return res.status(503).json({ message: 'Database temporarily unavailable. Please try again later.', error: 'Database error' });
        }
        
        res.status(500).json({ message: 'Failed to add feedback.', error: error.message });
    }
};
