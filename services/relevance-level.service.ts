import { GoogleGenAI } from '@google/genai';
import { traceGeneration } from '../observability/langfuse-helpers';

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in environment variables.');
}

const genAI = apiKey ? new GoogleGenAI({ apiKey }) : new GoogleGenAI({});

// Очередь запросов для предотвращения rate limiting (используем ту же очередь, что и в ai.service.ts)
// Импортируем очередь из ai.service.ts или создаем общую
class RequestQueue {
    private queue: Array<() => Promise<any>> = [];
    private running = 0;
    private maxConcurrent: number;
    private delayBetweenRequests: number;

    constructor(maxConcurrent = 3, delayBetweenRequests = 500) {
        this.maxConcurrent = maxConcurrent;
        this.delayBetweenRequests = delayBetweenRequests;
    }

    async add<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await fn();
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
            this.process();
        });
    }

    private async process() {
        if (this.running >= this.maxConcurrent || this.queue.length === 0) {
            return;
        }

        this.running++;
        const task = this.queue.shift();
        if (task) {
            try {
                await task();
            } finally {
                this.running--;
                // Небольшая задержка между запросами для предотвращения rate limiting
                await new Promise(resolve => setTimeout(resolve, this.delayBetweenRequests));
                this.process();
            }
        } else {
            this.running--;
        }
    }
}

// Создаем глобальную очередь для всех запросов к Gemini API
const apiRequestQueue = new RequestQueue(3, 500); // Максимум 3 параллельных запроса, задержка 500мс между ними

export interface RelevanceLevelResult {
    contentLevel: 'novice' | 'amateur' | 'professional'; // Уровень профессиональности контента (новичок, любитель, профессионал)
    userLevelMatch: 'perfect' | 'good' | 'challenging' | 'too_easy' | 'too_hard'; // Соответствие уровню пользователя
    relevanceScore: number; // Оценка релевантности (0-100)
    explanation: string; // Объяснение уровня и соответствия
    recommendations?: string; // Рекомендации для пользователя
}

export interface UserLevel {
    interest: string; // Интерес пользователя (например, "танцы")
    level: 'novice' | 'amateur' | 'professional'; // Уровень пользователя в этом интересе (новичок, любитель, профессионал)
}

const MAX_CONTENT_LENGTH = 500000;

async function generateCompletionWithRetry(
    modelName: string,
    systemInstruction: string,
    userPrompt: string,
    retries = 3,
    delay = 2000
) {
    let lastError: any;
    for (let i = 0; i < retries; i++) {
        try {
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Request timed out.')), 120000)
            );
            
            const fullPrompt = systemInstruction ? `${systemInstruction}\n\n${userPrompt}` : userPrompt;
            
            const completionPromise = traceGeneration(
                'relevance-level-analyze',
                modelName,
                fullPrompt.slice(0, 3000),
                () => apiRequestQueue.add(() =>
                    genAI.models.generateContent({
                        model: modelName,
                        contents: fullPrompt,
                    })
                )
            );
            
            const completion = await Promise.race([completionPromise, timeoutPromise]) as any;
            return completion;
        } catch (error: any) {
            lastError = error;
            const errorResponse = error.response || error.error || error;
            const errorMessage = String(
                errorResponse?.error?.message || 
                errorResponse?.message || 
                error.message || 
                error || 
                JSON.stringify(error)
            );
            const errorCode = errorResponse?.error?.code || error.code || error.status || error.statusCode || '';
            
            const isRetryable = errorMessage.includes('503') || 
                               errorMessage.includes('429') || 
                               errorMessage.includes('timed out') ||
                               (errorMessage.includes('RESOURCE_EXHAUSTED') && !errorMessage.includes('QUOTA_EXCEEDED')) ||
                               errorCode === 503 ||
                               errorCode === 429;
            
            const isQuotaExceeded = errorMessage.includes('QUOTA_EXCEEDED') || 
                                   errorMessage.includes('quota exceeded') ||
                                   errorMessage.includes('daily quota') ||
                                   errorMessage.includes('FreeTier') ||
                                   (errorCode === 429 && errorMessage.includes('limit: 20'));
            
            // Если квота превышена, сразу прекращаем попытки
            if (isQuotaExceeded) {
                console.warn(`❌ Quota exceeded detected. Stopping retries.`);
                throw error;
            } else if (isRetryable) {
                // Пытаемся извлечь рекомендуемую задержку из ответа API
                let retryDelayMs = delay;
                
                // Ищем retry delay в ответе API
                const retryDelayMatch = errorMessage.match(/retry in ([\d.]+)s/i) || 
                                       errorMessage.match(/retryDelay["\s:]+([\d.]+)/i);
                
                if (retryDelayMatch) {
                    const retryDelaySeconds = parseFloat(retryDelayMatch[1]);
                    if (!isNaN(retryDelaySeconds) && retryDelaySeconds > 0) {
                        retryDelayMs = Math.ceil(retryDelaySeconds * 1000);
                        console.log(`📊 API suggested retry delay: ${retryDelaySeconds}s`);
                    }
                }
                
                // Проверяем details в ответе для retryDelay
                try {
                    const errorDetails = errorResponse?.error?.details || errorResponse?.details || [];
                    for (const detail of Array.isArray(errorDetails) ? errorDetails : [errorDetails]) {
                        if (detail?.['@type']?.includes('RetryInfo') && detail.retryDelay) {
                            const delayStr = typeof detail.retryDelay === 'string' 
                                ? detail.retryDelay.replace('s', '') 
                                : detail.retryDelay;
                            const delaySeconds = parseFloat(delayStr);
                            if (!isNaN(delaySeconds) && delaySeconds > 0) {
                                retryDelayMs = Math.ceil(delaySeconds * 1000);
                                console.log(`📊 API retryDelay from details: ${delaySeconds}s`);
                                break;
                            }
                        }
                    }
                } catch (e) {
                    // Игнорируем ошибки парсинга
                }
                
                // Минимальная задержка 1 секунда, максимальная 60 секунд
                retryDelayMs = Math.max(1000, Math.min(retryDelayMs, 60000));
                
                console.log(`Attempt ${i + 1} of ${retries} failed (${errorMessage.substring(0, 200)}). Retrying in ${retryDelayMs / 1000}s...`);
                await new Promise(res => setTimeout(res, retryDelayMs));
                
                // Увеличиваем базовую задержку для следующей попытки (если API не указал свою)
                if (retryDelayMs === delay) {
                    delay *= 1.5;
                }
            } else {
                throw error;
            }
        }
    }
    throw lastError;
}

/**
 * Анализирует уровень релевантности контента для конкретного интереса
 * 
 * @param content - Текст контента для анализа
 * @param interest - Конкретный интерес, для которого анализируется контент
 * @param userLevel - Уровень пользователя в этом интересе (опционально)
 * @returns Результат анализа уровня релевантности для данного интереса
 */
export const analyzeRelevanceLevelForInterest = async (
    content: string,
    interest: string,
    userLevel?: string
): Promise<RelevanceLevelResult> => {
    let processedContent = content;
    if (content.length > MAX_CONTENT_LENGTH) {
        console.log(`⚠️ Content is extremely long (${content.length} chars). Using first ${MAX_CONTENT_LENGTH} chars.`);
        processedContent = content.substring(0, MAX_CONTENT_LENGTH);
    } else {
        console.log(`✓ Analyzing relevance level for content: ${content.length} chars`);
    }

    const systemInstruction = `Ты — эксперт по анализу уровня профессиональности контента. Твоя задача — определить, насколько профессионально написан контент в контексте конкретного интереса пользователя.

ОЧЕНЬ ВАЖНО:
- Весь твой ответ должен быть ТОЛЬКО валидным JSON-объектом БЕЗ markdown разметки (без \`\`\`json и \`\`\`).
- Все значения JSON ДОЛЖНЫ быть на русском языке, кроме полей contentLevel и userLevelMatch (они должны быть на английском).
- Все кавычки и специальные символы в строках ДОЛЖНЫ быть правильно экранированы для валидного JSON.
- Оценивай профессиональность контента ИМЕННО в контексте указанного интереса. Один и тот же контент может быть разного уровня для разных интересов.

**Уровни профессиональности контента (3 уровня):**
- "novice" - для новичков, базовые понятия, простые объяснения, начальный уровень. Контент написан простым языком, без сложных терминов.
- "amateur" - для любителей, средний уровень, требует базовых знаний и опыта. Контент использует специальную терминологию, но объясняет её.
- "professional" - для профессионалов, продвинутый уровень, требует глубоких знаний и опыта. Контент использует профессиональную терминологию, предполагает знание предмета.

**Соответствие уровню пользователя:**
- "perfect" - контент идеально соответствует уровню пользователя (релевантность 80-100)
- "good" - контент подходит, но может быть немного сложнее или проще (релевантность 60-79)
- "challenging" - контент сложнее уровня пользователя, но может быть полезен для роста (релевантность 40-59)
- "too_easy" - контент слишком простой для пользователя (релевантность 20-39)
- "too_hard" - контент слишком сложный для пользователя, может быть непонятен (релевантность 0-19)

**Формат вывода (ТОЛЬКО JSON, БЕЗ markdown):**
{
    "contentLevel": "<'novice' or 'amateur' or 'professional'>",
    "userLevelMatch": "<'perfect' or 'good' or 'challenging' or 'too_easy' or 'too_hard'>",
    "relevanceScore": <число от 0 до 100>,
    "explanation": "ДЕТАЛЬНОЕ объяснение (минимум 200 символов). Обязательно укажи: 1) Какой уровень профессиональности у контента и ПОЧЕМУ (с примерами из контента); 2) Соответствует ли контент уровню пользователя; 3) Что конкретно делает контент подходящим или неподходящим для данного уровня; 4) Какие темы, концепции, термины используются и на каком уровне профессиональности.",
    "recommendations": "Конкретные рекомендации для пользователя (опционально). Например: 'Рекомендуется сначала изучить базовые понятия X и Y' или 'Этот контент идеально подходит для вашего уровня'"
}`;

    // Формируем описание уровня пользователя для конкретного интереса
    let userLevelsDescription = '';
    if (userLevel) {
        userLevelsDescription = `\n\n**Уровень пользователя в интересе "${interest}":** ${userLevel}

ВАЖНО: Сравнивай уровень профессиональности контента с уровнем пользователя для интереса "${interest}".`;
    } else {
        userLevelsDescription = `\n\n**Уровень пользователя:** Не указан. Определи уровень профессиональности контента без сравнения с уровнем пользователя.`;
    }

    const userPrompt = `
**Интерес, по которому анализируется контент:**
${interest}

**Контент для анализа:**
---
${processedContent}
---
${userLevelsDescription}

**КРИТИЧЕСКИ ВАЖНО:**
1. Оцени уровень профессиональности контента ИМЕННО в контексте интереса "${interest}". Один и тот же контент может быть разного уровня для разных интересов.
   Например: статья про программирование может быть "professional" для интереса "программирование", но "novice" для интереса "познание себя".
   
   Определи уровень на основе:
   - Используемых терминов и концепций в контексте интереса "${interest}"
   - Глубины объяснений относительно этого интереса
   - Предполагаемых знаний читателя в этой области
   - Сложности примеров и кейсов
   - Профессиональности подачи материала в контексте интереса

2. Если указан уровень пользователя, сравни его с уровнем контента:
   - Если контент соответствует уровню пользователя → "perfect" или "good"
   - Если контент сложнее уровня пользователя → "challenging" или "too_hard"
   - Если контент проще уровня пользователя → "too_easy"

3. Оценка релевантности (relevanceScore) - насколько контент подходит для уровня пользователя в интересе "${interest}":
   - 80-100: Контент идеально подходит для уровня пользователя
   - 60-79: Контент подходит, но может быть немного сложнее/проще
   - 40-59: Контент сложнее уровня пользователя, но может быть полезен
   - 20-39: Контент слишком простой для пользователя
   - 0-19: Контент слишком сложный для пользователя

4. В explanation укажи конкретные примеры из контента, которые подтверждают твою оценку уровня профессиональности в контексте интереса "${interest}".`;

    const jsonPrompt = `${userPrompt}

ВАЖНО: Ответь ТОЛЬКО валидным JSON-объектом БЕЗ markdown разметки (без \`\`\`json и \`\`\`). Формат:
{
    "contentLevel": "<'novice' or 'amateur' or 'professional'>",
    "userLevelMatch": "<'perfect' or 'good' or 'challenging' or 'too_easy' or 'too_hard'>",
    "relevanceScore": <число от 0 до 100>,
    "explanation": "<объяснение на русском языке>",
    "recommendations": "<рекомендации на русском языке (опционально)>"
}`;

    const aiModel = process.env.AI_MODEL || 'gemini-2.5-flash';

    try {
        console.log(`🔍 Analyzing relevance level using model: ${aiModel}`);
        console.log(`📊 Content length: ${processedContent.length} chars`);
        console.log(`👤 User level for interest "${interest}": ${userLevel || 'Not specified'}`);

        const result = await generateCompletionWithRetry(aiModel, systemInstruction, jsonPrompt);

        // Логируем структуру ответа для диагностики
        console.log('Gemini API response structure:', JSON.stringify(Object.keys(result || {}), null, 2));

        let rawResponse: string;
        if (result.text) {
            rawResponse = result.text;
        } else if (result.response && result.response.text) {
            rawResponse = result.response.text();
        } else if (typeof result === 'string') {
            rawResponse = result;
        } else {
            console.error('❌ AI response has unexpected structure:', JSON.stringify(result, null, 2));
            throw new Error('AI service returned response in unexpected format.');
        }

        console.log('Raw AI response length:', rawResponse.length);
        console.log('Raw AI response (first 500 chars):', rawResponse.substring(0, 500));

        // Очистка от markdown разметки
        let cleanedResponse = rawResponse.trim();
        if (cleanedResponse.startsWith('```json')) {
            cleanedResponse = cleanedResponse.replace(/^```json\s*/i, '');
        } else if (cleanedResponse.startsWith('```')) {
            cleanedResponse = cleanedResponse.replace(/^```\s*/, '');
        }
        if (cleanedResponse.endsWith('```')) {
            cleanedResponse = cleanedResponse.replace(/\s*```$/, '');
        }
        cleanedResponse = cleanedResponse.trim();

        // Извлечение JSON
        const firstBrace = cleanedResponse.indexOf('{');
        const lastBrace = cleanedResponse.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            cleanedResponse = cleanedResponse.substring(firstBrace, lastBrace + 1);
        }

        console.log('Cleaned response (first 300 chars):', cleanedResponse.substring(0, 300) + '...');

        let parsedResponse: RelevanceLevelResult;
        try {
            parsedResponse = JSON.parse(cleanedResponse);
        } catch (parseError: any) {
            console.error('JSON parse error:', parseError.message);
            console.error('Failed to parse response (first 1000 chars):', cleanedResponse.substring(0, 1000));
            
            // Попытка исправить JSON
            let fixedResponse = cleanedResponse;
            fixedResponse = fixedResponse.replace(/,(\s*[}\]])/g, '$1');
            fixedResponse = fixedResponse.replace(/("(?:[^"\\]|\\.)*")\s*\n\s*/g, '$1 ');
            
            try {
                parsedResponse = JSON.parse(fixedResponse);
                console.log('✓ Successfully parsed after fixing common JSON issues');
            } catch (secondError: any) {
                console.error('❌ Could not parse JSON response');
                throw new Error(`Failed to parse JSON response: ${parseError.message}`);
            }
        }

        // Валидация ответа
        const validLevels = ['novice', 'amateur', 'professional'];
        const validMatches = ['perfect', 'good', 'challenging', 'too_easy', 'too_hard'];

        if (!validLevels.includes(parsedResponse.contentLevel)) {
            console.warn(`⚠️ Invalid contentLevel: ${parsedResponse.contentLevel}. Using 'amateur' as default.`);
            parsedResponse.contentLevel = 'amateur';
        }

        if (!validMatches.includes(parsedResponse.userLevelMatch)) {
            console.warn(`⚠️ Invalid userLevelMatch: ${parsedResponse.userLevelMatch}. Using 'good' as default.`);
            parsedResponse.userLevelMatch = 'good';
        }

        if (typeof parsedResponse.relevanceScore !== 'number' || 
            parsedResponse.relevanceScore < 0 || 
            parsedResponse.relevanceScore > 100) {
            console.warn(`⚠️ Invalid relevanceScore: ${parsedResponse.relevanceScore}. Using 50 as default.`);
            parsedResponse.relevanceScore = 50;
        }

        if (!parsedResponse.explanation || parsedResponse.explanation.trim().length < 10) {
            console.warn('⚠️ Explanation seems too short');
        }

        console.log('✓ Successfully parsed relevance level analysis');
        console.log(`   Content Level: ${parsedResponse.contentLevel}`);
        console.log(`   User Level Match: ${parsedResponse.userLevelMatch}`);
        console.log(`   Relevance Score: ${parsedResponse.relevanceScore}`);

        return parsedResponse;

    } catch (error: any) {
        console.error(`Relevance Level Analysis Error: ${error.message}`);
        
        // Fallback response
        return {
            contentLevel: 'amateur',
            userLevelMatch: 'good',
            relevanceScore: 50,
            explanation: 'Не удалось проанализировать уровень релевантности контента. Рекомендуется проверить контент вручную.',
            recommendations: 'Попробуйте проанализировать контент позже или проверьте его вручную.'
        };
    }
};

/**
 * Анализирует уровень релевантности контента для нескольких интересов за один запрос к API
 * Это оптимизированная версия, которая делает один запрос вместо нескольких
 * 
 * @param content - Текст контента для анализа
 * @param interestsWithLevels - Массив объектов с интересом и уровнем пользователя
 * @returns Массив результатов анализа для каждого интереса
 */
export const analyzeRelevanceLevelForMultipleInterests = async (
    content: string,
    interestsWithLevels: Array<{ interest: string; userLevel: string }>
): Promise<Array<{ interest: string; result: RelevanceLevelResult }>> => {
    if (interestsWithLevels.length === 0) {
        return [];
    }

    // Если только один интерес, используем старую функцию
    if (interestsWithLevels.length === 1) {
        const { interest, userLevel } = interestsWithLevels[0];
        const result = await analyzeRelevanceLevelForInterest(content, interest, userLevel);
        return [{ interest, result }];
    }

    let processedContent = content;
    if (content.length > MAX_CONTENT_LENGTH) {
        console.log(`⚠️ Content is extremely long (${content.length} chars). Using first ${MAX_CONTENT_LENGTH} chars.`);
        processedContent = content.substring(0, MAX_CONTENT_LENGTH);
    } else {
        console.log(`✓ Analyzing relevance level for ${interestsWithLevels.length} interests in one request: ${content.length} chars`);
    }

    const systemInstruction = `Ты — эксперт по анализу уровня профессиональности контента. Твоя задача — определить, насколько профессионально написан контент в контексте нескольких интересов пользователя.

ОЧЕНЬ ВАЖНО:
- Весь твой ответ должен быть ТОЛЬКО валидным JSON-объектом БЕЗ markdown разметки (без \`\`\`json и \`\`\`).
- Все значения JSON ДОЛЖНЫ быть на русском языке, кроме полей contentLevel и userLevelMatch (они должны быть на английском).
- Все кавычки и специальные символы в строках ДОЛЖНЫ быть правильно экранированы для валидного JSON.
- Оценивай профессиональность контента ИМЕННО в контексте каждого указанного интереса. Один и тот же контент может быть разного уровня для разных интересов.

**Уровни профессиональности контента (3 уровня):**
- "novice" - для новичков, базовые понятия, простые объяснения, начальный уровень. Контент написан простым языком, без сложных терминов.
- "amateur" - для любителей, средний уровень, требует базовых знаний и опыта. Контент использует специальную терминологию, но объясняет её.
- "professional" - для профессионалов, продвинутый уровень, требует глубоких знаний и опыта. Контент использует профессиональную терминологию, предполагает знание предмета.

**Соответствие уровню пользователя:**
- "perfect" - контент идеально соответствует уровню пользователя (релевантность 80-100)
- "good" - контент подходит, но может быть немного сложнее или проще (релевантность 60-79)
- "challenging" - контент сложнее уровня пользователя, но может быть полезен для роста (релевантность 40-59)
- "too_easy" - контент слишком простой для пользователя (релевантность 20-39)
- "too_hard" - контент слишком сложный для пользователя, может быть непонятен (релевантность 0-19)

**Формат вывода (ТОЛЬКО JSON, БЕЗ markdown):**
{
    "results": [
        {
            "interest": "<название интереса>",
            "contentLevel": "<'novice' or 'amateur' or 'professional'>",
            "userLevelMatch": "<'perfect' or 'good' or 'challenging' or 'too_easy' or 'too_hard'>",
            "relevanceScore": <число от 0 до 100>,
            "explanation": "ДЕТАЛЬНОЕ объяснение (минимум 150 символов) для этого интереса",
            "recommendations": "Конкретные рекомендации для пользователя (опционально)"
        }
    ]
}`;

    // Формируем список интересов с уровнями пользователя
    const interestsDescription = interestsWithLevels.map(({ interest, userLevel }) => 
        `- "${interest}": уровень пользователя - ${userLevel}`
    ).join('\n');

    const userPrompt = `
**Интересы, по которым анализируется контент:**
${interestsDescription}

**Контент для анализа:**
---
${processedContent}
---

**КРИТИЧЕСКИ ВАЖНО:**
Для каждого интереса отдельно:
1. Оцени уровень профессиональности контента ИМЕННО в контексте этого интереса. Один и тот же контент может быть разного уровня для разных интересов.
   Например: статья про программирование может быть "professional" для интереса "программирование", но "novice" для интереса "познание себя".
   
   Определи уровень на основе:
   - Используемых терминов и концепций в контексте этого интереса
   - Глубины объяснений относительно этого интереса
   - Предполагаемых знаний читателя в этой области
   - Сложности примеров и кейсов
   - Профессиональности подачи материала в контексте этого интереса

2. Сравни уровень контента с уровнем пользователя для этого интереса:
   - Если контент соответствует уровню пользователя → "perfect" или "good"
   - Если контент сложнее уровня пользователя → "challenging" или "too_hard"
   - Если контент проще уровня пользователя → "too_easy"

3. Оценка релевантности (relevanceScore) - насколько контент подходит для уровня пользователя в этом интересе:
   - 80-100: Контент идеально подходит для уровня пользователя
   - 60-79: Контент подходит, но может быть немного сложнее/проще
   - 40-59: Контент сложнее уровня пользователя, но может быть полезен
   - 20-39: Контент слишком простой для пользователя
   - 0-19: Контент слишком сложный для пользователя

4. В explanation укажи конкретные примеры из контента, которые подтверждают твою оценку уровня профессиональности в контексте этого интереса.

ВАЖНО: Проанализируй контент для ВСЕХ указанных интересов и верни результат для каждого интереса в массиве "results".`;

    const jsonPrompt = `${userPrompt}

ВАЖНО: Ответь ТОЛЬКО валидным JSON-объектом БЕЗ markdown разметки (без \`\`\`json и \`\`\`). Формат:
{
    "results": [
        {
            "interest": "<название интереса точно как указано выше>",
            "contentLevel": "<'novice' or 'amateur' or 'professional'>",
            "userLevelMatch": "<'perfect' or 'good' or 'challenging' or 'too_easy' or 'too_hard'>",
            "relevanceScore": <число от 0 до 100>,
            "explanation": "<объяснение на русском языке>",
            "recommendations": "<рекомендации на русском языке (опционально)>"
        }
    ]
}`;

    const aiModel = process.env.AI_MODEL || 'gemini-2.5-flash';

    try {
        console.log(`🔍 Analyzing relevance level for ${interestsWithLevels.length} interests in ONE request using model: ${aiModel}`);
        console.log(`📊 Content length: ${processedContent.length} chars`);

        const result = await generateCompletionWithRetry(aiModel, systemInstruction, jsonPrompt);

        let rawResponse: string;
        if (result.text) {
            rawResponse = result.text;
        } else if (result.response && result.response.text) {
            rawResponse = result.response.text();
        } else if (typeof result === 'string') {
            rawResponse = result;
        } else {
            console.error('❌ AI response has unexpected structure:', JSON.stringify(result, null, 2));
            throw new Error('AI service returned response in unexpected format.');
        }

        // Очистка от markdown разметки
        let cleanedResponse = rawResponse.trim();
        if (cleanedResponse.startsWith('```json')) {
            cleanedResponse = cleanedResponse.replace(/^```json\s*/i, '');
        } else if (cleanedResponse.startsWith('```')) {
            cleanedResponse = cleanedResponse.replace(/^```\s*/, '');
        }
        if (cleanedResponse.endsWith('```')) {
            cleanedResponse = cleanedResponse.replace(/\s*```$/, '');
        }
        cleanedResponse = cleanedResponse.trim();

        // Извлечение JSON
        const firstBrace = cleanedResponse.indexOf('{');
        const lastBrace = cleanedResponse.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            cleanedResponse = cleanedResponse.substring(firstBrace, lastBrace + 1);
        }

        let parsedResponse: { results: Array<{ interest: string } & RelevanceLevelResult> };
        try {
            parsedResponse = JSON.parse(cleanedResponse);
        } catch (parseError: any) {
            console.error('JSON parse error:', parseError.message);
            console.error('Failed to parse response (first 1000 chars):', cleanedResponse.substring(0, 1000));
            
            // Попытка исправить JSON
            let fixedResponse = cleanedResponse;
            fixedResponse = fixedResponse.replace(/,(\s*[}\]])/g, '$1');
            fixedResponse = fixedResponse.replace(/("(?:[^"\\]|\\.)*")\s*\n\s*/g, '$1 ');
            
            try {
                parsedResponse = JSON.parse(fixedResponse);
                console.log('✓ Successfully parsed after fixing common JSON issues');
            } catch (secondError: any) {
                console.error('❌ Could not parse JSON response');
                // Fallback: анализируем каждый интерес отдельно
                console.log('⚠️ Falling back to individual analysis for each interest...');
                const fallbackResults: Array<{ interest: string; result: RelevanceLevelResult }> = [];
                for (const { interest, userLevel } of interestsWithLevels) {
                    try {
                        const result = await analyzeRelevanceLevelForInterest(content, interest, userLevel);
                        fallbackResults.push({ interest, result });
                    } catch (error: any) {
                        console.error(`Failed to analyze interest "${interest}": ${error.message}`);
                        fallbackResults.push({
                            interest,
                            result: {
                                contentLevel: 'amateur',
                                userLevelMatch: 'good',
                                relevanceScore: 50,
                                explanation: 'Не удалось проанализировать уровень релевантности контента для этого интереса.',
                            }
                        });
                    }
                }
                return fallbackResults;
            }
        }

        // Валидация и маппинг результатов
        const validLevels = ['novice', 'amateur', 'professional'];
        const validMatches = ['perfect', 'good', 'challenging', 'too_easy', 'too_hard'];

        const results: Array<{ interest: string; result: RelevanceLevelResult }> = [];
        
        for (const item of parsedResponse.results || []) {
            // Находим соответствующий интерес (с учетом регистра)
            const matchingInterest = interestsWithLevels.find(
                iwl => iwl.interest.toLowerCase() === item.interest.toLowerCase()
            );
            
            if (!matchingInterest) {
                console.warn(`⚠️ Interest "${item.interest}" from API response not found in request`);
                continue;
            }

            // Валидация
            if (!validLevels.includes(item.contentLevel)) {
                console.warn(`⚠️ Invalid contentLevel: ${item.contentLevel}. Using 'amateur' as default.`);
                item.contentLevel = 'amateur';
            }

            if (!validMatches.includes(item.userLevelMatch)) {
                console.warn(`⚠️ Invalid userLevelMatch: ${item.userLevelMatch}. Using 'good' as default.`);
                item.userLevelMatch = 'good';
            }

            if (typeof item.relevanceScore !== 'number' || 
                item.relevanceScore < 0 || 
                item.relevanceScore > 100) {
                console.warn(`⚠️ Invalid relevanceScore: ${item.relevanceScore}. Using 50 as default.`);
                item.relevanceScore = 50;
            }

            results.push({
                interest: matchingInterest.interest, // Используем оригинальное название интереса
                result: {
                    contentLevel: item.contentLevel,
                    userLevelMatch: item.userLevelMatch,
                    relevanceScore: item.relevanceScore,
                    explanation: item.explanation || 'Объяснение не предоставлено.',
                    recommendations: item.recommendations,
                }
            });
        }

        // Если API не вернул результаты для всех интересов, дополняем fallback значениями
        for (const { interest } of interestsWithLevels) {
            if (!results.find(r => r.interest.toLowerCase() === interest.toLowerCase())) {
                console.warn(`⚠️ API did not return result for interest "${interest}", using fallback`);
                results.push({
                    interest,
                    result: {
                        contentLevel: 'amateur',
                        userLevelMatch: 'good',
                        relevanceScore: 50,
                        explanation: 'Не удалось проанализировать уровень релевантности контента для этого интереса.',
                    }
                });
            }
        }

        console.log(`✓ Successfully analyzed ${results.length} interests in one request`);
        return results;

    } catch (error: any) {
        console.error(`Relevance Level Analysis Error: ${error.message}`);
        
        // Fallback: анализируем каждый интерес отдельно
        console.log('⚠️ Falling back to individual analysis for each interest...');
        const fallbackResults: Array<{ interest: string; result: RelevanceLevelResult }> = [];
        for (const { interest, userLevel } of interestsWithLevels) {
            try {
                const result = await analyzeRelevanceLevelForInterest(content, interest, userLevel);
                fallbackResults.push({ interest, result });
            } catch (err: any) {
                console.error(`Failed to analyze interest "${interest}": ${err.message}`);
                fallbackResults.push({
                    interest,
                    result: {
                        contentLevel: 'amateur',
                        userLevelMatch: 'good',
                        relevanceScore: 50,
                        explanation: 'Не удалось проанализировать уровень релевантности контента для этого интереса.',
                    }
                });
            }
        }
        return fallbackResults;
    }
};

/**
 * Анализирует уровень релевантности контента для всех интересов (для обратной совместимости)
 * 
 * @param content - Текст контента для анализа
 * @param userLevels - Уровни пользователя по интересам
 * @param interests - Интересы, по которым анализируется контент
 * @returns Результат анализа уровня релевантности (усредненный для всех интересов)
 */
export const analyzeRelevanceLevel = async (
    content: string,
    userLevels: UserLevel[] = [],
    interests: string = ''
): Promise<RelevanceLevelResult> => {
    const interestsList = interests.split(',').map(i => i.trim()).filter(Boolean);
    
    // Если интересов несколько, используем оптимизированную функцию для анализа всех за один запрос
    if (interestsList.length > 1 && userLevels.length > 0) {
        const interestsWithLevels = interestsList
            .map(interest => {
                const userLevel = userLevels.find(ul => ul.interest.toLowerCase() === interest.toLowerCase());
                return userLevel ? { interest, userLevel: userLevel.level } : null;
            })
            .filter((item): item is { interest: string; userLevel: 'novice' | 'amateur' | 'professional' } => item !== null);

        if (interestsWithLevels.length > 0) {
            console.log(`📊 Analyzing ${interestsWithLevels.length} interests in ONE optimized request...`);
            const results = await analyzeRelevanceLevelForMultipleInterests(content, interestsWithLevels);
            
            if (results.length > 0) {
                // Усредняем результаты
                const avgScore = Math.round(results.reduce((sum, r) => sum + r.result.relevanceScore, 0) / results.length);
                const mostCommonLevel = results.reduce((acc, r) => {
                    acc[r.result.contentLevel] = (acc[r.result.contentLevel] || 0) + 1;
                    return acc;
                }, {} as Record<string, number>);
                const contentLevel = Object.keys(mostCommonLevel).reduce((a, b) => 
                    mostCommonLevel[a] > mostCommonLevel[b] ? a : b
                ) as 'novice' | 'amateur' | 'professional';
                
                return {
                    contentLevel,
                    userLevelMatch: avgScore >= 80 ? 'perfect' : avgScore >= 60 ? 'good' : avgScore >= 40 ? 'challenging' : avgScore >= 20 ? 'too_easy' : 'too_hard',
                    relevanceScore: avgScore,
                    explanation: results.map(r => `[${r.interest}]: ${r.result.explanation}`).join('\n\n'),
                    recommendations: results.map(r => r.result.recommendations).filter(Boolean).join('\n\n') || undefined,
                };
            }
        }
    }
    
    // Если один интерес или нет уровней, анализируем для первого интереса
    const firstInterest = interestsList[0] || 'general';
    const userLevel = userLevels.find(ul => ul.interest.toLowerCase() === firstInterest.toLowerCase());
    return await analyzeRelevanceLevelForInterest(content, firstInterest, userLevel?.level);
};

