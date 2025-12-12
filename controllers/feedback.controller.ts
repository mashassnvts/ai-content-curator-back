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

        // Сразу возвращаем ответ пользователю, чтобы не блокировать интерфейс
        res.status(201).json(feedback);

        // Обновляем оценки релевантности асинхронно (в фоне) только при положительной обратной связи
        // Это не блокирует ответ пользователю
        if (wasCorrect) {
            // Запускаем обновление оценок в фоне, не дожидаясь результата
            (async () => {
                try {
                    console.log(`📊 [Feedback] Updating relevance scores for positive feedback (wasCorrect=true) - async`);
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
                        // Используем сохраненный контент из истории анализа вместо повторного извлечения
                        // Это намного быстрее и не требует повторного обращения к внешним API
                        const savedContent = historyEntry.summary || historyEntry.reasoning || '';
                        
                        // Если сохраненного контента недостаточно, пропускаем обновление
                        // Оценки уже были сделаны при первоначальном анализе
                        if (savedContent.length < 50) {
                            console.log(`⚠️ [Feedback] Saved content too short (${savedContent.length} chars), skipping relevance score update`);
                            return;
                        }

                        const { analyzeRelevanceLevelForInterest } = await import('../services/relevance-level.service');
                        
                        // Обновляем оценки для каждого интереса отдельно, используя сохраненный контент
                        // Делаем это последовательно, чтобы не перегружать API
                        for (const interest of interestsList) {
                            const userLevel = userLevels.find(ul => ul.interest.toLowerCase() === interest);
                            if (userLevel) {
                                try {
                                    const relevanceResult = await analyzeRelevanceLevelForInterest(savedContent, interest, userLevel.level);
                                    await ContentRelevanceScore.upsert({
                                        userId,
                                        interest: interest.toLowerCase(),
                                        url: historyEntry.url,
                                        contentLevel: relevanceResult.contentLevel,
                                        relevanceScore: relevanceResult.relevanceScore,
                                        explanation: relevanceResult.explanation,
                                    });
                                    console.log(`💾 Updated relevance score for interest "${interest}" after positive feedback: ${relevanceResult.relevanceScore}/100 (content level: ${relevanceResult.contentLevel})`);
                                } catch (interestError: any) {
                                    console.warn(`⚠️ Failed to update relevance score for interest "${interest}": ${interestError.message}`);
                                    // Продолжаем обработку других интересов даже если один не удался
                                }
                            }
                        }
                    }
                } catch (error: any) {
                    console.warn(`⚠️ Failed to update relevance scores after feedback: ${error.message}`);
                    // Ошибка не критична - feedback уже сохранен
                }
            })();
        } else {
            console.log(`⏭️ [Feedback] Skipping relevance score update: negative feedback (wasCorrect=false)`);
        }
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
