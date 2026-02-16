import { Response } from 'express';
import crypto from 'crypto';
import contentService from '../services/content.service';
import { analyzeContent as analyzeContentWithAI, UserFeedbackHistory } from '../services/ai.service'; 
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import AnalysisHistory from '../models/AnalysisHistory';
import historyCleanupService from '../services/history-cleanup.service';
import { Request } from 'express';
import UserService from '../services/user.service'; 
import { analyzeRelevanceLevel } from '../services/relevance-level.service';
import UserInterestLevel from '../models/UserInterestLevel';
import ContentRelevanceScore from '../models/ContentRelevanceScore';
import ytpl from 'ytpl';
import { extractThemes, saveUserSemanticTags, compareThemes, clearUserTagsCache, getUserTagsCached, generateSemanticRecommendation } from '../services/semantic.service';
import { generateAndSaveEmbedding, findSimilarArticles, generateEmbedding } from '../services/embedding.service';
import { checkUserChannelsNow } from '../services/telegram-channel-monitor.service';
import { getChannelPosts } from '../services/telegram-channel.service';
import UserInterest from '../models/UserInterest';
import AnalysisStageStats from '../models/AnalysisStageStats';
import sequelize from '../config/database';

const MAX_URLS_LIMIT = 25;

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const IS_DEBUG = LOG_LEVEL === 'debug';

// Маппинг этапов для статистики
const STAGE_NAMES: Record<number, string> = {
    0: 'Загрузка контента',
    1: 'Извлечение транскрипта',
    2: 'AI-анализ',
    3: 'Генерация эмбеддинга',
    4: 'Семантическое сравнение',
    5: 'Оценка сложности',
    6: 'Извлечение тем',
    7: 'Формирование выводов'
};

// Хранилище времени начала этапов для каждого jobId
const stageStartTimes = new Map<string, Map<number, number>>();

/**
 * Записывает статистику времени этапа
 */
const recordStageStats = async (stageId: number, stageName: string, itemType: 'channel' | 'urls' | 'text', durationMs: number) => {
    try {
        if (!itemType) {
            console.warn(`⚠️ Cannot record stage stats: itemType is undefined (stageId: ${stageId})`);
            return;
        }
        
        const result = await AnalysisStageStats.create({
            stageId,
            stageName,
            itemType,
            durationMs,
        });
        
        console.log(`📊 [Stage Stats] Recorded: stageId=${stageId}, stageName="${stageName}", itemType="${itemType}", durationMs=${durationMs}ms`);
    } catch (error: any) {
        console.error(`❌ Failed to record stage stats:`, {
            error: error.message,
            stack: error.stack,
            stageId,
            stageName,
            itemType,
            durationMs
        });
    }
};

/**
 * Начинает отслеживание этапа
 */
const startStageTracking = (jobId: string, stageId: number) => {
    if (!stageStartTimes.has(jobId)) {
        stageStartTimes.set(jobId, new Map());
    }
    const jobStages = stageStartTimes.get(jobId)!;
    jobStages.set(stageId, Date.now());
};

/**
 * Завершает отслеживание этапа и записывает статистику
 */
const endStageTracking = async (jobId: string, stageId: number, itemType: 'channel' | 'urls' | 'text' | undefined) => {
    try {
        // Если itemType не передан, пытаемся получить его из job
        let finalItemType = itemType;
        if (!finalItemType) {
            const job = analysisJobs.get(jobId);
            finalItemType = job?.itemType || 'urls'; // По умолчанию 'urls'
            console.log(`ℹ️ [Stage Stats] itemType not provided, using from job: ${finalItemType}`);
        }
        
        const jobStages = stageStartTimes.get(jobId);
        if (!jobStages) {
            console.warn(`⚠️ [Stage Stats] No job stages found for jobId: ${jobId}, stageId: ${stageId}`);
            return;
        }
        
        const startTime = jobStages.get(stageId);
        if (!startTime) {
            console.warn(`⚠️ [Stage Stats] No start time found for jobId: ${jobId}, stageId: ${stageId}`);
            return;
        }
        
        const durationMs = Date.now() - startTime;
        const stageName = STAGE_NAMES[stageId] || `Этап ${stageId}`;
        
        await recordStageStats(stageId, stageName, finalItemType, durationMs);
        jobStages.delete(stageId);
    } catch (error: any) {
        console.error(`❌ [Stage Stats] Error in endStageTracking:`, {
            error: error.message,
            stack: error.stack,
            jobId,
            stageId,
            itemType
        });
    }
};

// Хранилище асинхронных задач анализа (jobId -> { status, results?, error?, totalExpected?, itemType? })
// Используется для обхода таймаута Railway на длительных запросах
const analysisJobs = new Map<string, { status: 'pending' | 'in_progress' | 'completed' | 'error'; results?: any[]; error?: string; totalExpected?: number; itemType?: 'channel' | 'urls' | 'text'; channelProgress?: number; currentItemIndex?: number; currentStage?: number }>();

/**
 * Проверяет, является ли строка валидным URL
 * Более строгая проверка, чтобы не путать обычный текст с URL
 */
const isValidUrl = (str: string): boolean => {
    const trimmed = str.trim();
    
    // Слишком короткие строки не могут быть URL
    if (trimmed.length < 4) {
        return false;
    }
    
    // Проверяем Telegram-ссылку (https://t.me/channel/message_id или https://t.me/channel)
    const telegramPostPattern = /^https?:\/\/t\.me\/[^\/]+\/\d+/;
    const telegramChannelPattern = /^https?:\/\/t\.me\/([^\/]+)\/?$/; // канал без ID поста (с опциональным / в конце)
    if (telegramPostPattern.test(trimmed) || telegramChannelPattern.test(trimmed)) {
        return true;
    }
    
    // Если содержит пробелы в середине - это не URL
    if (trimmed.includes(' ') && !trimmed.startsWith('http')) {
        return false;
    }
    
    try {
        // Пробуем создать URL объект
        const url = new URL(trimmed);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        // Если не получилось с протоколом, пробуем добавить https://
        try {
            const url = new URL('https://' + trimmed);
            // Проверяем, что это похоже на домен (есть точка и доменная зона)
            const hostname = url.hostname;
            const hasValidDomain = hostname.includes('.') && 
                                 hostname.split('.').length >= 2 &&
                                 hostname.split('.').pop()!.length >= 2 &&
                                 !hostname.includes(' ') &&
                                 hostname.length > 4;
            return hasValidDomain;
        } catch {
            return false;
        }
    }
};

/**
 * Обрабатывает анализ текста напрямую (без извлечения из URL)
 * @param text - Текст для анализа
 * @param interests - Интересы пользователя
 * @param feedbackHistory - История обратной связи пользователя
 * @param userId - ID пользователя (опционально)
 * @param mode - Режим анализа: 'read' (прочитал и понравилось) или 'unread' (стоит ли читать)
 */
const processTextAnalysis = async (
    text: string, 
    interests: string, 
    feedbackHistory: UserFeedbackHistory[] = [], 
    userId?: number,
    mode: 'read' | 'unread' = 'read',
    jobId?: string,
    itemIndex?: number
) => {
    try {
        // Этап 0: Загрузка текста
        if (jobId && itemIndex != null) {
            const job = analysisJobs.get(jobId);
            const itemType = job?.itemType || 'text';
            if (job) {
                analysisJobs.set(jobId, { ...job, currentItemIndex: itemIndex, currentStage: 0 });
                startStageTracking(jobId, 0);
            }
        }

        if (!text || text.trim().length < 20) {
            throw new Error('Текст слишком короткий для анализа. Минимум 20 символов.');
        }
        
        // Завершаем этап 0
        if (jobId && itemIndex != null) {
            const job = analysisJobs.get(jobId);
            const itemType = job?.itemType || 'text';
            await endStageTracking(jobId, 0, itemType);
        }

        // Этап 1: AI-анализ
        if (jobId && itemIndex != null) {
            const job = analysisJobs.get(jobId);
            const itemType = job?.itemType || 'text';
            if (job) {
                analysisJobs.set(jobId, { ...job, currentItemIndex: itemIndex, currentStage: 1 });
                startStageTracking(jobId, 1);
            }
        }

        const analysisResult = await analyzeContentWithAI(text, interests, feedbackHistory, undefined, userId, 'article');
        
        // Завершаем этап 1
        if (jobId && itemIndex != null) {
            const job = analysisJobs.get(jobId);
            const itemType = job?.itemType || 'text';
            await endStageTracking(jobId, 1, itemType);
        }
        
        // Обработка семантических тегов в зависимости от режима
        let semanticComparisonResult = null;
        let extractedThemes: string[] = [];
        
        if (userId) {
            try {
                if (IS_DEBUG) {
                    console.log(`🎯 [Semantic Tags] Extracting themes from text for user ${userId} (mode: ${mode})...`);
                }
                
                // Этап 2: Извлечение тем
                if (jobId && itemIndex != null) {
                    const job = analysisJobs.get(jobId);
                    const itemType = job?.itemType || 'text';
                    if (job) {
                        analysisJobs.set(jobId, { ...job, currentItemIndex: itemIndex, currentStage: 2 });
                        startStageTracking(jobId, 2);
                    }
                }
                
                const themes = await extractThemes(text);
                
                // Завершаем этап 2
                if (jobId && itemIndex != null) {
                    const job = analysisJobs.get(jobId);
                    const itemType = job?.itemType || 'text';
                    await endStageTracking(jobId, 2, itemType);
                }
                
                if (themes.length > 0) {
                    if (IS_DEBUG) {
                        console.log(`📌 Extracted ${themes.length} themes:`, themes);
                    }
                    extractedThemes = themes; // Сохраняем для возврата в результате
                    
                    if (mode === 'read') {
                        // Режим 'read': сохраняем теги в "облако смыслов" пользователя
                        await saveUserSemanticTags(userId, themes);
                        // Очищаем кэш после сохранения новых тегов
                        clearUserTagsCache(userId);
                        console.log(`✅ [Mode: read] Saved ${themes.length} semantic tags to database`);
                    } else if (mode === 'unread') {
                        // Режим 'unread': сравниваем темы статьи с тегами пользователя (с кэшированием)
                        // Этап 4: Семантическое сравнение (для текста)
                        if (jobId && itemIndex != null) {
                            const job = analysisJobs.get(jobId);
                            const itemType = job?.itemType || 'text';
                            if (job) {
                                analysisJobs.set(jobId, { ...job, currentItemIndex: itemIndex, currentStage: 4 });
                                startStageTracking(jobId, 4);
                            }
                        }
                        
                        const userTagsWithWeights = await getUserTagsCached(userId);
                        
                        semanticComparisonResult = await compareThemes(themes, userTagsWithWeights, userId);
                        
                        // Завершаем этап 4
                        if (jobId && itemIndex != null) {
                            const job = analysisJobs.get(jobId);
                            const itemType = job?.itemType || 'text';
                            await endStageTracking(jobId, 4, itemType);
                        }
                        
                        console.log(`📊 [Mode: unread] Comparison result: ${semanticComparisonResult.matchPercentage}% match, ${semanticComparisonResult.matchedThemes.length} themes matched`);
                        
                        if (semanticComparisonResult.hasNoTags) {
                            console.log(`ℹ️ [Mode: unread] User ${userId} has no tags yet - suggesting to use 'read' mode first`);
                            // Добавляем стандартное сообщение для случая без тегов
                            semanticComparisonResult = {
                                ...semanticComparisonResult,
                                semanticVerdict: 'У вас пока нет тегов в "облако смыслов". Проанализируйте несколько статей в режиме "Я это прочитал и понравилось", чтобы начать формировать облако смыслов и получать персонализированные рекомендации.'
                            };
                        } else {
                            // Генерируем AI-рекомендацию на основе сравнения тегов
                            try {
                                const semanticVerdict = await generateSemanticRecommendation(
                                    themes,
                                    userTagsWithWeights,
                                    semanticComparisonResult,
                                    text, // Передаем текст статьи для RAG
                                    userId // Передаем userId для RAG
                                );
                                // Добавляем рекомендацию в результат сравнения
                                semanticComparisonResult = {
                                    ...semanticComparisonResult,
                                    semanticVerdict
                                };
                                console.log(`💡 [Mode: unread] Generated semantic recommendation (${semanticVerdict.length} chars)`);
                            } catch (error: any) {
                                console.error(`❌ [Mode: unread] Failed to generate semantic recommendation: ${error.message}`);
                                console.error(`❌ [Mode: unread] Error stack:`, error.stack);
                                // Добавляем fallback рекомендацию на основе процента совпадения
                                let fallbackVerdict = '';
                                if (semanticComparisonResult.matchPercentage >= 70) {
                                    fallbackVerdict = `Эта статья хорошо соответствует вашим интересам (${semanticComparisonResult.matchPercentage}% совпадение тем). Рекомендуется к прочтению.`;
                                } else if (semanticComparisonResult.matchPercentage >= 40) {
                                    fallbackVerdict = `Статья частично соответствует вашим интересам (${semanticComparisonResult.matchPercentage}% совпадение). Может быть интересна для расширения кругозора.`;
                                } else {
                                    fallbackVerdict = `Статья имеет низкое совпадение с вашими интересами (${semanticComparisonResult.matchPercentage}%). Возможно, стоит поискать более релевантный контент.`;
                                }
                                semanticComparisonResult = {
                                    ...semanticComparisonResult,
                                    semanticVerdict: fallbackVerdict
                                };
                            }
                        }
                    }
                } else {
                    console.log(`ℹ️ No themes extracted from text`);
                }
            } catch (error: any) {
                console.warn(`⚠️ Failed to extract/process semantic tags: ${error.message}`);
                // Не прерываем основной анализ, если извлечение тегов не удалось
            }
        }
        
        // Анализ уровня релевантности (аналогично processSingleUrlAnalysis)
        let relevanceLevelResult = null;
        if (userId) {
            try {
                console.log(`📊 [Relevance Level] Starting automatic relevance level analysis for user ${userId}...`);
                const interestsList = interests.split(',').map((i: string) => i.trim().toLowerCase());
                
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
                    const interestsList = interests.split(',').map((i: string) => i.trim());
                    const interestsWithLevels = interestsList
                        .map(interest => {
                            const userLevel = userLevels.find(ul => ul.interest.toLowerCase() === interest.toLowerCase());
                            return userLevel ? { interest, userLevel: userLevel.level } : null;
                        })
                        .filter((item): item is { interest: string; userLevel: 'novice' | 'amateur' | 'professional' } => item !== null);

                    if (interestsWithLevels.length > 0) {
                        try {
                            const { analyzeRelevanceLevelForMultipleInterests } = await import('../services/relevance-level.service');
                            const relevanceResults = await Promise.race([
                                analyzeRelevanceLevelForMultipleInterests(text, interestsWithLevels),
                                new Promise<never>((_, reject) => 
                                    setTimeout(() => reject(new Error('Relevance level analysis timeout')), 30000)
                                )
                            ]);
                            
                            if (relevanceResults.length > 0) {
                                relevanceLevelResult = relevanceResults[0].result;
                                if (relevanceResults.length > 1) {
                                    const avgScore = Math.round(relevanceResults.reduce((sum, r) => sum + r.result.relevanceScore, 0) / relevanceResults.length);
                                    relevanceLevelResult = {
                                        ...relevanceLevelResult,
                                        relevanceScore: avgScore,
                                        explanation: `Анализ для интересов: ${relevanceResults.map(r => r.interest).join(', ')}. ${relevanceLevelResult.explanation}`,
                                    };
                                }
                            }
                        } catch (error: any) {
                            console.warn(`⚠️ Failed to analyze relevance level: ${error.message}`);
                        }
                    }
                }
            } catch (error: any) {
                console.warn(`⚠️ [Relevance Level] Failed to analyze relevance level: ${error.message}`);
            }
        }

        // Сохраняем в историю, если пользователь авторизован
        let analysisHistoryId: number | undefined;
        if (userId) {
            try {
                const historyRecord = await AnalysisHistory.create({
                    userId,
                    url: `text://${text.substring(0, 100)}...`, // Специальный формат для текста
                    interests,
                    sourceType: 'text',
                    score: analysisResult.score,
                    verdict: analysisResult.verdict,
                    summary: analysisResult.summary,
                    reasoning: analysisResult.reasoning,
                    originalText: text, // Сохраняем оригинальный текст
                });
                analysisHistoryId = historyRecord.id;
                console.log(`💾 Saved text analysis to history (ID: ${analysisHistoryId})`);
                
                // Генерируем и сохраняем эмбеддинг для векторного поиска
                // ИСПРАВЛЕНИЕ: Используем только summary + URL для единообразия с поиском
                // Это обеспечит точное соответствие эмбеддингов при сохранении и поиске
                if (analysisResult.summary && analysisResult.summary.length > 50) {
                    try {
                        // Используем только summary + URL для единообразия с поиском
                        const url = `text://${text.substring(0, 100)}...`;
                        const textForEmbedding = [
                            analysisResult.summary,
                            url
                        ].filter(Boolean).join('\n\n').trim();
                        
                        await generateAndSaveEmbedding(textForEmbedding, analysisHistoryId);
                        console.log(`✅ Generated and saved embedding for analysis_history ID: ${analysisHistoryId} (using summary + URL: ${textForEmbedding.length} chars)`);
                    } catch (embeddingError: any) {
                        console.warn(`⚠️ Failed to generate/save embedding: ${embeddingError.message}`);
                        // Не прерываем основной процесс, если эмбеддинг не удалось сохранить
                    }
                }
            } catch (error: any) {
                console.warn(`⚠️ Failed to save text analysis to history: ${error.message}`);
            }
        }

        // Этап 4: Формирование выводов (для текста)
        if (jobId && itemIndex != null) {
            const job = analysisJobs.get(jobId);
            const itemType = job?.itemType || 'text';
            if (job) {
                analysisJobs.set(jobId, { ...job, currentItemIndex: itemIndex, currentStage: 4 });
                startStageTracking(jobId, 4);
            }
        }
        
        // Завершаем этап 4
        if (jobId && itemIndex != null) {
            const job = analysisJobs.get(jobId);
            const itemType = job?.itemType || 'text';
            setTimeout(async () => {
                await endStageTracking(jobId, 4, itemType);
            }, 100);
        }
        
        return {
            originalUrl: `text://${text.substring(0, 50)}...`,
            url: `text://${text.substring(0, 50)}...`,
            sourceType: 'text',
            ...analysisResult,
            relevanceLevel: relevanceLevelResult,
            semanticComparison: semanticComparisonResult, // Добавляем результат сравнения тегов для режима 'unread'
            extractedThemes: mode === 'read' ? extractedThemes : undefined, // Извлеченные теги для режима 'read'
            analysisHistoryId,
            error: false
        };
    } catch (error: any) {
        console.error(`[Analysis Controller] Failed to process text: ${error.message}`);
        return {
            originalUrl: `text://${text.substring(0, 50)}...`,
            error: true,
            message: error.message || 'Не удалось обработать текст.'
        };
    }
};

/**
 * Обрабатывает анализ контента по URL
 * @param url - URL для анализа
 * @param interests - Интересы пользователя
 * @param feedbackHistory - История обратной связи пользователя
 * @param userId - ID пользователя (опционально)
 * @param mode - Режим анализа: 'read' (прочитал и понравилось) или 'unread' (стоит ли читать)
 */
export const processSingleUrlAnalysis = async (
    url: string, 
    interests: string, 
    feedbackHistory: UserFeedbackHistory[] = [], 
    userId?: number,
    mode: 'read' | 'unread' = 'read',
    jobId?: string,
    itemIndex?: number
) => {
    // Сохраняем полный контент для использования в эмбеддинге
    let fullContentForEmbedding: string | null = null;
    
    try {
        // Проверяем, является ли это ссылкой на Telegram канал (без ID сообщения)
        const telegramChannelMatch = url.match(/^https?:\/\/t\.me\/([^\/]+)$/);
        if (telegramChannelMatch) {
            const channelUsername = telegramChannelMatch[1];
            // Возвращаем специальный результат для канала, который будет обработан на фронтенде
            return {
                originalUrl: url,
                url: url,
                sourceType: 'telegram_channel',
                error: false,
                isChannel: true,
                channelUsername: channelUsername,
                message: `Обнаружен Telegram-канал @${channelUsername}. Для анализа канала используйте специальный API.`
            } as any;
        }

        // Этап 0: Загрузка контента
        if (jobId && itemIndex != null) {
            const job = analysisJobs.get(jobId);
            const itemType = job?.itemType || 'urls';
            if (job) {
                analysisJobs.set(jobId, { ...job, currentItemIndex: itemIndex, currentStage: 0 });
                startStageTracking(jobId, 0);
            }
        }
        
        const { content, sourceType } = await contentService.extractContentFromUrl(url);
        
        // Завершаем этап 0
        if (jobId && itemIndex != null) {
            const job = analysisJobs.get(jobId);
            const itemType = job?.itemType || 'urls';
            await endStageTracking(jobId, 0, itemType);
        }
        
        // Этап 1: Извлечение транскрипта (для видео)
        if (jobId && itemIndex != null && sourceType === 'transcript') {
            const job = analysisJobs.get(jobId);
            const itemType = job?.itemType || 'urls';
            if (job) {
                analysisJobs.set(jobId, { ...job, currentItemIndex: itemIndex, currentStage: 1 });
                startStageTracking(jobId, 1);
            }
            // Транскрипт уже извлечен в extractContentFromUrl, завершаем этап сразу
            await endStageTracking(jobId, 1, itemType);
        }
        
        // Логируем тип источника для диагностики
        if (sourceType === 'transcript') {
            console.log(`✅ Using FULL VIDEO TRANSCRIPT for analysis (${content.length} chars)`);
        } else if (sourceType === 'telegram') {
            console.log(`✅ Using FULL TELEGRAM POST CONTENT for analysis (${content.length} chars)`);
        } else if (sourceType === 'metadata') {
            console.log(`⚠️ Using METADATA ONLY for analysis (${content.length} chars) - NOT full video content`);
        }
        
        // Сохраняем весь контент для эмбеддинга (максимум 50000 символов для очень длинных статей)
        // Используем весь текст для максимально точных эмбеддингов
        const MAX_CONTENT_FOR_EMBEDDING = 50000;
        fullContentForEmbedding = content.length > MAX_CONTENT_FOR_EMBEDDING ? content.substring(0, MAX_CONTENT_FOR_EMBEDDING) : content;

        // Проверяем, не является ли контент сообщением об ошибке
        // НО: пропускаем метаданные с предупреждениями (они все равно содержат полезную информацию)
        const isMetadataWithWarning = sourceType === 'metadata' && content.includes('⚠️ ВАЖНО');
        
        // Для метаданных с предупреждениями разрешаем даже короткий контент (минимум 20 символов)
        // Для обычного контента минимум 30 символов (было 50, но некоторые статьи могут быть короче)
        const minLength = isMetadataWithWarning ? 20 : 30;
        
        // Проверяем на ошибки только если это НЕ метаданные с предупреждением
        if (!isMetadataWithWarning) {
            const errorIndicators = [
                'Failed to scrape',
                'Failed to extract',
                'Could not find',
                'Chrome not found',
                'Cannot find module',
                'Error:',
                'error:',
                'Exception:',
                'exception:',
            ];
            
            // Исключаем проверку на "Не удалось извлечь", так как это может быть частью предупреждения в метаданных
            const isErrorMessage = errorIndicators.some(indicator => 
                content.toLowerCase().includes(indicator.toLowerCase())
            );
            
            // Проверяем длину контента
            const contentLength = content.trim().length;
            
            if (isErrorMessage) {
                throw new Error(`Не удалось извлечь контент из URL. ${content.substring(0, 200)}`);
            }
            
            // Если контент слишком короткий, но не является ошибкой - это может быть метаданные
            if (contentLength < minLength && contentLength >= 20) {
                console.warn(`⚠️ Content is short (${contentLength} chars), but proceeding with analysis (might be metadata)`);
                // Продолжаем анализ, но помечаем как метаданные
            } else if (contentLength < 20) {
                throw new Error(`Не удалось извлечь контент из URL. Контент слишком короткий (${contentLength} символов). ${content.substring(0, 200)}`);
            }
        } else {
            // Если это метаданные с предупреждением, логируем это, но продолжаем анализ
            console.log(`⚠️ Using metadata with warning for analysis (content length: ${content.length} chars)`);
            
            // Проверяем минимальную длину даже для метаданных
            if (content.trim().length < minLength) {
                throw new Error(`Не удалось извлечь достаточно информации из URL. ${content.substring(0, 200)}`);
            }
        }

        // Этап 2: AI-анализ
        if (jobId && itemIndex != null) {
            const job = analysisJobs.get(jobId);
            const itemType = job?.itemType || 'urls';
            if (job) {
                analysisJobs.set(jobId, { ...job, currentItemIndex: itemIndex, currentStage: 2 });
                startStageTracking(jobId, 2);
            }
        }
        
        const analysisResult = await analyzeContentWithAI(content, interests, feedbackHistory, url, userId, sourceType);
        
        // Завершаем этап 2
        if (jobId && itemIndex != null) {
            const job = analysisJobs.get(jobId);
            const itemType = job?.itemType || 'urls';
            await endStageTracking(jobId, 2, itemType);
        }
        
        // Этап 3: Генерация эмбеддинга (начинаем отслеживание, если будет использоваться)
        if (jobId && itemIndex != null && userId && analysisResult?.summary) {
            const job = analysisJobs.get(jobId);
            const itemType = job?.itemType || 'urls';
            if (job && analysisResult.summary.length > 50) {
                startStageTracking(jobId, 3);
            }
        }
        
        // Обработка семантических тегов в зависимости от режима
        let semanticComparisonResult = null;
        let extractedThemes: string[] = [];
        
        if (userId) {
            try {
                if (IS_DEBUG) {
                    console.log(`🎯 [Semantic Tags] Extracting themes from content for user ${userId} (mode: ${mode})...`);
                }
                // Этап 6: Извлечение тем (раньше, чтобы показать прогресс)
                if (jobId && itemIndex != null) {
                    const job = analysisJobs.get(jobId);
                    const itemType = job?.itemType || 'urls';
                    if (job) {
                        analysisJobs.set(jobId, { ...job, currentItemIndex: itemIndex, currentStage: 6 });
                        startStageTracking(jobId, 6);
                    }
                }
                
                const themes = await extractThemes(content);
                
                // Завершаем этап 6
                if (jobId && itemIndex != null) {
                    const job = analysisJobs.get(jobId);
                    const itemType = job?.itemType || 'urls';
                    await endStageTracking(jobId, 6, itemType);
                }
                
                if (themes.length > 0) {
                    if (IS_DEBUG) {
                        console.log(`📌 Extracted ${themes.length} themes:`, themes);
                    }
                    extractedThemes = themes; // Сохраняем для возврата в результате
                    
                    if (mode === 'read') {
                        // Режим 'read': сохраняем теги в "облако смыслов" пользователя
                        await saveUserSemanticTags(userId, themes);
                        // Очищаем кэш после сохранения новых тегов
                        clearUserTagsCache(userId);
                        console.log(`✅ [Mode: read] Saved ${themes.length} semantic tags to database`);
                    } else if (mode === 'unread') {
                        // Режим 'unread': сравниваем темы статьи с тегами пользователя (с кэшированием)
                        // Этап 4: Семантическое сравнение (для видео/URL)
                        if (jobId && itemIndex != null) {
                            const job = analysisJobs.get(jobId);
                            const itemType = job?.itemType || 'urls';
                            if (job) {
                                analysisJobs.set(jobId, { ...job, currentItemIndex: itemIndex, currentStage: 4 });
                                startStageTracking(jobId, 4);
                            }
                        }
                        
                        const userTagsWithWeights = await getUserTagsCached(userId);
                        
                        semanticComparisonResult = await compareThemes(themes, userTagsWithWeights, userId);
                        
                        // Завершаем этап 4
                        if (jobId && itemIndex != null) {
                            const job = analysisJobs.get(jobId);
                            const itemType = job?.itemType || 'urls';
                            await endStageTracking(jobId, 4, itemType);
                        }
                        
                        console.log(`📊 [Mode: unread] Comparison result: ${semanticComparisonResult.matchPercentage}% match, ${semanticComparisonResult.matchedThemes.length} themes matched`);
                        
                        if (semanticComparisonResult.hasNoTags) {
                            console.log(`ℹ️ [Mode: unread] User ${userId} has no tags yet - suggesting to use 'read' mode first`);
                            // Добавляем стандартное сообщение для случая без тегов
                            semanticComparisonResult = {
                                ...semanticComparisonResult,
                                semanticVerdict: 'У вас пока нет тегов в "облако смыслов". Проанализируйте несколько статей в режиме "Я это прочитал и понравилось", чтобы начать формировать облако смыслов и получать персонализированные рекомендации.'
                            };
                        } else {
                            // Генерируем AI-рекомендацию на основе сравнения тегов
                            try {
                                const semanticVerdict = await generateSemanticRecommendation(
                                    themes,
                                    userTagsWithWeights,
                                    semanticComparisonResult,
                                    fullContentForEmbedding || content, // Передаем контент статьи для RAG
                                    userId // Передаем userId для RAG
                                );
                                // Добавляем рекомендацию в результат сравнения
                                semanticComparisonResult = {
                                    ...semanticComparisonResult,
                                    semanticVerdict
                                };
                                console.log(`💡 [Mode: unread] Generated semantic recommendation (${semanticVerdict.length} chars)`);
                            } catch (error: any) {
                                console.error(`❌ [Mode: unread] Failed to generate semantic recommendation: ${error.message}`);
                                console.error(`❌ [Mode: unread] Error stack:`, error.stack);
                                // Добавляем fallback рекомендацию на основе процента совпадения
                                let fallbackVerdict = '';
                                if (semanticComparisonResult.matchPercentage >= 70) {
                                    fallbackVerdict = `Эта статья хорошо соответствует вашим интересам (${semanticComparisonResult.matchPercentage}% совпадение тем). Рекомендуется к прочтению.`;
                                } else if (semanticComparisonResult.matchPercentage >= 40) {
                                    fallbackVerdict = `Статья частично соответствует вашим интересам (${semanticComparisonResult.matchPercentage}% совпадение). Может быть интересна для расширения кругозора.`;
                                } else {
                                    fallbackVerdict = `Статья имеет низкое совпадение с вашими интересами (${semanticComparisonResult.matchPercentage}%). Возможно, стоит поискать более релевантный контент.`;
                                }
                                semanticComparisonResult = {
                                    ...semanticComparisonResult,
                                    semanticVerdict: fallbackVerdict
                                };
                            }
                        }
                    }
                } else {
                    console.log(`ℹ️ No themes extracted from content`);
                }
            } catch (error: any) {
                console.warn(`⚠️ Failed to extract/process semantic tags: ${error.message}`);
                // Не прерываем основной анализ, если извлечение тегов не удалось
            }
        }
        
        // Автоматически анализируем уровень релевантности для авторизированных пользователей
        let relevanceLevelResult = null;
        if (userId) {
            try {
                if (IS_DEBUG) {
                    console.log(`📊 [Relevance Level] Starting automatic relevance level analysis for user ${userId}...`);
                }
                const interestsList = interests.split(',').map((i: string) => i.trim().toLowerCase());
                
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
                    console.log(`📊 [Relevance Level] Analyzing content level and user match for ${userLevels.length} interest(s)...`);
                    
                    // Оптимизированный анализ: анализируем все интересы за один запрос к API
                    const interestsList = interests.split(',').map((i: string) => i.trim());
                    const interestsWithLevels = interestsList
                        .map(interest => {
                            const userLevel = userLevels.find(ul => ul.interest.toLowerCase() === interest.toLowerCase());
                            return userLevel ? { interest, userLevel: userLevel.level } : null;
                        })
                        .filter((item): item is { interest: string; userLevel: 'novice' | 'amateur' | 'professional' } => item !== null);

                    if (interestsWithLevels.length > 0) {
                        try {
                            // Этап 5: Оценка сложности
                            if (jobId && itemIndex != null) {
                                const job = analysisJobs.get(jobId);
                                const itemType = job?.itemType || 'urls';
                                if (job) {
                                    analysisJobs.set(jobId, { ...job, currentItemIndex: itemIndex, currentStage: 5 });
                                    startStageTracking(jobId, 5);
                                }
                            }
                            
                            const { analyzeRelevanceLevelForMultipleInterests } = await import('../services/relevance-level.service');
                            const relevanceResults = await Promise.race([
                                analyzeRelevanceLevelForMultipleInterests(content, interestsWithLevels),
                                new Promise<never>((_, reject) => 
                                    setTimeout(() => reject(new Error('Relevance level analysis timeout')), 30000)
                                )
                            ]);
                            
                            // Завершаем этап 5
                            if (jobId && itemIndex != null) {
                                const job = analysisJobs.get(jobId);
                                const itemType = job?.itemType || 'urls';
                                await endStageTracking(jobId, 5, itemType);
                            }
                            
                            // Сохраняем оценку релевантности для каждого интереса
                            for (const { interest, result } of relevanceResults) {
                                try {
                                    await ContentRelevanceScore.upsert({
                                        userId,
                                        interest: interest.toLowerCase(),
                                        url,
                                        contentLevel: result.contentLevel,
                                        relevanceScore: result.relevanceScore,
                                        explanation: result.explanation,
                                    });
                                    console.log(`💾 Saved relevance score for interest "${interest}": ${result.relevanceScore}/100 (content level: ${result.contentLevel})`);
                                } catch (error: any) {
                                    console.warn(`⚠️ Failed to save relevance score for interest "${interest}": ${error.message}`);
                                }
                            }
                            
                            // Используем первый результат для отображения (или усредняем)
                            if (relevanceResults.length > 0) {
                                relevanceLevelResult = relevanceResults[0].result;
                                if (relevanceResults.length > 1) {
                                    // Если несколько интересов, усредняем оценку
                                    const avgScore = Math.round(relevanceResults.reduce((sum, r) => sum + r.result.relevanceScore, 0) / relevanceResults.length);
                                    relevanceLevelResult = {
                                        ...relevanceLevelResult,
                                        relevanceScore: avgScore,
                                        explanation: `Анализ для интересов: ${relevanceResults.map(r => r.interest).join(', ')}. ${relevanceLevelResult.explanation}`,
                                    };
                                }
                                console.log(`✅ [Relevance Level] Analysis completed successfully:`);
                                console.log(`   - Content Level: ${relevanceLevelResult.contentLevel}`);
                                console.log(`   - User Level Match: ${relevanceLevelResult.userLevelMatch}`);
                                console.log(`   - Relevance Score: ${relevanceLevelResult.relevanceScore}/100`);
                            }
                        } catch (error: any) {
                            const errorMessage = error.message || '';
                            const isQuotaExceeded = errorMessage.includes('quota exceeded') || 
                                                   errorMessage.includes('QUOTA_EXCEEDED') ||
                                                   errorMessage.includes('FreeTier') ||
                                                   (error.status === 429 && errorMessage.includes('limit: 20'));
                            
                            if (isQuotaExceeded) {
                                console.warn(`⏭️ [Relevance Level] Skipping analysis: API quota exceeded. Main analysis will continue without relevance level.`);
                            } else if (errorMessage.includes('timeout')) {
                                console.warn(`⏭️ [Relevance Level] Skipping analysis: timeout. Main analysis will continue without relevance level.`);
                            } else {
                                console.warn(`⚠️ Failed to analyze relevance level: ${error.message}`);
                                console.warn(`   Stack: ${error.stack || 'No stack trace'}`);
                            }
                            // Не прерываем основной анализ, если анализ уровня релевантности не удался
                        }
                    }
                } else {
                    console.log(`⏭️ [Relevance Level] Skipping analysis: no user levels set for interests. User can set levels in profile.`);
                }
            } catch (error: any) {
                console.warn(`⚠️ [Relevance Level] Failed to analyze relevance level: ${error.message}`);
                console.warn(`   Stack: ${error.stack || 'No stack trace'}`);
                // Не прерываем основной анализ, если анализ уровня релевантности не удался
            }
        } else {
            console.log(`⏭️ [Relevance Level] Skipping analysis: user not authenticated (guest mode)`);
        }
        
        // Сохраняем результат анализа в историю и генерируем эмбеддинг (если пользователь авторизован)
        let analysisHistoryId: number | undefined = undefined;
        if (userId && analysisResult?.summary) {
            try {
                const historyRecord = await AnalysisHistory.create({
                    userId,
                    telegramId: null,
                    url,
                    sourceType,
                    score: analysisResult.score,
                    verdict: analysisResult.verdict,
                    summary: analysisResult.summary,
                    reasoning: analysisResult.reasoning,
                    interests,
                });
                analysisHistoryId = historyRecord.id;
                console.log(`💾 Saved URL analysis to history (ID: ${analysisHistoryId})`);
                
                // Генерируем и сохраняем эмбеддинг для векторного поиска
                // ИСПРАВЛЕНИЕ: Используем только summary + URL для единообразия с поиском
                // Это обеспечит точное соответствие эмбеддингов при сохранении и поиске
                // Summary содержит основное содержание статьи, что достаточно для семантического поиска
                if (analysisResult.summary && analysisResult.summary.length > 50) {
                    try {
                        // Используем только summary + URL для единообразия с поиском
                        // Это обеспечит точное соответствие эмбеддингов при сохранении и поиске
                        const textForEmbedding = [
                            analysisResult.summary,
                            url
                        ].filter(Boolean).join('\n\n').trim();
                        
                        // Этап 3: Генерация эмбеддинга
                        if (jobId && itemIndex != null) {
                            const job = analysisJobs.get(jobId);
                            const itemType = job?.itemType || 'urls';
                            if (job) {
                                analysisJobs.set(jobId, { ...job, currentItemIndex: itemIndex, currentStage: 3 });
                            }
                        }
                        
                        await generateAndSaveEmbedding(textForEmbedding, analysisHistoryId);
                        
                        // Завершаем этап 3
                        if (jobId && itemIndex != null) {
                            const job = analysisJobs.get(jobId);
                            const itemType = job?.itemType || 'urls';
                            await endStageTracking(jobId, 3, itemType);
                        }
                        
                        console.log(`✅ Generated and saved embedding for analysis_history ID: ${analysisHistoryId} (using summary + URL: ${textForEmbedding.length} chars)`);
                    } catch (embeddingError: any) {
                        console.warn(`⚠️ Failed to generate/save embedding for ID ${analysisHistoryId}: ${embeddingError.message}`);
                        // Не прерываем основной процесс
                    }
                } else {
                    // Fallback: если summary слишком короткий, используем summary + reasoning (но это не идеально)
                    const textForEmbedding = [
                        analysisResult.summary || '',
                        analysisResult.reasoning || '',
                        url
                    ].filter(Boolean).join(' ').trim();
                    
                    if (textForEmbedding.length > 10) {
                        try {
                            await generateAndSaveEmbedding(textForEmbedding, analysisHistoryId);
                            console.log(`⚠️ Generated and saved embedding for ID ${analysisHistoryId} (using summary+reasoning fallback - not ideal)`);
                        } catch (embeddingError: any) {
                            console.warn(`⚠️ Failed to generate/save embedding for ID ${analysisHistoryId}: ${embeddingError.message}`);
                        }
                    }
                }
            } catch (error: any) {
                console.warn(`⚠️ Failed to save URL analysis to history: ${error.message}`);
            }
        }

        // Этап 7: Формирование выводов (завершаем до return, чтобы job не помечался completed раньше времени)
        if (jobId && itemIndex != null) {
            const job = analysisJobs.get(jobId);
            const itemType = job?.itemType || 'urls';
            if (job) {
                analysisJobs.set(jobId, { ...job, currentItemIndex: itemIndex, currentStage: 7 });
                startStageTracking(jobId, 7);
            }
            // Завершаем этап 7 синхронно, чтобы статус "completed" выставлялся только после записи статистики
            await endStageTracking(jobId, 7, itemType);
        }
        
        return {
            originalUrl: url,
            sourceType,
            ...analysisResult,
            relevanceLevel: relevanceLevelResult,
            semanticComparison: semanticComparisonResult, // Добавляем результат сравнения тегов для режима 'unread'
            extractedThemes: mode === 'read' ? extractedThemes : undefined, // Извлеченные теги для режима 'read'
            analysisHistoryId, // Добавляем ID записи в истории
            error: false
        };
    } catch (error: any) {
        console.error(`[Analysis Controller] Failed to process URL ${url}: ${error.message}`);
        
        return {
            originalUrl: url,
            error: true,
            message: error.message || `Не удалось обработать эту ссылку. Возможно, она приватна, удалена или недоступна.`
        };
    }
};

/**
 * Получить статус асинхронной задачи анализа
 */
export const getAnalysisStatus = async (req: Request, res: Response): Promise<Response> => {
    const { jobId } = req.params;
    if (!jobId) {
        return res.status(400).json({ message: 'jobId is required' });
    }
    const job = analysisJobs.get(jobId);
    if (!job) {
        return res.status(404).json({ message: 'Job not found', status: 'not_found' });
    }
    return res.json(job);
};

const runAnalysisInBackground = async (
    jobId: string,
    urlInput: string | string[],
    interests: string,
    analysisMode: 'read' | 'unread',
    userId?: number
) => {
    try {
        const inputString = Array.isArray(urlInput) ? urlInput.join('\n') : String(urlInput);
        const urls: string[] = [];
        const texts: string[] = [];
        const lines = inputString.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

        if (lines.length === 1) {
            const trimmedInput = lines[0].trim();
            if (isValidUrl(trimmedInput)) urls.push(trimmedInput);
            else texts.push(trimmedInput);
        } else {
            const nonUrlParts: string[] = [];
            let foundValidUrls = 0;
            for (const line of lines) {
                if (isValidUrl(line)) {
                    urls.push(line);
                    foundValidUrls++;
                } else if (line.length > 0) nonUrlParts.push(line);
            }
            if (foundValidUrls === 0) texts.push(inputString);
            else if (nonUrlParts.length > 0) texts.push(nonUrlParts.join('\n\n'));
        }

        const textResults: any[] = [];
        let feedbackHistory: UserFeedbackHistory[] = [];
        if (userId) feedbackHistory = await UserService.getUserFeedbackHistory(userId);

        const allUrls = new Set<string>();
        for (const url of urls) {
            const playlistMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
            if (playlistMatch?.[1]) {
                try {
                    let playlist;
                    try {
                        playlist = await ytpl(url, { limit: MAX_URLS_LIMIT });
                    } catch {
                        playlist = await ytpl(playlistMatch[1], { limit: MAX_URLS_LIMIT });
                    }
                    if (playlist?.items?.length) {
                        playlist.items.forEach((item: any) => {
                            const videoUrl = item.shortUrl || item.url || (item.id ? `https://www.youtube.com/watch?v=${item.id}` : null);
                            if (videoUrl) allUrls.add(videoUrl);
                        });
                    } else {
                        const videoMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/);
                        if (videoMatch?.[1]) allUrls.add(`https://www.youtube.com/watch?v=${videoMatch[1]}`);
                        else allUrls.add(url);
                    }
                } catch {
                    const videoMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/);
                    if (videoMatch?.[1]) allUrls.add(`https://www.youtube.com/watch?v=${videoMatch[1]}`);
                    else allUrls.add(url);
                }
            } else allUrls.add(url);
        }

        const uniqueUrls = Array.from(allUrls).slice(0, MAX_URLS_LIMIT);
        if (userId) feedbackHistory = await UserService.getUserFeedbackHistory(userId);

        // Если есть только текст (без URL), устанавливаем itemType: 'text'
        if (texts.length > 0 && uniqueUrls.length === 0) {
            analysisJobs.set(jobId, {
                status: 'in_progress',
                results: [],
                totalExpected: texts.length,
                itemType: 'text',
                currentStage: 0
            });
        }

        for (let i = 0; i < texts.length; i++) {
            const text = texts[i];
            const job = analysisJobs.get(jobId);
            if (job && texts.length > 0) {
                analysisJobs.set(jobId, { ...job, currentItemIndex: i, itemType: 'text', currentStage: 0 });
            }
            const result = await processTextAnalysis(text, interests, feedbackHistory, userId, analysisMode, jobId, i);
            textResults.push(result);
            // Обновляем job после обработки текста
            if (texts.length > 0) {
                const job = analysisJobs.get(jobId);
                if (job) {
                    analysisJobs.set(jobId, {
                        status: i < texts.length - 1 ? 'in_progress' : (uniqueUrls.length > 0 ? 'in_progress' : 'completed'),
                        results: [...textResults],
                        totalExpected: texts.length,
                        itemType: 'text'
                    });
                }
            }
        }

        const urlResults: any[] = [];
        const POSTS_TO_ANALYZE = 6;

        // Для обычных ссылок — сразу показываем прогресс
        const hasChannels = uniqueUrls.some(u => /^https?:\/\/t\.me\/([^\/]+)\/?$/.test(u));
        if (!hasChannels && uniqueUrls.length > 0) {
            analysisJobs.set(jobId, {
                status: 'in_progress',
                results: [...textResults],
                totalExpected: uniqueUrls.length,
                itemType: 'urls'
            });
        }

        for (let i = 0; i < uniqueUrls.length; i++) {
            const url = uniqueUrls[i];
            const telegramChannelMatch = url.match(/^https?:\/\/t\.me\/([^\/]+)\/?$/);

            if (telegramChannelMatch) {
                // Ссылка на канал (без ID поста) — анализируем последние 6 постов
                const channelUsername = telegramChannelMatch[1].replace('@', '').trim();
                if (!channelUsername) continue;

                analysisJobs.set(jobId, {
                    status: 'in_progress',
                    results: [...textResults, ...urlResults],
                    totalExpected: POSTS_TO_ANALYZE,
                    itemType: 'channel',
                    channelProgress: 0,
                    currentStage: 0 // Этап 0: Загрузка постов канала
                });

                const fetchLimit = Math.max(POSTS_TO_ANALYZE + 5, 15);
                let allFetched: Array<{ messageId: number; text: string; url: string | null; date: Date }> = [];
                try {
                    allFetched = await getChannelPosts(channelUsername, fetchLimit);
                } catch (fetchError: any) {
                    console.error(`❌ [analysis] Failed to fetch posts from @${channelUsername}:`, fetchError.message);
                    const errResult = {
                        originalUrl: url,
                        isChannel: true,
                        channelUsername,
                        channelAnalysis: {
                            totalPosts: 0,
                            relevantPosts: 0,
                            posts: [],
                            recommendation: `Не удалось получить посты из канала @${channelUsername}. Возможно, канал приватный, недоступен или произошла ошибка при загрузке.`
                        }
                    };
                    urlResults.push(errResult);
                    continue;
                }
                
                const posts = allFetched.slice(0, POSTS_TO_ANALYZE);

                if (posts.length === 0) {
                    const errResult = {
                        originalUrl: url,
                        isChannel: true,
                        channelUsername,
                        channelAnalysis: {
                            totalPosts: 0,
                            relevantPosts: 0,
                            posts: [],
                            recommendation: `Не удалось получить посты из канала @${channelUsername}. Возможно, канал приватный или недоступен.`
                        }
                    };
                    urlResults.push(errResult);
                    continue;
                }

                // Для каналов этапы берутся из processSingleUrlAnalysis для каждого поста
                // Этапы будут обновляться внутри processSingleUrlAnalysis
                analysisJobs.set(jobId, {
                    status: 'in_progress',
                    results: [...textResults, ...urlResults],
                    totalExpected: posts.length,
                    itemType: 'channel',
                    currentItemIndex: 0,
                    currentStage: 0 // Этап 0: Загрузка поста канала (для первого поста)
                });

                const analyzedPosts: Array<{ url: string; score: number; verdict: string; summary?: string; reasoning?: string; text?: string }> = [];
                let relevantCount = 0;

                const userTags = userId ? await getUserTagsCached(userId) : [];
                const contextForAnalysis = userTags.length > 0
                    ? userTags.map((t: { tag: string }) => t.tag).join(', ')
                    : userId
                        ? (await UserInterest.findAll({ where: { userId, isActive: true } })).map((ui: { interest: string }) => ui.interest).join(', ')
                        : interests;

                if (!contextForAnalysis) {
                    const errResult = {
                        originalUrl: url,
                        isChannel: true,
                        channelUsername,
                        channelAnalysis: {
                            totalPosts: 0,
                            relevantPosts: 0,
                            posts: [],
                            recommendation: 'Добавьте темы в облако смыслов: проанализируйте статьи в режиме "Я прочитал и понравилось".'
                        }
                    };
                    urlResults.push(errResult);
                    continue;
                }

                for (let j = 0; j < posts.length; j++) {
                    const post = posts[j];
                    if (!post.url) continue;
                    // Для каналов этапы берутся из processSingleUrlAnalysis для каждого поста
                    // Этап 0: Загрузка поста канала (для каждого поста)
                    const job = analysisJobs.get(jobId);
                    if (job) analysisJobs.set(jobId, { ...job, currentItemIndex: j, currentStage: 0 });
                    try {
                        const analysisResult = await processSingleUrlAnalysis(
                            post.url,
                            contextForAnalysis,
                            feedbackHistory,
                            userId,
                            'unread',
                            jobId,
                            j
                        );
                        if (analysisResult && typeof analysisResult === 'object' && !('error' in analysisResult && analysisResult.error)) {
                            const res = analysisResult as any;
                            if (res && typeof res.score === 'number' && typeof res.verdict === 'string') {
                                analyzedPosts.push({
                                    url: post.url,
                                    score: res.score,
                                    verdict: res.verdict,
                                    summary: typeof res.summary === 'string' ? res.summary : undefined,
                                    reasoning: typeof res.reasoning === 'string' ? res.reasoning : undefined,
                                    text: post.text || undefined
                                });
                                if (res.score >= 70) relevantCount++;
                                
                                // Создаем или обновляем результат канала с текущими постами (БЕЗ финальной рекомендации)
                                // Блоки "Результаты анализа" и "Рекомендация" появятся только в конце
                                const channelResult = {
                                    originalUrl: url,
                                    isChannel: true,
                                    channelUsername,
                                    channelAnalysis: {
                                        totalPosts: posts.length,
                                        relevantPosts: relevantCount,
                                        posts: analyzedPosts,
                                        recommendation: undefined // Не добавляем рекомендацию в промежуточных результатах
                                    },
                                    channelUrl: `https://t.me/${channelUsername}`,
                                    isComplete: false // Флаг, что анализ еще не завершен
                                };
                                
                                // Обновляем или добавляем результат канала в urlResults
                                const existingChannelIndex = urlResults.findIndex((r: any) => r.isChannel && r.channelUsername === channelUsername);
                                if (existingChannelIndex >= 0) {
                                    urlResults[existingChannelIndex] = channelResult;
                                } else {
                                    urlResults.push(channelResult);
                                }
                                
                                analysisJobs.set(jobId, {
                                    status: 'in_progress',
                                    results: [...textResults, ...urlResults],
                                    totalExpected: posts.length,
                                    itemType: 'channel',
                                    channelProgress: analyzedPosts.length
                                });
                            }
                        }
                    } catch (analysisError: any) {
                        console.error(`⚠️ [analysis] Failed to analyze post ${post.url}:`, analysisError.message);
                    }
                }

                // Этап 7: Формирование рекомендации (последний этап из processSingleUrlAnalysis)
                const job = analysisJobs.get(jobId);
                if (job) analysisJobs.set(jobId, { ...job, currentStage: 7 });
                
                const finalRecommendation = analyzedPosts.length === 0
                    ? (posts.length === 0 ? 'Не удалось получить посты из канала. Возможно, канал приватный или недоступен.' : 'Не удалось проанализировать посты. Добавьте темы в облако смыслов.')
                    : relevantCount === 0
                        ? `Проанализировано ${analyzedPosts.length} постов. Ни один не совпадает с вашими интересами (порог 70%). Канал можно пропустить.`
                        : `Проанализировано ${analyzedPosts.length} постов. Найдено ${relevantCount} релевантных (${Math.round(relevantCount / analyzedPosts.length * 100)}%). Канал стоит читать!`;
                
                // Обновляем результат канала с финальной рекомендацией
                const existingChannelIndex = urlResults.findIndex((r: any) => r.isChannel && r.channelUsername === channelUsername);
                const finalChannelResult = {
                    originalUrl: url,
                    isChannel: true,
                    channelUsername,
                    channelAnalysis: {
                        totalPosts: analyzedPosts.length,
                        relevantPosts: relevantCount,
                        posts: analyzedPosts,
                        recommendation: finalRecommendation
                    },
                    channelUrl: `https://t.me/${channelUsername}`,
                    isComplete: true // Флаг, что анализ завершен
                };
                
                if (existingChannelIndex >= 0) {
                    urlResults[existingChannelIndex] = finalChannelResult;
                } else {
                    urlResults.push(finalChannelResult);
                }
            } else {
                const job = analysisJobs.get(jobId);
                if (job) analysisJobs.set(jobId, { ...job, currentItemIndex: i, itemType: 'urls', totalExpected: uniqueUrls.length, currentStage: 0 });
                const result = await processSingleUrlAnalysis(url, interests, feedbackHistory, userId, analysisMode, jobId, i);
                urlResults.push(result);
                // Сразу обновляем job — чтобы фронтенд показывал результат, не дожидаясь остальных
                analysisJobs.set(jobId, {
                    status: i < uniqueUrls.length - 1 ? 'in_progress' : 'completed',
                    results: [...textResults, ...urlResults],
                    totalExpected: uniqueUrls.length,
                    itemType: 'urls'
                });
            }
            if (uniqueUrls.length > 1 && i < uniqueUrls.length - 1) await new Promise(r => setTimeout(r, 2000));
        }

        const results = [...textResults, ...urlResults];
        const finalInterests = interests;
        if (userId) {
            try {
                await historyCleanupService.updateInterestUsage(userId, finalInterests.split(',').map((i: string) => i.trim()));
            } catch (e) {}
        }

        analysisJobs.set(jobId, { status: 'completed', results });
        console.log('✅ [Job ' + jobId + '] Analysis completed, results:', results.length);
    } catch (error: any) {
        console.error('❌ [Job ' + jobId + '] Analysis failed:', error.message);
        analysisJobs.set(jobId, { status: 'error', error: error.message || 'Analysis failed' });
    }
};

const handleAnalysisRequest = async (req: Request, res: Response): Promise<Response> => {
    if (res.writableEnded || res.destroyed || !res.writable) {
        console.warn('⚠️ Connection already closed at request start');
        return res;
    }
    
    try {
        const { urls: urlInput, interests, mode } = req.body;
        const userId = (req as AuthenticatedRequest).user?.userId;

        const enableOnDemandChannelMonitoring = process.env.ENABLE_TELEGRAM_CHANNEL_MONITORING_ON_ANALYSIS === 'true';
        if (enableOnDemandChannelMonitoring && userId) {
            setImmediate(() => {
                checkUserChannelsNow(userId).catch((error: any) => {
                    console.error(`❌ [telegram-channel-monitor] On-demand (analysis trigger) failed for user ${userId}:`, error.message);
                });
            });
        }
        
        // Валидация и установка режима по умолчанию
        const analysisMode: 'read' | 'unread' = (mode === 'unread' ? 'unread' : 'read');

        if (IS_DEBUG) {
            console.log('🎯 ANALYSIS REQUEST DETAILS:', {
                receivedInterests: interests,
                receivedUrls: urlInput,
                userId: userId,
                mode: analysisMode,
                body: req.body
            });
        }

        if (!urlInput || !interests) {
            return res.status(400).json({ message: 'URLs/text and interests are required.' });
        }

        // Асинхронный режим: возвращаем jobId сразу, анализ в фоне (обход таймаута Railway)
        const jobId = crypto.randomUUID();
        analysisJobs.set(jobId, { status: 'pending' });
        setImmediate(() => runAnalysisInBackground(jobId, urlInput, interests, analysisMode, userId));
        
        // Удаляем задачу через 1 час (очистка памяти)
        setTimeout(() => analysisJobs.delete(jobId), 3600000);
        
        return res.status(202).json({ jobId, message: 'Analysis started. Poll GET /api/analysis/status/:jobId for results.' });

    } catch (error) {
        console.error('❌ Error in handleAnalysisRequest:', error);
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        
        // Проверяем, не закрыто ли соединение
        if (res.headersSent || res.writableEnded) {
            console.log('⚠️ Response already sent or connection closed, skipping error response');
            return res;
        }
        
        return res.status(500).json({ message: 'Failed to analyze content.', error: errorMessage });
    }
};

export const analyzeContent = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    return handleAnalysisRequest(req, res);
};

export const guestAnalyzeContent = async (req: Request, res: Response): Promise<Response> => {
    return handleAnalysisRequest(req, res);
};

/**
 * Тестовый эндпоинт для проверки извлечения тем из текста
 * POST /api/analysis/test-extract-themes
 * Body: { text: "текст статьи..." }
 */
/**
 * Эндпоинт для поиска похожих статей на основе эмбеддинга
 * POST /api/analysis/find-similar
 * Body: { text: "текст для поиска", historyId?: number, limit?: number }
 */
export const findSimilarArticlesEndpoint = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const { text, historyId, limit } = req.body;
        const userId = req.user?.userId;

        if (!text || typeof text !== 'string') {
            return res.status(400).json({ 
                message: 'Text is required and must be a string',
                error: 'Missing or invalid text parameter'
            });
        }

        if (text.trim().length < 10) {
            return res.status(400).json({ 
                message: 'Text is too short. Minimum 10 characters.',
                error: 'Text too short'
            });
        }

        console.log(`🔍 Finding similar articles for text (${text.length} chars)`);

        // Генерируем эмбеддинг для запроса
        const MAX_TEXT_LENGTH = 50000;
        const textForEmbedding = text.length > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;
        let queryEmbedding: number[];
        try {
            queryEmbedding = await generateEmbedding(textForEmbedding);
        } catch (embErr: any) {
            console.error('Error generating embedding for find-similar:', embErr?.message);
            return res.status(500).json({ 
                message: 'Error generating embedding',
                error: embErr?.message || 'Unknown error',
                similarArticles: []
            });
        }

        // Ищем похожие статьи; при ошибке БД (например, колонка embedding — TEXT вместо vector) возвращаем пустой массив
        let similarArticles: Array<{ id: number; url: string; summary: string | null; similarity: number }>;
        try {
            similarArticles = await findSimilarArticles(
                queryEmbedding,
                userId || undefined,
                historyId || undefined,
                limit || 5,
                0.45
            );
        } catch (dbErr: any) {
            const msg = dbErr?.message || String(dbErr);
            console.warn(`⚠️ [findSimilarArticlesEndpoint] DB error (returning empty): ${msg}`);
            similarArticles = [];
        }

        console.log(`📊 [findSimilarArticlesEndpoint] Returning ${similarArticles.length} similar articles for user ${userId}`);

        return res.status(200).json({
            success: true,
            similarArticles,
            count: similarArticles.length,
            queryText: text.substring(0, 100) + (text.length > 100 ? '...' : '')
        });

    } catch (error: any) {
        console.error('Error in findSimilarArticles:', error);
        return res.status(200).json({ 
            success: true,
            similarArticles: [],
            count: 0,
            message: 'Could not find similar articles',
            error: error.message || 'Unknown error'
        });
    }
};

export const testExtractThemes = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { text } = req.body;
        
        if (!text || typeof text !== 'string') {
            return res.status(400).json({ 
                message: 'Text is required and must be a string',
                error: 'Missing or invalid text parameter'
            });
        }

        if (text.trim().length === 0) {
            return res.status(400).json({ 
                message: 'Text cannot be empty',
                error: 'Empty text provided'
            });
        }

        console.log(`🧪 Testing theme extraction for text (${text.length} chars)`);
        
        const themes = await extractThemes(text);
        
        return res.status(200).json({
            success: true,
            themes,
            themesCount: themes.length,
            textLength: text.length,
        });
    } catch (error: any) {
        console.error('Error in testExtractThemes:', error);
        return res.status(500).json({ 
            message: 'Error extracting themes', 
            error: error.message || 'Unknown error'
        });
    }
};

/**
 * Получить статистику времени этапов анализа
 * GET /api/analysis/stage-stats
 */
export const getStageStats = async (req: Request, res: Response): Promise<Response> => {
    try {
        // Используем snake_case имена колонок (как в БД), результат маппим в camelCase
        const stats = await AnalysisStageStats.findAll({
            attributes: [
                [sequelize.col('stage_id'), 'stageId'],
                [sequelize.col('stage_name'), 'stageName'],
                [sequelize.col('item_type'), 'itemType'],
                [sequelize.fn('AVG', sequelize.col('duration_ms')), 'avgDurationMs'],
                [sequelize.fn('MIN', sequelize.col('duration_ms')), 'minDurationMs'],
                [sequelize.fn('MAX', sequelize.col('duration_ms')), 'maxDurationMs'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'count']
            ],
            group: ['stage_id', 'stage_name', 'item_type'],
            order: [[sequelize.col('item_type'), 'ASC'], [sequelize.col('stage_id'), 'ASC']],
        });

        // Форматируем результаты
        const formattedStats = stats.map((stat: any) => ({
            stageId: stat.stageId,
            stageName: stat.stageName,
            itemType: stat.itemType,
            avgDurationMs: Math.round(parseFloat(stat.dataValues.avgDurationMs || 0)),
            minDurationMs: parseInt(stat.dataValues.minDurationMs || 0),
            maxDurationMs: parseInt(stat.dataValues.maxDurationMs || 0),
            count: parseInt(stat.dataValues.count || 0),
            avgDurationSec: Math.round(parseFloat(stat.dataValues.avgDurationMs || 0) / 1000 * 10) / 10,
            minDurationSec: Math.round(parseInt(stat.dataValues.minDurationMs || 0) / 1000 * 10) / 10,
            maxDurationSec: Math.round(parseInt(stat.dataValues.maxDurationMs || 0) / 1000 * 10) / 10,
        }));

        return res.status(200).json({
            success: true,
            stats: formattedStats,
            totalRecords: formattedStats.reduce((sum, s) => sum + s.count, 0)
        });
    } catch (error: any) {
        console.error('Error fetching stage stats:', error);
        return res.status(500).json({ 
            message: 'Failed to fetch stage stats', 
            error: error.message || 'Unknown error'
        });
    }
};