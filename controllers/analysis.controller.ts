import { Response } from 'express';
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

const MAX_URLS_LIMIT = 25;

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
    
    // Проверяем Telegram-ссылку (https://t.me/channel/message_id)
    const telegramPattern = /^https?:\/\/t\.me\/[^\/]+\/\d+/;
    if (telegramPattern.test(trimmed)) {
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
    mode: 'read' | 'unread' = 'read'
) => {
    try {
        if (!text || text.trim().length < 20) {
            throw new Error('Текст слишком короткий для анализа. Минимум 20 символов.');
        }

        const analysisResult = await analyzeContentWithAI(text, interests, feedbackHistory, undefined, userId);
        
        // Обработка семантических тегов в зависимости от режима
        let semanticComparisonResult = null;
        
        if (userId) {
            try {
                console.log(`🎯 [Semantic Tags] Extracting themes from text for user ${userId} (mode: ${mode})...`);
                const themes = await extractThemes(text);
                
                if (themes.length > 0) {
                    console.log(`📌 Extracted ${themes.length} themes:`, themes);
                    
                    if (mode === 'read') {
                        // Режим 'read': сохраняем теги в "облако смыслов" пользователя
                        await saveUserSemanticTags(userId, themes);
                        // Очищаем кэш после сохранения новых тегов
                        clearUserTagsCache(userId);
                        console.log(`✅ [Mode: read] Saved ${themes.length} semantic tags to database`);
                    } else if (mode === 'unread') {
                        // Режим 'unread': сравниваем темы статьи с тегами пользователя (с кэшированием)
                        const userTagsWithWeights = await getUserTagsCached(userId);
                        
                        semanticComparisonResult = compareThemes(themes, userTagsWithWeights);
                        console.log(`📊 [Mode: unread] Comparison result: ${semanticComparisonResult.matchPercentage}% match, ${semanticComparisonResult.matchedThemes.length} themes matched`);
                        
                        if (semanticComparisonResult.hasNoTags) {
                            console.log(`ℹ️ [Mode: unread] User ${userId} has no tags yet - suggesting to use 'read' mode first`);
                            // Добавляем стандартное сообщение для случая без тегов
                            semanticComparisonResult = {
                                ...semanticComparisonResult,
                                semanticVerdict: 'У вас пока нет тегов в "облаке смыслов". Проанализируйте несколько статей в режиме "Я это прочитал и понравилось", чтобы начать формировать облако смыслов и получать персонализированные рекомендации.'
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

        return {
            originalUrl: `text://${text.substring(0, 50)}...`,
            url: `text://${text.substring(0, 50)}...`,
            sourceType: 'text',
            ...analysisResult,
            relevanceLevel: relevanceLevelResult,
            analysisHistoryId,
            semanticComparison: semanticComparisonResult, // Добавляем результат сравнения тегов для режима 'unread'
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
    mode: 'read' | 'unread' = 'read'
) => {
    // Сохраняем полный контент для использования в эмбеддинге
    let fullContentForEmbedding: string | null = null;
    
    try {
        const { content, sourceType } = await contentService.extractContentFromUrl(url);
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

        const analysisResult = await analyzeContentWithAI(content, interests, feedbackHistory, url, userId);
        
        // Обработка семантических тегов в зависимости от режима
        let semanticComparisonResult = null;
        
        if (userId) {
            try {
                console.log(`🎯 [Semantic Tags] Extracting themes from content for user ${userId} (mode: ${mode})...`);
                const themes = await extractThemes(content);
                
                if (themes.length > 0) {
                    console.log(`📌 Extracted ${themes.length} themes:`, themes);
                    
                    if (mode === 'read') {
                        // Режим 'read': сохраняем теги в "облако смыслов" пользователя
                        await saveUserSemanticTags(userId, themes);
                        // Очищаем кэш после сохранения новых тегов
                        clearUserTagsCache(userId);
                        console.log(`✅ [Mode: read] Saved ${themes.length} semantic tags to database`);
                    } else if (mode === 'unread') {
                        // Режим 'unread': сравниваем темы статьи с тегами пользователя (с кэшированием)
                        const userTagsWithWeights = await getUserTagsCached(userId);
                        
                        semanticComparisonResult = compareThemes(themes, userTagsWithWeights);
                        console.log(`📊 [Mode: unread] Comparison result: ${semanticComparisonResult.matchPercentage}% match, ${semanticComparisonResult.matchedThemes.length} themes matched`);
                        
                        if (semanticComparisonResult.hasNoTags) {
                            console.log(`ℹ️ [Mode: unread] User ${userId} has no tags yet - suggesting to use 'read' mode first`);
                            // Добавляем стандартное сообщение для случая без тегов
                            semanticComparisonResult = {
                                ...semanticComparisonResult,
                                semanticVerdict: 'У вас пока нет тегов в "облаке смыслов". Проанализируйте несколько статей в режиме "Я это прочитал и понравилось", чтобы начать формировать облако смыслов и получать персонализированные рекомендации.'
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
                console.log(`📊 [Relevance Level] Starting automatic relevance level analysis for user ${userId}...`);
                const interestsList = interests.split(',').map((i: string) => i.trim().toLowerCase());
                console.log(`📊 [Relevance Level] Checking user levels for interests: ${interestsList.join(', ')}`);
                
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

                console.log(`📊 [Relevance Level] Found ${userLevels.length} user level(s):`, userLevels);

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
                            const { analyzeRelevanceLevelForMultipleInterests } = await import('../services/relevance-level.service');
                            console.log(`🚀 Using optimized analysis: ${interestsWithLevels.length} interests in ONE API request`);
                            
                            // Устанавливаем таймаут для анализа уровня релевантности (максимум 30 секунд)
                            const relevanceResults = await Promise.race([
                                analyzeRelevanceLevelForMultipleInterests(content, interestsWithLevels),
                                new Promise<never>((_, reject) => 
                                    setTimeout(() => reject(new Error('Relevance level analysis timeout')), 30000)
                                )
                            ]);
                            
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
                        
                        await generateAndSaveEmbedding(textForEmbedding, analysisHistoryId);
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
        
        return {
            originalUrl: url,
            sourceType,
            ...analysisResult,
            relevanceLevel: relevanceLevelResult,
            semanticComparison: semanticComparisonResult, // Добавляем результат сравнения тегов для режима 'unread'
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

const handleAnalysisRequest = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { urls: urlInput, interests, mode } = req.body;
        const userId = (req as AuthenticatedRequest).user?.userId;
        
        // Валидация и установка режима по умолчанию
        const analysisMode: 'read' | 'unread' = (mode === 'unread' ? 'unread' : 'read');

        console.log('🎯 ANALYSIS REQUEST DETAILS:', {
            receivedInterests: interests,
            receivedUrls: urlInput,
            userId: userId,
            mode: analysisMode,
            body: req.body
        });

        if (!urlInput || !interests) {
            return res.status(400).json({ message: 'URLs/text and interests are required.' });
        }

        // Преобразуем ввод в строку для обработки
        const inputString = Array.isArray(urlInput) ? urlInput.join('\n') : String(urlInput);
        
        // Объявляем переменные для URL и текстов
        const urls: string[] = [];
        const texts: string[] = [];
        
        // Улучшенная логика парсинга: сначала разбиваем по строкам, потом проверяем каждый элемент
        const lines = inputString.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        
        // Если только одна строка - проверяем, это URL или текст
        if (lines.length === 1) {
            const trimmedInput = lines[0].trim();
            if (isValidUrl(trimmedInput)) {
                urls.push(trimmedInput);
                console.log(`📊 Detected single URL input`);
            } else {
                texts.push(trimmedInput);
                console.log(`📊 Detected single text input (${trimmedInput.length} chars)`);
            }
        } else {
            // Несколько строк - проверяем каждую отдельно
            const nonUrlParts: string[] = [];
            let foundValidUrls = 0;
            
            for (const line of lines) {
                if (isValidUrl(line)) {
                    urls.push(line);
                    foundValidUrls++;
                    console.log(`📊 Detected URL: ${line.substring(0, 50)}...`);
                } else if (line.length > 0) {
                    // Не пустая строка, но не URL - добавляем в тексты
                    nonUrlParts.push(line);
                }
            }
            
            // Если найдены URL - обрабатываем их отдельно
            // Если не найдено ни одного URL - это весь текст с абзацами
            if (foundValidUrls === 0) {
                // Нет URL-ов - это весь текст с абзацами, используем оригинальный текст целиком
                texts.push(inputString);
                console.log(`📊 Detected text input with ${lines.length} lines - processing as single text (${inputString.length} chars)`);
            } else {
                // Есть валидные URL-ы - обрабатываем их отдельно
                // Остальное (если есть) объединяем в тексты
                if (nonUrlParts.length > 0) {
                    const combinedText = nonUrlParts.join('\n\n');
                    if (combinedText.length > 0) {
                        texts.push(combinedText);
                    }
                }
                console.log(`📊 Detected ${urls.length} URL(s) and ${texts.length} text input(s)`);
            }
        }

        // Обрабатываем тексты
        const textResults: any[] = [];
        if (texts.length > 0) {
            console.log(`📝 Processing ${texts.length} text input(s)...`);
            let feedbackHistory: UserFeedbackHistory[] = [];
            if (userId) {
                feedbackHistory = await UserService.getUserFeedbackHistory(userId);
            }
            
            for (let i = 0; i < texts.length; i++) {
                const text = texts[i];
                console.log(`📝 [${i + 1}/${texts.length}] Analyzing text (${text.length} chars) with interests: ${interests}, mode: ${analysisMode}`);
                const result = await processTextAnalysis(text, interests, feedbackHistory, userId, analysisMode);
                textResults.push(result);
            }
        }

        // Раскрываем плейлисты и объединяем все URL
        const allUrls = new Set<string>();
        for (const url of urls) {
            // Проверяем, является ли URL плейлистом YouTube
            const playlistMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
            if (playlistMatch && playlistMatch[1]) {
                try {
                    const playlistId = playlistMatch[1];
                    console.log(`📹 Обнаружен плейлист YouTube, извлекаем видео...`);
                    console.log(`   Playlist ID: ${playlistId}`);
                    console.log(`   Full URL: ${url}`);
                    
                    // Пробуем использовать полный URL, если не работает - используем только ID
                    let playlist;
                    try {
                        playlist = await ytpl(url, { limit: MAX_URLS_LIMIT });
                    } catch (urlError: any) {
                        console.log(`   Попытка с полным URL не удалась, пробуем только ID...`);
                        playlist = await ytpl(playlistId, { limit: MAX_URLS_LIMIT });
                    }
                    
                    if (playlist && playlist.items && playlist.items.length > 0) {
                    console.log(`✅ Извлечено ${playlist.items.length} видео из плейлиста.`);
                        console.log(`   Каждое видео будет обработано отдельно...`);
                        playlist.items.forEach((item: any, index: number) => {
                            let videoUrl: string | null = null;
                            if (item.shortUrl) {
                                videoUrl = item.shortUrl;
                            } else if (item.url) {
                                videoUrl = item.url;
                            } else if (item.id) {
                                videoUrl = `https://www.youtube.com/watch?v=${item.id}`;
                            }
                            
                            if (videoUrl) {
                                allUrls.add(videoUrl);
                                console.log(`   ${index + 1}. ${videoUrl}`);
                            }
                        });
                        console.log(`   Всего будет обработано ${playlist.items.length} видео из плейлиста.`);
                    } else {
                        console.warn(`⚠️ Плейлист пуст или не содержит видео.`);
                        // Если плейлист пуст, пробуем обработать как обычное видео
                        const videoMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/);
                        if (videoMatch && videoMatch[1]) {
                            allUrls.add(`https://www.youtube.com/watch?v=${videoMatch[1]}`);
                        } else {
                            allUrls.add(url);
                        }
                    }
                } catch (error: any) {
                    console.error(`❌ Не удалось обработать плейлист ${url}: ${error.message}`);
                    console.error(`   Stack: ${error.stack}`);
                    // Если не удалось обработать плейлист, пробуем обработать как обычное видео
                    const videoMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/);
                    if (videoMatch && videoMatch[1]) {
                        console.log(`   Обрабатываем как обычное видео: ${videoMatch[1]}`);
                        allUrls.add(`https://www.youtube.com/watch?v=${videoMatch[1]}`);
                    } else {
                    allUrls.add(url);
                    }
                }
            } else {
                allUrls.add(url);
            }
        }

        const uniqueUrls = Array.from(allUrls);

        if (uniqueUrls.length > MAX_URLS_LIMIT) {
            console.warn(`Превышен лимит URL (${uniqueUrls.length}). Обрабатываются первые ${MAX_URLS_LIMIT}.`);
            uniqueUrls.length = MAX_URLS_LIMIT;
        }
        
        // ВАЖНО: Используем ТОЛЬКО переданные интересы, без смешивания
        const finalInterests = interests;
        console.log('🎯 FINAL INTERESTS FOR ANALYSIS:', finalInterests);

        let feedbackHistory: UserFeedbackHistory[] = [];
        if (userId) {
            feedbackHistory = await UserService.getUserFeedbackHistory(userId);
            console.log('📋 Loaded feedback history length:', feedbackHistory.length);
        }

        const urlResults: any[] = [];
        
        if (uniqueUrls.length > 0) {
            console.log(`📋 Всего URL для обработки: ${uniqueUrls.length}`);
            if (uniqueUrls.length > 1) {
                console.log(`   Это плейлист или несколько ссылок - каждое видео будет обработано отдельно.`);
            }
            
            for (let i = 0; i < uniqueUrls.length; i++) {
                const url = uniqueUrls[i];
                console.log(`🔍 [${i + 1}/${uniqueUrls.length}] Analyzing URL: ${url} with interests: ${finalInterests}, mode: ${analysisMode}`);
                const result = await processSingleUrlAnalysis(url, finalInterests, feedbackHistory, userId, analysisMode);
                urlResults.push(result);
                
                // Небольшая задержка между обработкой видео из плейлиста, чтобы не перегружать сервисы
                if (uniqueUrls.length > 1 && i < uniqueUrls.length - 1) {
                    console.log(`   ⏳ Waiting 2 seconds before next video...`);
                    await new Promise(res => setTimeout(res, 2000));
                }
            }
            
            console.log(`✅ Все ${uniqueUrls.length} URL обработаны.`);
        }

        // Объединяем результаты текстов и URL
        const results = [...textResults, ...urlResults];

        // Примечание: сохранение истории и эмбеддингов для URL происходит внутри processSingleUrlAnalysis
        // Для текстов сохранение происходит внутри processTextAnalysis
        // Здесь мы только обновляем lastUsedAt для интересов
        if (userId) {
            try {
                await historyCleanupService.updateInterestUsage(userId, finalInterests.split(',').map((i: string) => i.trim()));
            } catch (error: any) {
                console.warn(`⚠️ Failed to update interest usage: ${error.message}`);
            }
        }

        // Логируем финальные результаты
        console.log('✅ ANALYSIS COMPLETED. Results:', results.map(r => ({
            url: r.originalUrl,
            verdict: r.verdict,
            score: r.score
        })));

        return res.status(200).json(results);

    } catch (error) {
        console.error('❌ Error in handleAnalysisRequest:', error);
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
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
        // ИСПРАВЛЕНИЕ: Используем весь текст (до 50000 символов) для соответствия с тем, что сохраняется в БД
        // При сохранении используется: весь текст статьи (до 50000 символов) + summary + url
        // Для поиска используем переданный текст (summary) с тем же максимумом
        const MAX_TEXT_LENGTH = 50000; // Максимум для очень длинных статей
        const textForEmbedding = text.length > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;
        const queryEmbedding = await generateEmbedding(textForEmbedding);

        // Ищем похожие статьи с адаптивным порогом
        // Порог 45% позволяет находить тематически связанные статьи
        // (например, статьи про ИИ и машинное обучение будут считаться похожими)
        const similarArticles = await findSimilarArticles(
            queryEmbedding,
            userId || undefined,
            historyId || undefined,
            limit || 5,
            0.45 // Порог схожести 45% (мягкий поиск для лучшего покрытия)
        );

        console.log(`📊 [findSimilarArticlesEndpoint] Returning ${similarArticles.length} similar articles for user ${userId}`);

        return res.status(200).json({
            success: true,
            similarArticles,
            count: similarArticles.length,
            queryText: text.substring(0, 100) + (text.length > 100 ? '...' : '')
        });

    } catch (error: any) {
        console.error('Error in findSimilarArticles:', error);
        return res.status(500).json({ 
            message: 'Error finding similar articles',
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