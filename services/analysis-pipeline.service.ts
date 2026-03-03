/**
 * Композитный пайплайн анализа контента.
 * Один вызов runFullAnalysisPipeline — извлечение контента (для URL) + все этапы анализа и сохранение.
 * Внутри: выбор метода извлечения (Puppeteer → youtube-transcript → ScrapingBee → yt-dlp), retry, AI → темы → relevance → embedding → retain.
 */

import contentService from './content.service';
import { analyzeContent as analyzeContentWithAI, UserFeedbackHistory } from './ai.service';
import { extractThemes, saveUserSemanticTags, compareThemes, clearUserTagsCache, getUserTagsCached, generateSemanticRecommendation } from './semantic.service';
import { analyzeRelevanceLevelForMultipleInterests } from './relevance-level.service';
import { generateAndSaveEmbedding } from './embedding.service';
import { retainArticle } from './hindsight.service';
import { retainArticle as retainGraphitiArticle } from './graphiti.service';
import { validateBeforeRetain } from './retain-validator.service';
import AnalysisHistory from '../models/AnalysisHistory';
import UserInterest from '../models/UserInterest';
import UserInterestLevel from '../models/UserInterestLevel';
import ContentRelevanceScore from '../models/ContentRelevanceScore';

const EXTRACT_RETRY_COUNT = 2;
const EXTRACT_RETRY_DELAY_MS = 2000;

export interface PipelineInput {
    type: 'url' | 'text';
    url?: string;
    text?: string;
}

export interface PipelineOptions {
    interests: string;
    userId?: number;
    mode: 'read' | 'unread';
    feedbackHistory?: UserFeedbackHistory[];
    skipHistorySave?: boolean;
    jobId?: string;
    itemIndex?: number;
    statsItemType?: 'article' | 'video' | 'urls' | 'text';
    onStageStart?: (stageId: number) => void;
    onStageEnd?: (stageId: number, itemType: string) => Promise<void>;
    onJobUpdate?: (updates: { useMetadata?: boolean }) => void;
}

export interface PipelineResult {
    originalUrl: string;
    url: string;
    sourceType: string;
    score?: number;
    verdict?: string;
    summary?: string;
    reasoning?: string;
    relevanceLevel?: any;
    semanticComparison?: any;
    extractedThemes?: string[];
    analysisHistoryId?: number;
    extractedContent?: string;
    error: boolean;
    message?: string;
    [key: string]: any;
}

/**
 * Извлечение контента из URL с retry.
 */
async function extractContentWithRetry(url: string): Promise<{ content: string; sourceType: string }> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= EXTRACT_RETRY_COUNT; attempt++) {
        try {
            const extracted = await contentService.extractContentFromUrl(url);
            return { content: extracted.content, sourceType: extracted.sourceType };
        } catch (e: any) {
            lastError = e;
            if (attempt < EXTRACT_RETRY_COUNT) {
                await new Promise((r) => setTimeout(r, EXTRACT_RETRY_DELAY_MS));
            }
        }
    }
    throw lastError || new Error('Failed to extract content');
}

/**
 * Полный пайплайн анализа: один вызов на одну задачу.
 * Для URL: извлечение контента (с retry) → анализ.
 * Для текста: анализ напрямую.
 */
export async function runFullAnalysisPipeline(
    input: PipelineInput,
    options: PipelineOptions
): Promise<PipelineResult> {
    const { interests, userId, mode, feedbackHistory = [], skipHistorySave = false } = options;
    let { onStageStart, onStageEnd, onJobUpdate, statsItemType } = options;

    let content: string;
    let url: string;
    let sourceType: string;

    if (input.type === 'text') {
        const text = (input.text || '').trim();
        if (text.length < 20) {
            return {
                originalUrl: `text://${text.substring(0, 50)}...`,
                url: `text://${text.substring(0, 50)}...`,
                sourceType: 'text',
                error: true,
                message: 'Текст слишком короткий для анализа. Минимум 20 символов.',
            };
        }
        content = text;
        url = `text://${text.substring(0, 100)}...`;
        sourceType = 'text';
        onStageStart?.(0);
        await onStageEnd?.(0, 'text');
    } else {
        const urlInput = input.url!;
        onStageStart?.(0);
        try {
            const extracted = await extractContentWithRetry(urlInput);
            content = extracted.content;
            sourceType = extracted.sourceType;
            url = urlInput;
        } catch (extractError: any) {
            return {
                originalUrl: urlInput,
                url: urlInput,
                sourceType: 'article',
                error: true,
                message: extractError?.message || 'Не удалось извлечь контент из URL.',
            };
        }
        await onStageEnd?.(0, sourceType === 'transcript' ? 'video' : 'article');
        if (sourceType === 'metadata') onJobUpdate?.({ useMetadata: true });
        if (!statsItemType) statsItemType = sourceType === 'transcript' ? 'video' : 'article';
    }
    if (!statsItemType) statsItemType = 'article';

    // Валидация контента (для URL)
    if (input.type === 'url' && sourceType !== 'metadata') {
        const errorIndicators = ['Failed to scrape', 'Failed to extract', 'Could not find', 'Chrome not found', 'Error:', 'error:'];
        if (errorIndicators.some((ind) => content.toLowerCase().includes(ind.toLowerCase()))) {
            return {
                originalUrl: url,
                url,
                sourceType,
                error: true,
                message: `Не удалось извлечь контент из URL. ${content.substring(0, 200)}`,
            };
        }
        if (content.trim().length < 20) {
            return {
                originalUrl: url,
                url,
                sourceType,
                error: true,
                message: `Контент слишком короткий (${content.trim().length} символов).`,
            };
        }
    }

    // AI-анализ
    onStageStart?.(input.type === 'text' ? 1 : 2);
    const analysisResult = await analyzeContentWithAI(
        content,
        interests,
        feedbackHistory,
        input.type === 'url' ? input.url : undefined,
        userId,
        sourceType as 'transcript' | 'metadata' | 'article' | 'telegram'
    );
    await onStageEnd?.(input.type === 'text' ? 1 : 2, statsItemType);

    // Темы
    let extractedThemes: string[] = [];
    let semanticComparisonResult: any = null;

    if (userId) {
        onStageStart?.(input.type === 'text' ? 2 : 6);
        const themes = await extractThemes(content);
        await onStageEnd?.(input.type === 'text' ? 2 : 6, statsItemType);
        extractedThemes = themes;

        if (themes.length > 0) {
            if (mode === 'read') {
                await saveUserSemanticTags(userId, themes);
                clearUserTagsCache(userId);
            } else if (mode === 'unread') {
                onStageStart?.(4);
                const userTagsWithWeights = await getUserTagsCached(userId);
                semanticComparisonResult = await compareThemes(themes, userTagsWithWeights, userId);
                await onStageEnd?.(4, statsItemType);
                if (semanticComparisonResult.hasNoTags) {
                    semanticComparisonResult = {
                        ...semanticComparisonResult,
                        semanticVerdict: 'У вас пока нет тегов в "облако смыслов". Проанализируйте несколько статей в режиме "Я это прочитал и понравилось".',
                    };
                } else {
                    try {
                        const semanticVerdict = await generateSemanticRecommendation(themes, userTagsWithWeights, semanticComparisonResult, content, userId);
                        semanticComparisonResult = { ...semanticComparisonResult, semanticVerdict };
                    } catch {
                        const pct = semanticComparisonResult.matchPercentage;
                        semanticComparisonResult = {
                            ...semanticComparisonResult,
                            semanticVerdict: pct >= 70 ? 'Рекомендуется к прочтению.' : pct >= 40 ? 'Может быть интересна.' : 'Низкое совпадение с интересами.',
                        };
                    }
                }
            }
        }
    }

    // Relevance level
    let relevanceLevelResult: any = null;
    if (userId) {
        const interestsList = interests.split(',').map((i) => i.trim().toLowerCase());
        const userLevelsRecords = await UserInterestLevel.findAll({ where: { userId, interest: interestsList } });
        const interestsWithLevels = interestsList
            .map((interest) => {
                const ul = userLevelsRecords.find((r) => r.interest.toLowerCase() === interest.toLowerCase());
                return ul ? { interest, userLevel: ul.level } : null;
            })
            .filter((item): item is { interest: string; userLevel: 'novice' | 'amateur' | 'professional' } => item !== null);

        if (interestsWithLevels.length > 0) {
            onStageStart?.(5);
            try {
                const results = await Promise.race([
                    analyzeRelevanceLevelForMultipleInterests(content, interestsWithLevels),
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000)),
                ]);
                for (const { interest, result } of results) {
                    await ContentRelevanceScore.upsert({
                        userId: userId!,
                        interest: interest.toLowerCase(),
                        url,
                        contentLevel: result.contentLevel,
                        relevanceScore: result.relevanceScore,
                        explanation: result.explanation,
                    });
                }
                relevanceLevelResult = results[0]?.result;
            } catch (_) {}
            await onStageEnd?.(5, statsItemType);
        }
    }

    // История, эмбеддинг, retain
    let analysisHistoryId: number | undefined;
    if (userId && analysisResult?.summary && !skipHistorySave) {
        const historyPayload: any = {
            userId,
            telegramId: null,
            url,
            sourceType,
            score: analysisResult.score,
            verdict: analysisResult.verdict,
            summary: analysisResult.summary,
            reasoning: analysisResult.reasoning,
            interests,
            extractedThemes: extractedThemes?.length ? JSON.stringify(extractedThemes) : null,
        };
        if (sourceType === 'text') historyPayload.originalText = content;
        const historyRecord = await AnalysisHistory.create(historyPayload);
        analysisHistoryId = historyRecord.id;

        if (analysisResult.summary && analysisResult.summary.length > 50) {
            onStageStart?.(3);
            const textForEmbedding = [analysisResult.summary, url].filter(Boolean).join('\n\n').trim();
            await generateAndSaveEmbedding(textForEmbedding, analysisHistoryId);
            await onStageEnd?.(3, statsItemType);
        } else if (analysisResult.summary && (analysisResult.summary || '').length + (analysisResult.reasoning || '').length > 10) {
            const textForEmbedding = [analysisResult.summary, analysisResult.reasoning, url].filter(Boolean).join(' ').trim();
            if (textForEmbedding.length > 10) {
                try {
                    await generateAndSaveEmbedding(textForEmbedding, analysisHistoryId);
                } catch (_) {}
            }
        }

        const validation = validateBeforeRetain(analysisResult.summary, extractedThemes ?? [], content);
        if (validation.valid) {
            retainArticle({ userId, url, summary: analysisResult.summary, themes: extractedThemes ?? [], verdict: analysisResult.verdict, sourceType: sourceType || 'article' }).catch(() => {});
            retainGraphitiArticle({ userId, url, summary: analysisResult.summary, themes: extractedThemes ?? [], verdict: analysisResult.verdict, sourceType: sourceType || 'article' }).catch(() => {});
        }
    }

    onStageStart?.(input.type === 'text' ? 4 : 7);
    await onStageEnd?.(input.type === 'text' ? 4 : 7, statsItemType);

    return {
        originalUrl: url,
        url,
        sourceType,
        ...analysisResult,
        relevanceLevel: relevanceLevelResult,
        semanticComparison: semanticComparisonResult,
        extractedThemes: extractedThemes?.length ? extractedThemes : undefined,
        analysisHistoryId,
        extractedContent: content,
        error: false,
    };
}
