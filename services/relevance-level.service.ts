import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in environment variables.');
}

const genAI = apiKey ? new GoogleGenAI({ apiKey }) : new GoogleGenAI({});

export interface RelevanceLevelResult {
    contentLevel: 'beginner' | 'intermediate' | 'advanced' | 'expert'; // Уровень сложности контента
    userLevelMatch: 'perfect' | 'good' | 'challenging' | 'too_easy' | 'too_hard'; // Соответствие уровню пользователя
    relevanceScore: number; // Оценка релевантности (0-100)
    explanation: string; // Объяснение уровня и соответствия
    recommendations?: string; // Рекомендации для пользователя
}

export interface UserLevel {
    interest: string; // Интерес пользователя (например, "танцы")
    level: 'beginner' | 'intermediate' | 'advanced' | 'expert'; // Уровень пользователя в этом интересе
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
            const completionPromise = genAI.models.generateContent({
                model: modelName,
                contents: fullPrompt,
            });
            
            const completion = await Promise.race([completionPromise, timeoutPromise]) as any;
            return completion;
        } catch (error: any) {
            lastError = error;
            const errorMessage = String(error.message || error || JSON.stringify(error));
            const errorCode = error.code || error.status || error.statusCode || '';
            
            const isRetryable = errorMessage.includes('503') || 
                               errorMessage.includes('429') || 
                               errorMessage.includes('timed out') ||
                               (errorMessage.includes('RESOURCE_EXHAUSTED') && !errorMessage.includes('QUOTA_EXCEEDED')) ||
                               errorCode === 503 ||
                               errorCode === 429;
            
            const isQuotaExceeded = errorMessage.includes('QUOTA_EXCEEDED') || 
                                   errorMessage.includes('quota exceeded') ||
                                   errorMessage.includes('daily quota');
            
            if (isQuotaExceeded) {
                throw error;
            } else if (isRetryable) {
                console.log(`Attempt ${i + 1} of ${retries} failed (${errorMessage}). Retrying in ${delay / 1000}s...`);
                await new Promise(res => setTimeout(res, delay));
                delay *= 1.5;
            } else {
                throw error;
            }
        }
    }
    throw lastError;
}

/**
 * Анализирует уровень релевантности контента с точки зрения его сложности и соответствия уровню пользователя
 * 
 * @param content - Текст контента для анализа
 * @param userLevels - Уровни пользователя по интересам (например, [{interest: "танцы", level: "beginner"}])
 * @param interests - Интересы, по которым анализируется контент
 * @returns Результат анализа уровня релевантности
 */
export const analyzeRelevanceLevel = async (
    content: string,
    userLevels: UserLevel[] = [],
    interests: string = ''
): Promise<RelevanceLevelResult> => {
    let processedContent = content;
    if (content.length > MAX_CONTENT_LENGTH) {
        console.log(`⚠️ Content is extremely long (${content.length} chars). Using first ${MAX_CONTENT_LENGTH} chars.`);
        processedContent = content.substring(0, MAX_CONTENT_LENGTH);
    } else {
        console.log(`✓ Analyzing relevance level for content: ${content.length} chars`);
    }

    const systemInstruction = `Ты — эксперт по анализу уровня сложности и релевантности контента. Твоя задача — определить уровень сложности контента и его соответствие уровню пользователя.

ОЧЕНЬ ВАЖНО:
- Весь твой ответ должен быть ТОЛЬКО валидным JSON-объектом БЕЗ markdown разметки (без \`\`\`json и \`\`\`).
- Все значения JSON ДОЛЖНЫ быть на русском языке, кроме полей contentLevel и userLevelMatch (они должны быть на английском).
- Все кавычки и специальные символы в строках ДОЛЖНЫ быть правильно экранированы для валидного JSON.

**Уровни сложности контента:**
- "beginner" - для новичков, базовые понятия, простые объяснения
- "intermediate" - средний уровень, требует базовых знаний
- "advanced" - продвинутый уровень, требует глубоких знаний
- "expert" - экспертный уровень, для профессионалов, требует специализированных знаний

**Соответствие уровню пользователя:**
- "perfect" - контент идеально соответствует уровню пользователя (релевантность 80-100)
- "good" - контент подходит, но может быть немного сложнее или проще (релевантность 60-79)
- "challenging" - контент сложнее уровня пользователя, но может быть полезен для роста (релевантность 40-59)
- "too_easy" - контент слишком простой для пользователя (релевантность 20-39)
- "too_hard" - контент слишком сложный для пользователя, может быть непонятен (релевантность 0-19)

**Формат вывода (ТОЛЬКО JSON, БЕЗ markdown):**
{
    "contentLevel": "<'beginner' or 'intermediate' or 'advanced' or 'expert'>",
    "userLevelMatch": "<'perfect' or 'good' or 'challenging' or 'too_easy' or 'too_hard'>",
    "relevanceScore": <число от 0 до 100>,
    "explanation": "ДЕТАЛЬНОЕ объяснение (минимум 200 символов). Обязательно укажи: 1) Какой уровень сложности у контента и ПОЧЕМУ (с примерами из контента); 2) Соответствует ли контент уровню пользователя; 3) Что конкретно делает контент подходящим или неподходящим для данного уровня; 4) Какие темы, концепции, термины используются и на каком уровне сложности.",
    "recommendations": "Конкретные рекомендации для пользователя (опционально). Например: 'Рекомендуется сначала изучить базовые понятия X и Y' или 'Этот контент идеально подходит для вашего уровня'"
}`;

    const interestsList = interests.split(',').map(i => i.trim()).filter(Boolean);
    const userLevelsMap = new Map<string, string>();
    userLevels.forEach(ul => {
        userLevelsMap.set(ul.interest.toLowerCase(), ul.level);
    });

    // Формируем описание уровней пользователя
    let userLevelsDescription = '';
    if (userLevels.length > 0) {
        const levelsList = userLevels.map(ul => `- "${ul.interest}": ${ul.level}`).join('\n');
        userLevelsDescription = `\n\n**Уровни пользователя по интересам:**
${levelsList}

ВАЖНО: Сравнивай уровень контента с уровнем пользователя для соответствующих интересов.`;
    } else {
        userLevelsDescription = `\n\n**Уровень пользователя:** Не указан. Определи уровень сложности контента без сравнения с уровнем пользователя.`;
    }

    const userPrompt = `
**Интересы, по которым анализируется контент:**
${interestsList.length > 0 ? interestsList.join(', ') : 'Не указаны'}

**Контент для анализа:**
---
${processedContent}
---
${userLevelsDescription}

**КРИТИЧЕСКИ ВАЖНО:**
1. Определи уровень сложности контента (beginner/intermediate/advanced/expert) на основе:
   - Используемых терминов и концепций
   - Глубины объяснений
   - Предполагаемых знаний читателя
   - Сложности примеров и кейсов

2. Если указан уровень пользователя, сравни его с уровнем контента:
   - Если контент соответствует уровню пользователя → "perfect" или "good"
   - Если контент сложнее уровня пользователя → "challenging" или "too_hard"
   - Если контент проще уровня пользователя → "too_easy"

3. Оценка релевантности (relevanceScore):
   - 80-100: Контент идеально подходит для уровня пользователя
   - 60-79: Контент подходит, но может быть немного сложнее/проще
   - 40-59: Контент сложнее уровня пользователя, но может быть полезен
   - 20-39: Контент слишком простой для пользователя
   - 0-19: Контент слишком сложный для пользователя

4. В explanation укажи конкретные примеры из контента, которые подтверждают твою оценку уровня сложности.`;

    const jsonPrompt = `${userPrompt}

ВАЖНО: Ответь ТОЛЬКО валидным JSON-объектом БЕЗ markdown разметки (без \`\`\`json и \`\`\`). Формат:
{
    "contentLevel": "<'beginner' or 'intermediate' or 'advanced' or 'expert'>",
    "userLevelMatch": "<'perfect' or 'good' or 'challenging' or 'too_easy' or 'too_hard'>",
    "relevanceScore": <число от 0 до 100>,
    "explanation": "<объяснение на русском языке>",
    "recommendations": "<рекомендации на русском языке (опционально)>"
}`;

    const aiModel = process.env.AI_MODEL || 'gemini-1.5-flash';

    try {
        console.log(`🔍 Analyzing relevance level using model: ${aiModel}`);
        console.log(`📊 Content length: ${processedContent.length} chars`);
        console.log(`👤 User levels: ${userLevels.length > 0 ? userLevels.map(ul => `${ul.interest}:${ul.level}`).join(', ') : 'Not specified'}`);
        console.log(`📋 Interests: ${interestsList.join(', ') || 'Not specified'}`);

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
        const validLevels = ['beginner', 'intermediate', 'advanced', 'expert'];
        const validMatches = ['perfect', 'good', 'challenging', 'too_easy', 'too_hard'];

        if (!validLevels.includes(parsedResponse.contentLevel)) {
            console.warn(`⚠️ Invalid contentLevel: ${parsedResponse.contentLevel}. Using 'intermediate' as default.`);
            parsedResponse.contentLevel = 'intermediate';
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
            contentLevel: 'intermediate',
            userLevelMatch: 'good',
            relevanceScore: 50,
            explanation: 'Не удалось проанализировать уровень релевантности контента. Рекомендуется проверить контент вручную.',
            recommendations: 'Попробуйте проанализировать контент позже или проверьте его вручную.'
        };
    }
};

