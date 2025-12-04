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
import ytpl from 'ytpl';

const MAX_URLS_LIMIT = 25;

const processSingleUrlAnalysis = async (url: string, interests: string, feedbackHistory: UserFeedbackHistory[] = [], userId?: number) => {
    try {
        const { content, sourceType } = await contentService.extractContentFromUrl(url);

        const analysisResult = await analyzeContentWithAI(content, interests, feedbackHistory, url);
        
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
                    console.log(`📊 [Relevance Level] Analyzing content level and user match...`);
                    relevanceLevelResult = await analyzeRelevanceLevel(content, userLevels, interests);
                    console.log(`✅ [Relevance Level] Analysis completed successfully:`);
                    console.log(`   - Content Level: ${relevanceLevelResult.contentLevel}`);
                    console.log(`   - User Level Match: ${relevanceLevelResult.userLevelMatch}`);
                    console.log(`   - Relevance Score: ${relevanceLevelResult.relevanceScore}/100`);
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
        
        return {
            originalUrl: url,
            sourceType,
            ...analysisResult,
            relevanceLevel: relevanceLevelResult,
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
        const { urls: urlInput, interests } = req.body;
        const userId = (req as AuthenticatedRequest).user?.userId;

        // ДОБАВИМ ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ
        console.log('🎯 ANALYSIS REQUEST DETAILS:', {
            receivedInterests: interests,
            receivedUrls: urlInput,
            userId: userId,
            body: req.body
        });

        if (!urlInput || !interests) {
            return res.status(400).json({ message: 'URLs and interests are required.' });
        }

        const urls = Array.isArray(urlInput) ? urlInput : String(urlInput).split(/[\n,]+/).map(url => url.trim()).filter(Boolean);
        if (urls.length === 0) {
            return res.status(400).json({ message: 'Please provide at least one valid URL.' });
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

        const results: any[] = [];
        
        console.log(`📋 Всего URL для обработки: ${uniqueUrls.length}`);
        if (uniqueUrls.length > 1) {
            console.log(`   Это плейлист или несколько ссылок - каждое видео будет обработано отдельно.`);
        }
        
        for (let i = 0; i < uniqueUrls.length; i++) {
            const url = uniqueUrls[i];
            console.log(`🔍 [${i + 1}/${uniqueUrls.length}] Analyzing URL: ${url} with interests: ${finalInterests}`);
            const result = await processSingleUrlAnalysis(url, finalInterests, feedbackHistory, userId);
            results.push(result);
            
            // Небольшая задержка между обработкой видео из плейлиста, чтобы не перегружать сервисы
            if (uniqueUrls.length > 1 && i < uniqueUrls.length - 1) {
                console.log(`   ⏳ Waiting 2 seconds before next video...`);
                await new Promise(res => setTimeout(res, 2000));
            }
        }
        
        console.log(`✅ Все ${uniqueUrls.length} видео обработаны.`);

        if (userId) {
            type SuccessfulResult = { 
                originalUrl: string; 
                sourceType: string; 
                score: number; 
                verdict: string; 
                summary: string; 
                reasoning: string; 
                error: false;
            };

            const successfulResults = results.filter(result => !result.error) as SuccessfulResult[];
            
            if (successfulResults.length > 0) {
                const historyCreationPromises = successfulResults.map(result => AnalysisHistory.create({
                    userId,
                    url: result.originalUrl,
                    sourceType: result.sourceType,
                    score: result.score,
                    verdict: result.verdict,
                    summary: result.summary,
                    reasoning: result.reasoning,
                    interests: finalInterests, // Сохраняем актуальные интересы
                }));
                const createdHistories = await Promise.all(historyCreationPromises);

                // Обновляем lastUsedAt для использованных интересов
                await historyCleanupService.updateInterestUsage(userId, finalInterests.split(',').map((i: string) => i.trim()));

                const historyIdMap = new Map<string, number>();
                createdHistories.forEach(history => {
                    historyIdMap.set(history.url, history.id);
                });

                results.forEach((result: any) => {
                    if (!result.error) {
                        result.analysisHistoryId = historyIdMap.get(result.originalUrl);
                    }
                });
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