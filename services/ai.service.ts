import { generateEmbedding, findSimilarArticles } from './embedding.service';
import { traceGeneration } from '../observability/langfuse-helpers';
import { generateCompletion, getProvider, getModelForRequest } from './llm-provider';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const IS_DEBUG = LOG_LEVEL === 'debug';

export interface UserFeedbackHistory {
    url: string;
    userInterests: string;
    aiVerdict: string;
    aiReasoning: string;
    aiAssessmentWasCorrect: boolean;
    userComment?: string;
}

interface ExtendedFeedback extends UserFeedbackHistory {
    isExactUrlMatch: boolean;
    interestsMatchResult: { match: boolean; matchRatio: number };
    shouldUse: boolean;
}

export interface AnalysisResult {
    score: number;
    verdict: string;
    summary: string;
    reasoning: string;
}

const MAX_CONTENT_LENGTH = 500000; // Максимальная длина контента для анализа

/**
 * Получает RAG контекст из похожих статей пользователя
 * Используется для улучшения анализа за счет истории пользователя
 * 
 * @param content - Текст статьи для анализа
 * @param userId - ID пользователя (опционально)
 * @param interests - Интересы пользователя для фильтрации
 * @returns Контекст из похожих статей или пустая строка
 */
async function getRAGContext(
    content: string,
    userId?: number,
    interests?: string
): Promise<string> {
    // Если нет userId, RAG не используется
    if (!userId) {
        return '';
    }

    try {
        // Генерируем эмбеддинг для текущей статьи (используем весь текст до 50000 символов для максимальной точности)
        const MAX_TEXT_LENGTH = 50000; // Максимум для очень длинных статей
        const textForEmbedding = content.length > MAX_TEXT_LENGTH ? content.substring(0, MAX_TEXT_LENGTH) : content;
        if (textForEmbedding.length < 50) {
            return ''; // Слишком короткий текст для эмбеддинга
        }

        console.log(`🔍 [RAG] Generating embedding for RAG context (${textForEmbedding.length} chars${content.length > MAX_TEXT_LENGTH ? `, truncated from ${content.length}` : ''})...`);
        const articleEmbedding = await generateEmbedding(textForEmbedding);
        
        // Находим похожие статьи из истории пользователя для RAG-контекста
        const similarArticles = await findSimilarArticles(
            articleEmbedding,
            userId,
            undefined, // Не исключаем никакие статьи (может быть новая статья)
            5, // Топ-5 похожих статей
            0.45 // Порог схожести 45% для лучшего покрытия
        );

        if (similarArticles.length === 0) {
            console.log(`ℹ️ [RAG] No similar articles found for user ${userId}`);
            return '';
        }

        console.log(`✅ [RAG] Found ${similarArticles.length} similar articles for RAG context`);

        // Формируем контекст из похожих статей
        const ragContext = `\n\n**📚 КОНТЕКСТ ИЗ ВАШЕЙ ИСТОРИИ (похожие статьи, которые вы анализировали ранее):**
${similarArticles.map((article, idx) => {
            const similarityPercent = Math.round(article.similarity * 100);
            return `
${idx + 1}. URL: ${article.url}
   Похожесть: ${similarityPercent}%
   Саммари: ${article.summary || 'Нет саммари'}
`;
        }).join('')}

**ВАЖНО - ИСПОЛЬЗОВАНИЕ КОНТЕКСТА:**
- Эти статьи похожи на анализируемую статью по смыслу (семантическая схожесть ${Math.round(similarArticles[0].similarity * 100)}%+)
- Используй эту информацию для более точной оценки: если статья похожа на те, что пользователь читал ранее, это может быть хорошим признаком релевантности
- Учитывай, что пользователь уже знаком с похожими темами - это может влиять на оценку сложности и полезности
- Если похожие статьи были оценены высоко (из истории обратной связи), это может указывать на релевантность текущей статьи
- НО: анализируй текущую статью независимо, не копируй оценки из похожих статей безосновательно`;

        return ragContext;
    } catch (error: any) {
        // Если RAG не работает, не прерываем основной анализ
        console.warn(`⚠️ [RAG] Failed to generate RAG context: ${error.message}`);
        return '';
    }
}

export const analyzeContent = async (
    content: string,
    interests: string,
    feedbackHistory: UserFeedbackHistory[] = [],
    currentUrl?: string,
    userId?: number, // Добавляем userId для RAG
    sourceType?: 'transcript' | 'metadata' | 'article' | 'telegram' // Тип источника контента
): Promise<AnalysisResult> => {
    let processedContent = content;
    if (content.length > MAX_CONTENT_LENGTH) {
        console.log(`⚠️ Content is extremely long (${content.length} chars). Using first ${MAX_CONTENT_LENGTH} chars (${Math.round(MAX_CONTENT_LENGTH/content.length*100)}% of content).`);
        processedContent = content.substring(0, MAX_CONTENT_LENGTH);
        } else {
        console.log(`✓ Analyzing full content: ${content.length} chars (full analysis)`);
    }
    
    // Определяем тип контента для промпта
    const contentTypeNote = sourceType === 'transcript' 
        ? 'ВАЖНО: Ты анализируешь ПОЛНЫЙ ТРАНСКРИПТ ВИДЕО - это полная расшифровка всего сказанного в видео. Это НЕ метаданные (название/описание), а весь текст из видео. Анализируй весь транскрипт полностью.'
        : sourceType === 'telegram'
        ? 'ВАЖНО: Ты анализируешь ПОЛНЫЙ ТЕКСТ TELEGRAM ПОСТА - это весь текст сообщения из Telegram канала. Это НЕ метаданные, а полный контент поста. Анализируй весь текст полностью.'
        : sourceType === 'metadata'
        ? 'ВАЖНО: Ты анализируешь ТОЛЬКО МЕТАДАННЫЕ (название и описание видео). Полный транскрипт видео недоступен. Это означает, что у тебя есть только ограниченная информация о содержании видео. ОБЯЗАТЕЛЬНО укажи это в reasoning.'
        : '';

    const systemInstruction = `Ты — интеллектуальный куратор контента. Твоя задача — анализировать ВЕСЬ предоставленный текст полностью на основе ВЫБРАННЫХ интересов пользователя и предоставлять структурированный JSON-ответ.

ОЧЕНЬ ВАЖНО: 
- Весь твой ответ должен быть ТОЛЬКО валидным JSON-объектом БЕЗ markdown разметки (без \`\`\`json и \`\`\`).
- Все значения JSON (summary, reasoning, verdict) ДОЛЖНЫ быть на русском языке.
- Все кавычки и специальные символы в строках ДОЛЖНЫ быть правильно экранированы для валидного JSON.

${contentTypeNote}

**КРИТИЧЕСКИ ВАЖНО:**
- Анализируй ВЕСЬ контент полностью, не пропуская детали. Это может быть длинное видео или статья - проанализируй всё содержимое.
- Анализируй контент ТОЛЬКО на основе интересов, которые указаны в промпте. Это ВЫБРАННЫЕ пользователем интересы для данного анализа.
- НЕ учитывай интересы, которые не указаны в промпте, даже если они могут быть у пользователя.
- Если предоставлена история обратной связи (feedback), используй её ТОЛЬКО для интересов, которые совпадают с ВЫБРАННЫМИ интересами в текущем анализе.

**Формат вывода (ТОЛЬКО JSON, БЕЗ markdown):**
{
    "score": <число от 0 до 100>,
    "verdict": "<'Полезно' or 'Нейтрально' or 'Не трать время'>",
    "summary": "ТОЧНОЕ и ДЕТАЛЬНОЕ саммари на 4-6 предложений, которое отражает ВСЁ основное содержание контента. Укажи: 1) Конкретные темы и концепции, которые разбираются; 2) Конкретные примеры, кейсы, факты из контента; 3) Ключевые моменты и выводы; 4) Для видео - что именно объясняется, какие примеры кода/демонстрации; 5) Для статей - какие разделы, какие данные приводятся. Избегай общих фраз - будь максимально конкретным.",
    "reasoning": "ДЕТАЛЬНОЕ объяснение оценки (минимум 300 символов). Обязательно укажи: 1) Какие конкретно интересы из списка релевантны или не релевантны и ПОЧЕМУ (с примерами из контента); 2) Конкретные фрагменты, темы, примеры из контента, которые подтверждают твою оценку; 3) Если оценка граничная (20, 21, 40, 60, 61, 80), объясни ПОЧЕМУ она именно такая, а не выше/ниже; 4) Если использовалась история обратной связи, укажи как она повлияла на оценку; 5) Если анализ основан только на метаданных, явно укажи это."
}

**Ключевые принципы (строгие правила):**
1.  **Анализ всего контента**: Прочитай и проанализируй ВЕСЬ предоставленный контент полностью. Не ограничивайся началом - важная информация может быть в любой части текста/видео.
2.  **Строгая релевантность**: Определи, является ли контент ПРЯМО релевантным ВЫБРАННЫМ интересам пользователя.
3.  **Будь решителен в оценке**:
    *   **Нерелевантный (Оценка 0-20, Вердикт: 'Не трать время')**: Если контент НЕ затрагивает ПРЯМО ни один из ВЫБРАННЫХ интересов. НЕ создавай слабые или «творческие» связи.
    *   **Частично релевантный (Оценка 21-60, Вердикт: 'Нейтрально')**: Если связан с общей областью одного из интересов, но не напрямую. Например, если интерес "JavaScript", а контент про "программирование вообще" - это частичная релевантность.
    *   **Релевантный (Оценка 61-100, Вердикт: 'Полезно')**: Если это прямое соответствие одному или нескольким ВЫБРАННЫМ интересам.
4.  **Объяснение граничных оценок**: Если ты ставишь граничную оценку (20, 21, 40, 60, 61, 80), ОБЯЗАТЕЛЬНО объясни в reasoning, почему она именно такая, а не на 1-2 балла выше или ниже. Что конкретно делает её граничной?
5.  **Точность саммари**: Саммари должно быть максимально информативным и отражать ВСЁ основное содержание. Укажи конкретные темы, концепции, примеры, названия разделов, ключевые моменты. Для видео - что именно объясняется, какие демонстрации. Для статей - какие данные, исследования, выводы.
6.  **Использование обратной связи**: Если предоставлена история обратной связи, используй её для улучшения понимания предпочтений пользователя, но ТОЛЬКО для интересов, которые есть в текущем списке выбранных интересов.
7.  **Честность об источнике**: Если анализируешь метаданные (указано в промпте), ты ДОЛЖЕН указать это в своем объяснении.`;

    const selectedInterestsList = interests.split(',').map(i => i.trim().toLowerCase());
    
    const interestsMatch = (feedbackInterests: string[], selectedInterests: string[]): { match: boolean; matchRatio: number } => {
        const feedbackSet = new Set(feedbackInterests);
        const selectedSet = new Set(selectedInterests);
        
        let exactMatches = 0;
        feedbackSet.forEach(fi => {
            if (selectedSet.has(fi)) {
                exactMatches++;
            }
        });
        
        let partialMatches = 0;
        feedbackSet.forEach(fi => {
            selectedSet.forEach(si => {
                if (fi.includes(si) || si.includes(fi)) {
                    partialMatches++;
                }
            });
        });
        
        const totalMatches = exactMatches + (partialMatches > exactMatches ? partialMatches - exactMatches : 0);
        const matchRatio = totalMatches / Math.max(feedbackSet.size, selectedSet.size);
        
        return {
            match: matchRatio > 0.3, // Считаем совпадением, если совпадает хотя бы 30% интересов
            matchRatio
        };
    };
    
    const relevantFeedback: ExtendedFeedback[] = feedbackHistory.map((feedback: UserFeedbackHistory) => {
        const feedbackInterests = feedback.userInterests.split(',').map((i: string) => i.trim().toLowerCase());
        const isExactUrlMatch = Boolean(currentUrl && feedback.url && currentUrl === feedback.url);
        const interestsMatchResult = interestsMatch(feedbackInterests, selectedInterestsList);
        
        return {
            ...feedback,
            isExactUrlMatch,
            interestsMatchResult,
            shouldUse: isExactUrlMatch || interestsMatchResult.match
        };
    }).filter((fb: ExtendedFeedback) => fb.shouldUse);

    let feedbackContext = '';
    if (relevantFeedback.length > 0) {
        const negativeFeedback = relevantFeedback.filter(fb => !fb.aiAssessmentWasCorrect);
        const positiveFeedback = relevantFeedback.filter(fb => fb.aiAssessmentWasCorrect);
        
        // Проверяем, есть ли feedback для точно такого же URL
        const exactUrlMatch = currentUrl ? relevantFeedback.find(fb => fb.url === currentUrl) : null;
        const isExactUrlNegative = exactUrlMatch && !exactUrlMatch.aiAssessmentWasCorrect;
        
        feedbackContext = `\n\n**КРИТИЧЕСКИ ВАЖНО - История обратной связи пользователя:**
${relevantFeedback.map((fb, idx) => {
            const isExactMatch = fb.isExactUrlMatch;
            const interestsChanged = fb.interestsMatchResult.matchRatio < 0.7; // Если совпадает меньше 70% интересов
            const currentInterestsStr = selectedInterestsList.join(', ');
            const feedbackInterestsStr = fb.userInterests;
            
            return `
${idx + 1}. URL: ${fb.url}${isExactMatch ? ' ⚠️ ЭТО ТОТ ЖЕ URL, ЧТО АНАЛИЗИРУЕТСЯ СЕЙЧАС!' : ''}
   Интересы в том анализе: ${feedbackInterestsStr}
   Текущие выбранные интересы: ${currentInterestsStr}
   ${interestsChanged ? '⚠️ ВНИМАНИЕ: Интересы ИЗМЕНИЛИСЬ! Пользователь мог добавить новые интересы, которые делают контент релевантным.' : '✅ Интересы совпадают с текущими'}
   Вердикт AI: ${fb.aiVerdict} (оценка: ${fb.aiVerdict === 'Полезно' ? 'высокая' : fb.aiVerdict === 'Нейтрально' ? 'средняя' : 'низкая'})
   Пользователь сказал: ${fb.aiAssessmentWasCorrect ? '✅ ОЦЕНКА БЫЛА ПРАВИЛЬНОЙ - контент действительно релевантен' : '❌ ОЦЕНКА БЫЛА НЕПРАВИЛЬНОЙ - контент НЕ релевантен или неинтересен'}
   ${fb.userComment ? `Комментарий пользователя: "${fb.userComment}"` : ''}
`;
        }).join('')}

**СТРОГИЕ ПРАВИЛА ИСПОЛЬЗОВАНИЯ ОБРАТНОЙ СВЯЗИ:**
${(() => {
            const exactUrlMatch = relevantFeedback.find(fb => fb.isExactUrlMatch);
            const exactUrlNegative = exactUrlMatch && !exactUrlMatch.aiAssessmentWasCorrect;
            const interestsChanged = exactUrlMatch && exactUrlMatch.interestsMatchResult.matchRatio < 0.7;
            
            if (exactUrlNegative && !interestsChanged) {
                return `
⚠️⚠️⚠️ КРИТИЧЕСКИ ВАЖНО: Пользователь УЖЕ анализировал ЭТОТ ТОЧНЫЙ URL и сказал, что он НЕИНТЕРЕСЕН!
   - ТЫ ДОЛЖЕН поставить оценку 0-20 и вердикт "Не трать время"
   - НЕ анализируй контент заново - пользователь УЖЕ показал, что это неинтересно
   - В reasoning ОБЯЗАТЕЛЬНО укажи: "Пользователь ранее анализировал этот контент и отметил его как неинтересный"
`;
            } else if (exactUrlNegative && interestsChanged) {
                return `
⚠️ ВАЖНО: Пользователь УЖЕ анализировал ЭТОТ URL, но интересы ИЗМЕНИЛИСЬ!
   - Интересы в том анализе: ${exactUrlMatch?.userInterests}
   - Текущие интересы: ${interests}
   - Пользователь мог добавить новые интересы, которые делают контент релевантным
   - АНАЛИЗИРУЙ контент заново на основе ТЕКУЩИХ интересов
   - Учитывай старый feedback, но НЕ ставь автоматически 0-20
   - Если контент релевантен ТЕКУЩИМ интересам, ставь соответствующую оценку
   - В reasoning укажи: "Пользователь ранее анализировал этот контент, но интересы изменились. Анализирую на основе текущих интересов."
`;
            }
            return '';
        })()}
1. **Если интересы СОВПАДАЮТ (совпадает >70% интересов):**
   - Если пользователь сказал "неправильно/неинтересно" (❌) - СНИЖАЙ оценку на 30-50 баллов
   - Если пользователь сказал "правильно/интересно" (✅) - можешь повысить на 10-20 баллов
   - Feedback имеет ВЫСОКИЙ приоритет

2. **Если интересы ИЗМЕНИЛИСЬ (совпадает <70% интересов):**
   - Если пользователь сказал "неправильно/неинтересно" (❌) - СНИЖАЙ оценку только на 10-20 баллов
   - Пользователь мог добавить новые интересы, которые делают контент релевантным
   - АНАЛИЗИРУЙ контент на основе ТЕКУЩИХ интересов, а не только старого feedback
   - Feedback имеет СРЕДНИЙ приоритет

3. **Если URL точно совпадает, но интересы изменились:**
   - АНАЛИЗИРУЙ контент заново на основе ТЕКУЩИХ интересов
   - НЕ ставь автоматически низкую оценку только из-за старого feedback
   - Если контент релевантен ТЕКУЩИМ интересам - ставь соответствующую оценку

4. **Учитывай комментарии пользователя:**
   - Если пользователь написал "мне неинтересно это" или "не релевантно" - это значит СИЛЬНОЕ указание снизить оценку
   - Но если интересы изменились - учитывай это при оценке
   - Комментарии важны, но ТЕКУЩИЕ интересы важнее старых комментариев

5. **Похожесть контента определяется по:**
   - Тематике (безопасность, JavaScript, здоровье и т.д.)
   - Типу контента (обучающее видео, статья, обзор и т.д.)
   - Схожим концепциям и примерам

**ПРИМЕР 1:** Пользователь сказал "неинтересно" для видео про XSS-атаки с интересами "безопасность, JS". Теперь анализирует CSRF-атаки с теми же интересами - СНИЖАЙ оценку на 30-50 баллов.

**ПРИМЕР 2:** Пользователь сказал "неинтересно" для видео про C# с интересами "английский, здоровье". Теперь анализирует то же видео с интересами "C#, программирование" - АНАЛИЗИРУЙ заново, интересы изменились!`;
    }

    // Получаем RAG контекст из похожих статей (опционально, не блокирует анализ если не работает)
    let ragContext = '';
    try {
        ragContext = await getRAGContext(processedContent, userId, interests);
        if (ragContext) {
            console.log(`✅ [RAG] RAG context generated successfully (${ragContext.length} chars)`);
        }
    } catch (error: any) {
        console.warn(`⚠️ [RAG] Failed to get RAG context, continuing without it: ${error.message}`);
        // Продолжаем анализ без RAG контекста
    }

    const userPrompt = `
**ВЫБРАННЫЕ интересы пользователя для анализа (анализируй ТОЛЬКО по этим интересам):**
${interests}

**Контент для анализа (проанализируй ВЕСЬ контент полностью, не пропуская детали):**
---
${processedContent}
---
${feedbackContext}${ragContext}

**КРИТИЧЕСКИ ВАЖНО:**
1. Прочитай и проанализируй ВЕСЬ предоставленный контент от начала до конца. Не ограничивайся началом - важная информация может быть в любой части.
2. Оценивай релевантность контента ТОЛЬКО относительно указанных выше интересов. Если контент не связан с этими интересами, ставь низкую оценку, даже если он может быть полезен в целом.
3. В саммари укажи конкретные темы, концепции, примеры, факты из ВСЕГО контента, а не только из начала.
4. ${relevantFeedback.length > 0 ? `**ОБЯЗАТЕЛЬНО ИСПОЛЬЗУЙ ОБРАТНУЮ СВЯЗЬ, НО УЧИТЫВАЙ ИЗМЕНЕНИЯ ИНТЕРЕСОВ:** 
   - Если пользователь УЖЕ анализировал ЭТОТ ТОЧНЫЙ URL и сказал "неинтересно", НО интересы ИЗМЕНИЛИСЬ (совпадает <70%) - АНАЛИЗИРУЙ заново на основе ТЕКУЩИХ интересов, не ставь автоматически 0-20
   - Если пользователь УЖЕ анализировал ЭТОТ ТОЧНЫЙ URL и сказал "неинтересно", И интересы СОВПАДАЮТ (>70%) - ставь оценку 0-20
   - Если пользователь сказал "неинтересно" для похожего контента с СОВПАДАЮЩИМИ интересами - СНИЖАЙ оценку на 30-50 баллов
   - Если пользователь сказал "неинтересно" для похожего контента, НО интересы ИЗМЕНИЛИСЬ - СНИЖАЙ только на 10-20 баллов и анализируй на основе ТЕКУЩИХ интересов
   - ТЕКУЩИЕ интересы пользователя ВАЖНЕЕ старого feedback, если интересы изменились
   - Если контент релевантен ТЕКУЩИМ интересам, даже если был старый негативный feedback - ставь соответствующую оценку` : ''}`;

    
    // Выбор модели через единый провайдер (Gemini или DeepSeek)
    const provider = getProvider();
    const aiModel = getModelForRequest();

    // Gemini требует JSON в промпте, а не через response_format
    const jsonPrompt = `${userPrompt}

ВАЖНО: Ответь ТОЛЬКО валидным JSON-объектом БЕЗ markdown разметки (без \`\`\`json и \`\`\`). Формат:
{
    "score": <число от 0 до 100>,
    "verdict": "<'Полезно' or 'Нейтрально' or 'Не трать время'>",
    "summary": "<саммари на русском языке>",
    "reasoning": "<объяснение на русском языке>"
}`;

    try {
        const providerLabel = provider === 'deepseek' ? 'DeepSeek' : 'Google Gemini - FREE';
        console.log(`🤖 Using AI model: ${aiModel} (${providerLabel})`);
        if (IS_DEBUG) {
            console.log(`📊 Content length: ${processedContent.length} chars (${Math.round(processedContent.length / 4)} estimated tokens)`);
            console.log(`📋 Selected interests: ${interests}`);
        }
        if (relevantFeedback.length > 0) {
            const negativeCount = relevantFeedback.filter(fb => !fb.aiAssessmentWasCorrect).length;
            const positiveCount = relevantFeedback.filter(fb => fb.aiAssessmentWasCorrect).length;
            const exactUrlMatch = relevantFeedback.find(fb => fb.isExactUrlMatch);
            const interestsChanged = exactUrlMatch && exactUrlMatch.interestsMatchResult.matchRatio < 0.7;
            
            if (IS_DEBUG) {
                console.log(`💡 Using ${relevantFeedback.length} feedback entries for selected interests:`);
                console.log(`   - ❌ Negative feedback: ${negativeCount} (will lower scores)`);
                console.log(`   - ✅ Positive feedback: ${positiveCount}`);
                if (exactUrlMatch) {
                    console.log(`   - 🎯 Exact URL match found: ${exactUrlMatch.url.substring(0, 50)}...`);
                    if (interestsChanged) {
                        console.log(`   - ⚠️ Interests changed significantly since last analysis (${Math.round(exactUrlMatch.interestsMatchResult.matchRatio * 100)}% match)`);
                    }
                }
                
                relevantFeedback.forEach((fb, idx) => {
                    const interestsMatchInfo = fb.interestsMatchResult.match ? '✅ interests match' : '⚠️ partial match';
                    console.log(`   ${idx + 1}. URL: ${fb.url.substring(0, 50)}... ${fb.isExactUrlMatch ? '⚠️ EXACT MATCH' : ''} | ${interestsMatchInfo} (${Math.round(fb.interestsMatchResult.matchRatio * 100)}%) | Was correct: ${fb.aiAssessmentWasCorrect} | Comment: ${fb.userComment || 'none'}`);
                });
            }
        } else if (feedbackHistory.length > 0) {
            if (IS_DEBUG) {
                console.log(`ℹ️ Feedback history available (${feedbackHistory.length} entries), but none match selected interests`);
                console.log(`   Selected interests: ${selectedInterestsList.join(', ')}`);
                console.log(`   Feedback interests samples: ${feedbackHistory.slice(0, 3).map(fb => fb.userInterests).join(' | ')}`);
            }
        } else {
            if (IS_DEBUG) {
                console.log(`ℹ️ No feedback history available`);
            }
        }
        
        // Gemini 1.5 поддерживает до 1M токенов контекста - достаточно для любого контента
        if (processedContent.length > 3000000) { // ~750k токенов
            console.warn(`⚠️ WARNING: Content is very long (${processedContent.length} chars). Gemini 1.5 supports up to 1M tokens.`);
        }
        
        if (IS_DEBUG) {
            console.log('Sending request to AI API...');
        }
        
        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Request timed out.')), 120000)
        );
        const completionPromise = traceGeneration(
            'gemini-generateContent',
            aiModel,
            (systemInstruction + '\n\n' + jsonPrompt).slice(0, 5000),
            () => generateCompletion(systemInstruction, jsonPrompt, { modelName: aiModel })
        );
        const result = await Promise.race([completionPromise, timeoutPromise]) as { text: string };
        const rawResponse = result.text;

        if (!rawResponse) {
            console.error('❌ AI response content is empty');
            console.error('Full result structure:', JSON.stringify(result, null, 2));
            throw new Error('AI response is empty.');
        }

        if (process.env.LOG_LEVEL === 'debug') {
            console.log('Raw AI response length:', rawResponse.length);
            console.log('Raw AI response (first 500 chars):', rawResponse.substring(0, 500));
            if (rawResponse.length > 500) {
                console.log('Raw AI response (last 200 chars):', rawResponse.substring(rawResponse.length - 200));
            }
        }
        
        // Очистка от markdown разметки (```json ... ```)
        let cleanedResponse = rawResponse.trim();
        
        // Удаляем ```json в начале
        if (cleanedResponse.startsWith('```json')) {
            cleanedResponse = cleanedResponse.replace(/^```json\s*/i, '');
        } else if (cleanedResponse.startsWith('```')) {
            cleanedResponse = cleanedResponse.replace(/^```\s*/, '');
        }
        
        // Удаляем ``` в конце
        if (cleanedResponse.endsWith('```')) {
            cleanedResponse = cleanedResponse.replace(/\s*```$/, '');
        }
        
        // Удаляем лишние пробелы и переносы строк
        cleanedResponse = cleanedResponse.trim();
        
        // Более надежное извлечение JSON: находим первый { и последний }
        const firstBrace = cleanedResponse.indexOf('{');
        const lastBrace = cleanedResponse.lastIndexOf('}');
        
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            cleanedResponse = cleanedResponse.substring(firstBrace, lastBrace + 1);
        } else if (firstBrace === -1 || lastBrace === -1) {
            console.warn('⚠️ Could not find JSON braces in response, trying to extract anyway...');
        }
        
        // Дополнительная очистка: удаляем все символы перед первым { и после последнего }
        cleanedResponse = cleanedResponse.trim();
        
        if (process.env.LOG_LEVEL === 'debug') {
            console.log('Cleaned response (first 300 chars):', cleanedResponse.substring(0, 300) + '...');
            console.log('Cleaned response length:', cleanedResponse.length);
        }
        
        let parsedResponse: AnalysisResult;
        try {
            parsedResponse = JSON.parse(cleanedResponse);
        } catch (parseError: any) {
            console.error('JSON parse error:', parseError.message);
            console.error('Failed to parse response (first 1000 chars):', cleanedResponse.substring(0, 1000));
            console.error('Response length:', cleanedResponse.length);
            
            // Попытка исправить распространенные проблемы с JSON
            let fixedResponse = cleanedResponse;
            
            // Удаляем лишние запятые перед закрывающими скобками
            fixedResponse = fixedResponse.replace(/,(\s*[}\]])/g, '$1');
            
            // ИСПРАВЛЕНИЕ: Надежное экранирование управляющих символов в JSON строках
            // Используем пошаговый парсинг для правильной обработки всех строковых значений
            try {
                // Метод 1: Исправляем управляющие символы через посимвольный парсинг JSON структуры
                let result = '';
                let inString = false;
                let escapeNext = false;
                let stringStart = -1;
                
                for (let i = 0; i < fixedResponse.length; i++) {
                    const char = fixedResponse[i];
                    const code = char.charCodeAt(0);
                    
                    if (escapeNext) {
                        // Предыдущий символ был обратным слэшем - пропускаем экранирование
                        result += char;
                        escapeNext = false;
                        continue;
                    }
                    
                    if (char === '\\') {
                        escapeNext = true;
                        result += char;
                        continue;
                    }
                    
                    if (char === '"' && (i === 0 || fixedResponse[i - 1] !== '\\')) {
                        // Начало или конец строки
                        if (!inString) {
                            inString = true;
                            stringStart = result.length;
                        } else {
                            inString = false;
                            stringStart = -1;
                        }
                        result += char;
                        continue;
                    }
                    
                    if (inString) {
                        // Мы внутри строкового значения - проверяем управляющие символы
                        if (code >= 0x00 && code <= 0x1F) {
                            // Управляющий символ - экранируем его
                            if (code === 0x0A) { // \n
                                result += '\\n';
                            } else if (code === 0x0D) { // \r
                                result += '\\r';
                            } else if (code === 0x09) { // \t
                                result += '\\t';
                            } else if (code === 0x08) { // \b
                                result += '\\b';
                            } else if (code === 0x0C) { // \f
                                result += '\\f';
                            } else {
                                // Другие управляющие символы - экранируем как \uXXXX
                                result += `\\u${code.toString(16).padStart(4, '0')}`;
                            }
                        } else {
                            result += char;
                        }
                    } else {
                        result += char;
                    }
                }
                
                fixedResponse = result;
            } catch (parseError) {
                // Если посимвольный парсинг не сработал, пробуем regex метод
                console.warn('⚠️ Character-by-character parsing failed, trying regex method...');
                
                // Метод 2: Regex для исправления управляющих символов в строках
                // Используем более точный regex, который учитывает экранированные символы
                fixedResponse = fixedResponse.replace(/"((?:[^"\\]|\\.)*)"/g, (match, content) => {
                    // Проверяем наличие неэкранированных управляющих символов
                    let fixedContent = '';
                    let escapeNext = false;
                    
                    for (let i = 0; i < content.length; i++) {
                        const char = content[i];
                        const code = char.charCodeAt(0);
                        
                        if (escapeNext) {
                            fixedContent += char;
                            escapeNext = false;
                            continue;
                        }
                        
                        if (char === '\\') {
                            escapeNext = true;
                            fixedContent += char;
                            continue;
                        }
                        
                        // Если это управляющий символ и не экранирован
                        if (code >= 0x00 && code <= 0x1F) {
                            if (code === 0x0A) {
                                fixedContent += '\\n';
                            } else if (code === 0x0D) {
                                fixedContent += '\\r';
                            } else if (code === 0x09) {
                                fixedContent += '\\t';
                            } else if (code === 0x08) {
                                fixedContent += '\\b';
                            } else if (code === 0x0C) {
                                fixedContent += '\\f';
                            } else {
                                fixedContent += `\\u${code.toString(16).padStart(4, '0')}`;
                            }
                        } else {
                            fixedContent += char;
                        }
                    }
                    
                    return `"${fixedContent}"`;
                });
            }
            
            // Пытаемся найти и исправить неэкранированные кавычки в строках
            // Заменяем одиночные кавычки внутри строк на экранированные
            fixedResponse = fixedResponse.replace(/"([^"]*)"([^"]*)"([^"]*)"/g, (match, p1, p2, p3) => {
                if (p2.includes('"') && !p2.includes('\\"')) {
                    return `"${p1}\\"${p2.replace(/"/g, '\\"')}\\"${p3}"`;
                }
                return match;
            });
            
            try {
                parsedResponse = JSON.parse(fixedResponse);
                console.log('✓ Successfully parsed after fixing common JSON issues');
            } catch (secondError: any) {
                // Попытка извлечь хотя бы частичную информацию из ответа
                console.warn('⚠️ Attempting to extract partial information from malformed JSON...');
                const partialData: Partial<AnalysisResult> = {};
                
                // Пытаемся извлечь score
                const scoreMatch = cleanedResponse.match(/"score"\s*:\s*(\d+)/);
                if (scoreMatch) {
                    partialData.score = parseInt(scoreMatch[1], 10);
                }
                
                // Пытаемся извлечь verdict
                const verdictMatch = cleanedResponse.match(/"verdict"\s*:\s*"([^"]+)"/);
                if (verdictMatch) {
                    partialData.verdict = verdictMatch[1];
                }
                
                // Пытаемся извлечь summary (более сложно из-за возможных переносов строк)
                const summaryMatch = cleanedResponse.match(/"summary"\s*:\s*"((?:[^"\\]|\\.|\\n)*)"/);
                if (summaryMatch) {
                    partialData.summary = summaryMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
                }
                
                // Пытаемся извлечь reasoning
                const reasoningMatch = cleanedResponse.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.|\\n)*)"/);
                if (reasoningMatch) {
                    partialData.reasoning = reasoningMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
                }
                
                // Если удалось извлечь хотя бы часть данных, используем их
                if (partialData.score !== undefined && partialData.verdict && partialData.summary && partialData.reasoning) {
                    console.log('✓ Successfully extracted partial information from malformed JSON');
                    parsedResponse = partialData as AnalysisResult;
                } else {
                    console.error('❌ Could not extract sufficient information from malformed JSON');
                    throw new Error(`Failed to parse JSON response: ${parseError.message}. Second attempt: ${secondError.message}`);
                }
            }
        }

        // Более строгая валидация ответа
        if (typeof parsedResponse.score !== 'number' || 
            typeof parsedResponse.verdict !== 'string' ||
            typeof parsedResponse.summary !== 'string' ||
            typeof parsedResponse.reasoning !== 'string') {
            console.error('AI response missing required fields:', parsedResponse);
            throw new Error('AI response is missing required fields.');
        }

        // Проверяем, что саммари не слишком короткое
        if (parsedResponse.summary.trim().length < 10) {
            console.warn('Summary seems too short:', parsedResponse.summary);
        }
        
        if (process.env.LOG_LEVEL === 'debug') {
            console.log('Successfully parsed AI JSON response.');
            console.log('Summary length:', parsedResponse.summary.length);
            console.log('Reasoning length:', parsedResponse.reasoning.length);
        }
        
        return parsedResponse;
        
    } catch (error: any) {
        // Логируем полную информацию об ошибке для диагностики
        console.error(`AI Service Error: ${error.message || error}`);
        if (error.code) console.error(`Error code: ${error.code}`);
        if (error.status) console.error(`Error status: ${error.status}`);
        if (error.statusCode) console.error(`Error statusCode: ${error.statusCode}`);
        if (error.response) console.error(`Error response:`, JSON.stringify(error.response, null, 2));
        
        // Извлекаем сообщение об ошибке из разных мест ответа
        const errorResponse = error.response || error.error || error;
        const errorMessage = String(
            errorResponse?.error?.message || 
            errorResponse?.message || 
            error.message || 
            error || 
            JSON.stringify(error)
        );
        const errorCode = errorResponse?.error?.code || error.code || error.status || error.statusCode || '';
        
        // Обработка ошибки API ключа (400) - отдельная обработка
        const isApiKeyError = errorMessage.includes('API Key not found') || 
                             errorMessage.includes('API_KEY_INVALID') ||
                             errorMessage.includes('API key') ||
                             (errorCode === 400 && (errorMessage.includes('API') || errorMessage.includes('key')));
        
        if (isApiKeyError) {
            console.error(`❌ API Key error: ${errorMessage}`);
            console.error('');
            const providerName = getProvider() === 'deepseek' ? 'DeepSeek' : 'Google Gemini';
            console.error(`💡 This project uses ${providerName} API.`);
            console.error('   The API key is missing or invalid.');
            console.error('');
            console.error('📝 To fix this:');
            if (getProvider() === 'deepseek') {
                console.error('   1. Get your API key at: https://platform.deepseek.com');
                console.error('   2. Add to your .env file: DEEPSEEK_API_KEY=your_key_here');
            } else {
                console.error('   1. Get your FREE API key at: https://aistudio.google.com/app/apikey');
                console.error('   2. Add to your .env file: GEMINI_API_KEY=your_key_here');
            }
            console.error('   3. Make sure the API key is correct and not expired');
            console.error('   4. Restart your server');
            throw new Error(`API ключ не найден или неверен. ${getProvider() === 'deepseek' ? 'Добавьте DEEPSEEK_API_KEY в .env' : 'Получите API ключ на https://aistudio.google.com/app/apikey и добавьте GEMINI_API_KEY в .env'}`);
        }
        
        if (errorMessage.includes('404') || 
            (errorCode === 404) ||
            (errorCode === 400 && !isApiKeyError && (errorMessage.includes('not found') || errorMessage.includes('not a valid model') || errorMessage.includes('INVALID_ARGUMENT')))) {
            const providerName = getProvider() === 'deepseek' ? 'DeepSeek' : 'Gemini';
            console.error(`❌ Model "${aiModel}" is not available or has invalid name!`);
            console.error('');
            if (getProvider() === 'deepseek') {
                console.error('   DeepSeek models: deepseek-chat, deepseek-reasoner');
                console.error('   Set AI_MODEL=deepseek-chat (or deepseek-reasoner) and DEEPSEEK_API_KEY in .env');
            } else {
                console.error('   Available Gemini models (FREE tier):');
                console.error('   - gemini-2.5-flash (fast, up to 1M tokens) ✅ RECOMMENDED');
                console.error('   - gemini-1.5-pro (best quality, up to 1M tokens)');
                console.error('   - gemini-pro (legacy, up to 32k tokens)');
                console.error('   Set AI_MODEL=gemini-2.5-flash and GEMINI_API_KEY in .env');
            }
            throw new Error(`Модель "${aiModel}" недоступна. ${getProvider() === 'deepseek' ? 'Используйте deepseek-chat. Задайте DEEPSEEK_API_KEY в .env' : 'Используйте gemini-2.5-flash или gemini-1.5-pro. Задайте GEMINI_API_KEY в .env'}`);
        }
        
        // Обработка ошибки перегрузки модели (503) - модель временно недоступна
        const isOverloadedError = errorMessage.includes('overloaded') || 
                                 errorMessage.includes('UNAVAILABLE') ||
                                 errorMessage.includes('503') ||
                                 errorCode === 503 ||
                                 (errorMessage.includes('The model is overloaded'));
        
        if (isOverloadedError) {
            console.error('❌ Model is overloaded (503). All retry attempts exhausted.');
            console.error('💡 Gemini API is temporarily unavailable due to high load.');
            console.error('📝 Solution: Please try again in a few minutes.');
            throw new Error(`Модель Gemini временно перегружена. Система выполнила 3 попытки с задержками, но модель все еще недоступна. Пожалуйста, попробуйте повторить запрос через несколько минут.`);
        }
        
        // Обработка ошибки rate limit (слишком много запросов в минуту)
        if (error.message && (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('quota') || error.message.includes('rate limit') || error.message.includes('RATE_LIMIT_EXCEEDED'))) {
            const isQuotaExceeded = error.message.includes('quota') || error.message.includes('QUOTA_EXCEEDED');
            const isRateLimit = error.message.includes('429') || error.message.includes('rate limit') || error.message.includes('RATE_LIMIT_EXCEEDED');
            
            if (isQuotaExceeded) {
                console.error('❌ Daily quota exceeded for Gemini API!');
                console.error('💡 Paid Tier 1 limits:');
                console.error('   - Up to 1,000 requests per minute (RPM)');
                console.error('   - Up to 1M tokens per minute (TPM)');
                console.error('   - Up to 10,000 requests per day (RPD)');
                console.error('');
                console.error('📝 Solutions:');
                console.error('   1. Wait 24 hours for quota reset');
                console.error('   2. Check your usage in Google Cloud Console');
                console.error('   3. Consider upgrading to higher tier if needed');
                throw new Error(`Превышен дневной лимит запросов для Gemini API. Платный тариф Tier 1: до 10,000 запросов в день. Подождите 24 часа или проверьте использование в Google Cloud Console.`);
            } else if (isRateLimit) {
                console.error('❌ Rate limit exceeded (too many requests per minute)!');
                console.error('💡 Paid Tier 1 limits:');
                console.error('   - Up to 1,000 requests per minute (RPM)');
                console.error('   - Up to 1M tokens per minute (TPM)');
                console.error('   - Up to 10,000 requests per day (RPD)');
                console.error('📝 Solution: Wait a few seconds and try again. The system will retry automatically with API-suggested delay.');
                throw new Error(`Превышен лимит запросов в минуту для Gemini API. Платный тариф Tier 1: до 1,000 запросов в минуту. Система автоматически повторит запрос с рекомендуемой задержкой.`);
            } else {
                console.error('❌ Resource exhausted error from Gemini API');
                console.error('💡 This might be a rate limit or quota issue.');
                console.error('📝 Solution: Wait a few minutes and try again.');
                throw new Error(`Превышен лимит ресурсов Gemini API. Подождите несколько минут и попробуйте снова.`);
            }
        }
        
        // Обработка ошибки превышения лимита токенов (контекст слишком длинный)
        if (error.message && (error.message.includes('tokens limit exceeded') || error.message.includes('context length') || error.message.includes('CONTEXT_LENGTH_EXCEEDED'))) {
            console.error('❌ Token limit exceeded! Content is too long for this model.');
            console.error('💡 Gemini 1.5 supports up to 1M tokens per request.');
            console.error('   Current content size:', processedContent.length, 'chars (~', Math.round(processedContent.length / 4), 'tokens)');
            console.error('');
            console.error('📝 Solutions:');
            console.error('   1. Content might be too long - try analyzing shorter content');
            console.error('   2. Use gemini-1.5-pro or gemini-2.5-flash (supports 1M tokens)');
            throw new Error(`Контент слишком длинный для модели ${aiModel}. Gemini 1.5 поддерживает до 1M токенов на запрос. Текущий размер: ${processedContent.length} символов (~${Math.round(processedContent.length / 4)} токенов).`);
        }
        
        // Fallback для ошибок парсинга JSON и структуры ответа
        if (error.message && (error.message.includes('Failed to parse JSON') || 
            error.message.includes('Cannot read properties') || 
            error.message.includes('undefined') ||
            error.message.includes('invalid structure') ||
            error.message.includes('response without choices'))) {
            console.log('⚠️ Using fallback response due to JSON parsing or structure error');
            console.error('Error details:', error.message);
            console.error('Error stack:', error.stack);
            return {
                score: 50,
                verdict: 'Нейтрально',
                summary: 'Не удалось корректно обработать ответ AI-сервиса. Контент требует ручной проверки.',
                reasoning: 'AI-сервис вернул ответ в неожиданном формате. Рекомендуется проверить контент вручную.'
            };
        }
        
        // Fallback response для различных типов ошибок
        if (error.message && error.message.includes('AI response is missing required fields')) {
            console.log('⚠️ Using fallback response due to incomplete AI response');
            return {
                score: 50,
                verdict: 'Нейтрально',
                summary: 'Не удалось получить полное саммари от AI-сервиса. Контент требует ручной проверки.',
                reasoning: 'AI-сервис вернул неполный ответ. Рекомендуется проверить контент вручную.'
            };
        }
        
        // Fallback для таймаутов и сетевых ошибок
        if (error.message && (error.message.includes('timed out') || error.message.includes('ECONNREFUSED') || error.message.includes('network') || error.message.includes('All 3 attempts'))) {
            console.log('⚠️ Using fallback response due to network/timeout error');
            return {
                score: 50,
                verdict: 'Нейтрально',
                summary: 'Не удалось получить анализ от AI-сервиса из-за проблем с сетью. Попробуйте повторить запрос позже.',
                reasoning: 'AI-сервис временно недоступен или не ответил вовремя. Это может быть связано с перегрузкой сервиса или проблемами сети.'
            };
        }
        
        throw new Error(`Ошибка при анализе контента AI-сервисом: ${error.message}`);
    }
};

/** Максимальная длина контента для Q&A (чтобы не превысить лимиты токенов) */
const MAX_CONTENT_LENGTH_QA = 100000;

/**
 * Отвечает на вопрос пользователя на основе контента (транскрипт видео, текст статьи и т.д.)
 * @param content - Полный контент (транскрипт, текст статьи)
 * @param question - Вопрос пользователя
 * @returns Ответ AI на вопрос
 */
export async function answerQuestionAboutContent(content: string, question: string): Promise<string> {
    if (!content || !question) {
        throw new Error('Контент и вопрос обязательны');
    }

    const truncatedContent = content.length > MAX_CONTENT_LENGTH_QA
        ? content.substring(0, MAX_CONTENT_LENGTH_QA) + '\n\n[... контент обрезан из-за длины ...]'
        : content;

    const systemInstruction = `Ты — помощник, который отвечает на вопросы пользователя на основе предоставленного контента (транскрипт видео, текст статьи и т.д.).

ПРАВИЛА:
- Отвечай ТОЛЬКО на основе предоставленного контента. Не добавляй информацию извне.
- ВАЖНО: Транскрипт может содержать опечатки, грамматические ошибки и неточности. Твоя задача:
  * Исправлять опечатки и грамматические ошибки (например, "c+ Plus" → "C++", "рефлектор" → правильное написание)
  * Переформулировать информацию своими словами, а НЕ копировать дословно из транскрипта
  * Использовать правильные технические термины и названия (C++, DirectX, Unity, Unreal Engine и т.д.)
  * Структурировать информацию логично и понятно
- Если в контенте нет прямого ответа на вопрос — честно скажи об этом, НО попробуй дать полезный ответ на основе имеющейся информации:
  * Если вопрос касается конкретных данных (цифры, даты, факты) — укажи, что такой информации нет, но можешь упомянуть связанные факты из контента.
  * Если вопрос о стратегии/подходе/методах — попробуй найти похожую информацию в контенте и объяснить, что можно сказать на основе имеющихся данных.
  * Если вопрос о сравнении/динамике — объясни, какая информация есть и что из неё можно понять.
- Отвечай развернуто и полезно (2-4 предложения минимум), на русском языке.
- Не используй markdown в ответе.
- Структурируй ответ: сначала краткий ответ (да/нет или основная мысль), потом объяснение с примерами из контента.
- Если в контенте есть частичная информация — используй её и объясни, что именно можно сказать на основе имеющихся данных.
- Всегда используй правильные названия технологий, языков программирования и инструментов (C++, C#, DirectX, Unity, Unreal Engine и т.д.).`;

    const userPrompt = `КОНТЕНТ:
${truncatedContent}

---
ВОПРОС ПОЛЬЗОВАТЕЛЯ: ${question}

ОТВЕТ:`;

    const result = await generateCompletion(systemInstruction, userPrompt, { modelName: getModelForRequest() });
    const rawResponse = (result?.text ?? '').trim();
    return rawResponse || 'Не удалось получить ответ.';
}