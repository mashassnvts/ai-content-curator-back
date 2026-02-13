import { GoogleGenAI } from '@google/genai';
import UserSemanticTag from '../models/UserSemanticTag';
import { generateEmbedding, findSimilarArticles } from './embedding.service';
import { escapeControlCharsInJsonStrings } from '../utils/json-parse-helper';

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in environment variables. Get your free API key at https://aistudio.google.com/app/apikey');
}

const genAI = apiKey ? new GoogleGenAI({ apiKey }) : new GoogleGenAI({});

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const IS_DEBUG = LOG_LEVEL === 'debug';

// Очередь запросов для предотвращения rate limiting (используем ту же логику, что и в ai.service.ts)
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
                await new Promise(resolve => setTimeout(resolve, this.delayBetweenRequests));
                this.process();
            }
        } else {
            this.running--;
        }
    }
}

const apiRequestQueue = new RequestQueue(3, 500);

// Кэш тегов пользователя (userId -> {tags, timestamp})
interface UserTagsCache {
    tags: Array<{ tag: string; weight: number }>;
    timestamp: number;
}

const userTagsCache = new Map<number, UserTagsCache>();
const CACHE_TTL = 60000; // 1 минута кэширования

/**
 * Получает теги пользователя с кэшированием
 * @param userId - ID пользователя
 * @returns Массив тегов с весами
 */
export async function getUserTagsCached(userId: number): Promise<Array<{ tag: string; weight: number }>> {
    const cached = userTagsCache.get(userId);
    const now = Date.now();
    
    // Проверяем, есть ли валидный кэш
    if (cached && (now - cached.timestamp) < CACHE_TTL) {
        if (IS_DEBUG) {
            console.log(`📦 [getUserTagsCached] Using cached tags for user ${userId}`);
        }
        return cached.tags;
    }
    
    // Загружаем из БД
    const userTags = await UserSemanticTag.findAll({
        where: { userId },
        order: [['weight', 'DESC']],
        limit: 100, // Ограничиваем до топ-100 по весу для производительности
        attributes: ['tag', 'weight']
    });
    
    const tagsWithWeights = userTags.map(tag => ({
        tag: tag.tag,
        weight: parseFloat(tag.weight.toString()),
    }));
    
    // Сохраняем в кэш
    userTagsCache.set(userId, {
        tags: tagsWithWeights,
        timestamp: now
    });
    
    if (IS_DEBUG) {
        console.log(`💾 [getUserTagsCached] Loaded ${tagsWithWeights.length} tags from DB for user ${userId}`);
    }
    return tagsWithWeights;
}

/**
 * Очищает кэш тегов для пользователя (вызывать после сохранения новых тегов)
 */
export function clearUserTagsCache(userId: number): void {
    userTagsCache.delete(userId);
    if (IS_DEBUG) {
        console.log(`🗑️ [clearUserTagsCache] Cleared cache for user ${userId}`);
    }
}

/**
 * Словарь синонимов для тегов (для улучшения сравнения)
 */
const tagSynonyms: Record<string, string[]> = {
    'машинное обучение': ['ml', 'machine learning', 'машинное обучение', 'машинное обучение и'],
    'искусственный интеллект': ['ai', 'artificial intelligence', 'искусственный интеллект', 'ии'],
    'нейронные сети': ['нейросети', 'neural networks', 'нейронные сети', 'нейросеть'],
    'глубокое обучение': ['deep learning', 'глубокое обучение', 'глубокое обучение нейросетей'],
    'веб-разработка': ['web development', 'веб-разработка', 'веб разработка'],
    'базы данных': ['database', 'базы данных', 'база данных', 'бд'],
    'python': ['python', 'питон'],
    'javascript': ['javascript', 'js', 'ecmascript'],
    'react': ['react', 'reactjs'],
    'node.js': ['node.js', 'nodejs', 'node'],
};

/**
 * Нормализует тег для сравнения (приводит к нижнему регистру, удаляет лишние пробелы)
 */
function normalizeTagForComparison(tag: string): string {
    return tag.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Проверяет, являются ли два тега синонимами
 */
function areSynonyms(tag1: string, tag2: string): boolean {
    const normalized1 = normalizeTagForComparison(tag1);
    const normalized2 = normalizeTagForComparison(tag2);
    
    // Точное совпадение после нормализации
    if (normalized1 === normalized2) {
        return true;
    }
    
    // Проверка через словарь синонимов
    for (const [key, synonyms] of Object.entries(tagSynonyms)) {
        const normalizedKey = normalizeTagForComparison(key);
        const allVariants = [normalizedKey, ...synonyms.map(s => normalizeTagForComparison(s))];
        
        if (allVariants.includes(normalized1) && allVariants.includes(normalized2)) {
            return true;
        }
    }
    
    return false;
}

/**
 * Извлекает ключевые темы (смыслы) из текста статьи
 * 
 * ВАЖНО: Темы (semantic tags) - это НЕ интересы пользователя!
 * - Интересы: пользователь сам выбирает категории (например, "AI", "программирование")
 * - Темы: AI автоматически извлекает ключевые темы из проанализированных статей (например, "нейронные сети", "оптимизация моделей")
 * Темы сохраняются в таблицу user_semantic_tags и используются для создания "облака смыслов" пользователя.
 * 
 * @param text - Текст статьи для анализа
 * @returns Массив строк с темами (каждая тема 1-3 слова)
 */
export async function extractThemes(text: string): Promise<string[]> {
    // Минимальная длина текста для извлечения тем (чтобы не тратить API-запросы на слишком короткие тексты)
    const MIN_TEXT_LENGTH = 50;
    
    if (!text || text.trim().length === 0) {
        console.log('ℹ️ [extractThemes] Empty text provided, skipping theme extraction');
        return [];
    }
    
    if (text.trim().length < MIN_TEXT_LENGTH) {
        console.log(`ℹ️ [extractThemes] Text too short (${text.trim().length} chars, minimum ${MIN_TEXT_LENGTH}), skipping theme extraction`);
        return [];
    }

    // Ограничиваем длину текста для анализа (Gemini поддерживает до 1M токенов, но для извлечения тем достаточно меньше)
    const MAX_TEXT_LENGTH = 100000; // ~25k токенов
    const processedText = text.length > MAX_TEXT_LENGTH 
        ? text.substring(0, MAX_TEXT_LENGTH) + '...' 
        : text;

    const systemInstruction = `Ты — помощник для извлечения ключевых тем из текста. Твоя задача — найти главные смыслы и темы статьи.

КРИТИЧЕСКИ ВАЖНО:
- Твой ответ должен быть ТОЛЬКО валидным JSON-массивом строк БЕЗ markdown разметки (без \`\`\`json и \`\`\`).
- Каждая тема должна быть ОТ 1 ДО 3 СЛОВ (не обязательно все по 2-3 слова!).
- ПРЕДПОЧТИТЕЛЬНО использовать 1-2 слова, если это возможно.
- Используй 3 слова ТОЛЬКО если тема действительно требует этого (например, "глубокое обучение нейросетей").
- Извлеки от 5 до 10 самых важных тем.
- Темы должны быть конкретными и отражать основное содержание текста.
- Используй ПРЕИМУЩЕСТВЕННО существительные и прилагательные, избегай глаголов.
- Избегай общих фраз типа "статья", "текст", "информация", "контент", "материал", "содержание", "описание".
- ВСЕГДА возвращай темы на РУССКОМ языке, независимо от языка оригинала текста. Если текст на английском или другом языке - переведи темы на русский. Это важно для единообразия "облака смыслов".

ПРИМЕРЫ ПРАВИЛЬНЫХ ТЕМ (используй как образец):
- 1 слово: "Python", "React", "нейросети", "алгоритмы", "данные", "базы", "сервер", "клиент", "API", "фреймворк"
- 2 слова: "машинное обучение", "веб-разработка", "базы данных", "искусственный интеллект", "нейронные сети", "глубокое обучение", "обработка данных", "облачные вычисления"
- 3 слова: "глубокое обучение нейросетей", "веб-разработка на React" (только если действительно нужно, предпочтительно избегать)

ПРИМЕРЫ НЕПРАВИЛЬНЫХ ТЕМ (НЕ используй такие):
- "статья про", "текст о", "информация о", "контент про" (слишком общие)
- "изучение машинного обучения" (глагол, лучше "машинное обучение")
- "как работает нейросеть" (вопрос, лучше "нейросети")
- "машинное обучение и нейронные сети" (слишком длинно, лучше разделить на две темы)

Формат ответа (ТОЛЬКО JSON-массив, БЕЗ markdown):
["тема1", "тема2", "тема3", ...]`;

    const userPrompt = `Извлеки 5-10 ключевых тем из следующего текста. 

ВАЖНО О ФОРМАТЕ ТЕМ:
- Каждая тема должна быть ОТ 1 ДО 3 СЛОВ.
- ПРЕДПОЧТИТЕЛЬНО используй 1-2 слова (например: "Python", "машинное обучение").
- Используй 3 слова ТОЛЬКО если тема действительно требует этого.
- Используй ПРЕИМУЩЕСТВЕННО существительные и прилагательные, избегай глаголов.
- Избегай общих слов типа "статья", "текст", "информация", "контент".
- КРИТИЧЕСКИ ВАЖНО: ВСЕ темы должны быть на РУССКОМ языке, даже если исходный текст на английском или другом языке. Переведи все темы на русский для единообразия "облака смыслов".

Текст:
---
${processedText}
---

ВАЖНО: Ответь ТОЛЬКО валидным JSON-массивом строк БЕЗ markdown разметки (без \`\`\`json и \`\`\`).
ВАЖНО О ЯЗЫКЕ: Все темы должны быть на РУССКОМ языке, независимо от языка исходного текста.

Примеры правильного формата (все на русском):
- ["Python", "машинное обучение", "нейросети", "алгоритмы", "данные"]
- ["React", "веб-разработка", "компоненты", "JavaScript", "UI"]
- ["базы данных", "SQL", "оптимизация", "запросы"]
- ["машинное обучение", "нейронные сети", "глубокое обучение"] (не "machine learning", "neural networks")`;

    try {
        // Используем ту же модель, что и в ai.service.ts
        let aiModel = process.env.AI_MODEL || 'gemini-2.5-flash';
        
        // Автоматическая замена неподдерживаемых моделей
        if (aiModel.includes('anthropic') || aiModel.includes('claude')) {
            console.warn(`⚠️ Detected unsupported model "${aiModel}". Automatically switching to Gemini.`);
            aiModel = 'gemini-2.5-flash';
        }
        
        if (aiModel.includes('gemini-3-pro') || aiModel === 'gemini-3-pro-preview') {
            console.warn(`⚠️ Model "${aiModel}" is not available in FREE tier. Switching to gemini-2.5-flash.`);
            aiModel = 'gemini-2.5-flash';
        }
        
        const validGeminiModels = ['gemini-2.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
        if (!validGeminiModels.includes(aiModel)) {
            console.warn(`⚠️ Unknown model "${aiModel}". Using default: gemini-2.5-flash`);
            aiModel = 'gemini-2.5-flash';
        }

        console.log(`🎯 Extracting themes using AI model: ${aiModel}`);
        console.log(`📊 Text length: ${processedText.length} chars`);

        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timed out.')), 60000)
        );
        
        const completionPromise = apiRequestQueue.add(() => 
            genAI.models.generateContent({
                model: aiModel,
                contents: `${systemInstruction}\n\n${userPrompt}`,
            })
        );
        
        const result = await Promise.race([completionPromise, timeoutPromise]) as any;

        // Извлекаем текст ответа
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

        if (!rawResponse) {
            console.error('❌ AI response content is empty');
            throw new Error('AI response is empty.');
        }

        console.log('Raw AI response (first 500 chars):', rawResponse.substring(0, 500));

        // Очистка от markdown разметки
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
        
        cleanedResponse = cleanedResponse.trim();

        // Извлекаем JSON-массив: находим первый [ и последний ]
        const firstBracket = cleanedResponse.indexOf('[');
        const lastBracket = cleanedResponse.lastIndexOf(']');
        
        if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
            cleanedResponse = cleanedResponse.substring(firstBracket, lastBracket + 1);
        }

        cleanedResponse = escapeControlCharsInJsonStrings(cleanedResponse);

        console.log('Cleaned response (first 300 chars):', cleanedResponse.substring(0, 300));

        // Парсим JSON
        let themes: string[];
        try {
            themes = JSON.parse(cleanedResponse);
        } catch (parseError: any) {
            console.error('JSON parse error:', parseError.message);
            console.error('Failed to parse response (first 1000 chars):', cleanedResponse.substring(0, 1000));
            
            // Попытка исправить распространенные проблемы с JSON
            let fixedResponse = cleanedResponse;
            fixedResponse = fixedResponse.replace(/,(\s*[}\]])/g, '$1'); // Удаляем лишние запятые
            
            try {
                themes = JSON.parse(fixedResponse);
                console.log('✓ Successfully parsed after fixing common JSON issues');
            } catch (secondError: any) {
                // Попытка извлечь массив вручную через регулярное выражение
                // Используем [\s\S] вместо . с флагом s для совместимости с ES6
                const arrayMatch = cleanedResponse.match(/\[([\s\S]*?)\]/);
                if (arrayMatch) {
                    const arrayContent = arrayMatch[1];
                    // Извлекаем строки в кавычках
                    const stringMatches = arrayContent.match(/"([^"]+)"/g);
                    if (stringMatches && stringMatches.length > 0) {
                        themes = stringMatches.map(match => match.replace(/"/g, ''));
                        console.log('✓ Successfully extracted themes using regex fallback');
                    } else {
                        throw new Error(`Failed to parse JSON response: ${parseError.message}. Second attempt: ${secondError.message}`);
                    }
                } else {
                    throw new Error(`Failed to parse JSON response: ${parseError.message}. Second attempt: ${secondError.message}`);
                }
            }
        }

        // Валидация результата
        if (!Array.isArray(themes)) {
            console.error('❌ AI response is not an array:', themes);
            throw new Error('AI response is not an array.');
        }

        // Фильтруем и нормализуем темы
        const normalizedThemes = themes
            .filter((theme: any) => typeof theme === 'string' && theme.trim().length > 0)
            .map((theme: string) => theme.trim())
            .filter((theme: string) => {
                // Проверяем количество слов (должно быть от 1 до 3)
                const wordCount = theme.split(/\s+/).filter(w => w.length > 0).length;
                if (wordCount > 3) {
                    console.warn(`⚠️ [extractThemes] Theme "${theme}" has ${wordCount} words, truncating to 3 words`);
                    // Обрезаем до 3 слов
                    return theme.split(/\s+/).slice(0, 3).join(' ').trim();
                }
                return wordCount >= 1 && wordCount <= 3;
            })
            .map((theme: string) => {
                // Дополнительная нормализация: удаляем лишние пробелы
                return theme.replace(/\s+/g, ' ').trim();
            })
            .filter((theme: string) => theme.length <= 50) // Максимум 50 символов на тему
            .filter((theme: string) => {
                // Фильтруем общие слова
                const commonWords = ['статья', 'текст', 'информация', 'контент', 'материал', 'содержание'];
                const lowerTheme = theme.toLowerCase();
                return !commonWords.some(word => lowerTheme.includes(word));
            })
            .slice(0, 10); // Ограничиваем до 10 тем максимум

        if (normalizedThemes.length === 0) {
            console.warn('⚠️ No themes extracted from text');
            return [];
        }

        console.log(`✅ Successfully extracted ${normalizedThemes.length} themes:`, normalizedThemes);
        return normalizedThemes;

    } catch (error: any) {
        // Определяем тип ошибки для более информативного логирования
        const errorMessage = error.message || String(error);
        let errorType = 'Unknown error';
        
        if (errorMessage.includes('timeout') || errorMessage.includes('timed out') || errorMessage.includes('Request timed out')) {
            errorType = 'Timeout error';
        } else if (errorMessage.includes('quota') || errorMessage.includes('QUOTA_EXCEEDED') || errorMessage.includes('FreeTier') || error.status === 429) {
            errorType = 'API quota exceeded';
        } else if (errorMessage.includes('JSON') || errorMessage.includes('parse')) {
            errorType = 'JSON parsing error';
        } else if (errorMessage.includes('API') || errorMessage.includes('apiKey') || errorMessage.includes('authentication')) {
            errorType = 'API authentication/configuration error';
        } else if (errorMessage.includes('network') || errorMessage.includes('fetch') || errorMessage.includes('ECONNREFUSED')) {
            errorType = 'Network error';
        }
        
        console.error(`❌ [extractThemes] Error extracting themes (${errorType}): ${errorMessage}`);
        if (error.stack) {
            console.error('Stack trace:', error.stack);
        }
        
        // В случае ошибки возвращаем пустой массив (не падаем)
        console.warn(`⚠️ [extractThemes] Returning empty themes array due to ${errorType}`);
        return [];
    }
}

/**
 * Нормализует тему, удаляя лишние слова и приводя к стандартному виду
 * @param theme - Тема для нормализации
 * @returns Нормализованная тема
 */
function normalizeTheme(theme: string): string {
    let normalized = theme.trim().toLowerCase();
    
    // Удаляем лишние слова в конце (союзы, предлоги)
    const stopWords = [' и', ' или', ' для', ' в', ' на', ' с', ' по', ' от', ' к', ' из', ' о', ' об', ' про'];
    for (const stopWord of stopWords) {
        if (normalized.endsWith(stopWord)) {
            normalized = normalized.slice(0, -stopWord.length).trim();
        }
    }
    
    // Удаляем множественные пробелы
    normalized = normalized.replace(/\s+/g, ' ').trim();
    
    return normalized;
}

/**
 * Проверяет, является ли тема дубликатом существующего тега
 * @param newTheme - Новая тема
 * @param existingTags - Существующие теги пользователя
 * @returns Существующий тег, если найден дубликат, или null
 */
function findDuplicateTag(
    newTheme: string, 
    existingTags: Array<{ tag: string; weight: number }>
): { tag: string; weight: number } | null {
    const normalizedNew = normalizeTheme(newTheme);
    
    for (const existing of existingTags) {
        const normalizedExisting = normalizeTheme(existing.tag);
        
        // Точное совпадение после нормализации
        if (normalizedNew === normalizedExisting) {
            return existing;
        }
        
        // Проверка на включение (один тег содержит другой)
        if (normalizedNew.includes(normalizedExisting) || normalizedExisting.includes(normalizedNew)) {
            // Используем более короткий тег (более общий)
            return normalizedNew.length <= normalizedExisting.length ? existing : null;
        }
        
        // Проверка на очень похожие теги (разница в 1-2 символа)
        const similarity = calculateSimilarity(normalizedNew, normalizedExisting);
        if (similarity > 0.85) { // 85% совпадение
            return existing;
        }
    }
    
    return null;
}

/**
 * Вычисляет схожесть двух строк (простой алгоритм)
 * @param str1 - Первая строка
 * @param str2 - Вторая строка
 * @returns Коэффициент схожести от 0 до 1
 */
function calculateSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const distance = levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
}

/**
 * Вычисляет расстояние Левенштейна между двумя строками
 */
function levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];
    
    for (let i = 0; i <= str2.length; i++) {
        matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
        matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
        for (let j = 1; j <= str1.length; j++) {
            if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    
    return matrix[str2.length][str1.length];
}

/**
 * Сохраняет семантические теги пользователя в БД
 * Если тег уже существует - увеличивает его вес (более мягкая схема: +0.5) и обновляет lastUsedAt
 * 
 * ВАЖНО: Темы (semantic tags) - это НЕ интересы пользователя!
 * - Интересы: пользователь сам выбирает категории (например, "AI", "программирование")
 * - Темы: AI автоматически извлекает ключевые темы из проанализированных статей (например, "нейронные сети", "оптимизация моделей")
 * Темы сохраняются в таблицу user_semantic_tags и используются для создания "облака смыслов" пользователя.
 * 
 * @param userId - ID пользователя
 * @param themes - Массив тем для сохранения
 */
export async function saveUserSemanticTags(userId: number, themes: string[]): Promise<void> {
    if (!themes || themes.length === 0) {
        return;
    }

    const MAX_TAG_LENGTH = 255; // Максимальная длина тега в БД (VARCHAR(255))
    const WEIGHT_INCREMENT = 0.5; // Более мягкая схема увеличения веса (вместо +1.0)
    
    try {
        const now = new Date();
        let savedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;
        let mergedCount = 0;
        
        // Получаем существующие теги пользователя для проверки дубликатов
        const existingTags = await UserSemanticTag.findAll({
            where: { userId },
            attributes: ['tag', 'weight']
        });
        const existingTagsList = existingTags.map(t => ({
            tag: t.tag,
            weight: parseFloat(t.weight.toString())
        }));
        
        for (const theme of themes) {
            let normalizedTheme = normalizeTheme(theme);
            
            // Пропускаем пустые теги
            if (!normalizedTheme || normalizedTheme.length === 0) {
                skippedCount++;
                continue;
            }
            
            // Проверяем и обрезаем слишком длинные теги
            if (normalizedTheme.length > MAX_TAG_LENGTH) {
                console.warn(`⚠️ [saveUserSemanticTags] Tag too long (${normalizedTheme.length} chars), truncating: "${normalizedTheme.substring(0, 50)}..."`);
                normalizedTheme = normalizedTheme.substring(0, MAX_TAG_LENGTH);
            }
            
            // Проверяем на дубликаты
            const duplicate = findDuplicateTag(normalizedTheme, existingTagsList);
            if (duplicate) {
                // Найден дубликат - обновляем существующий тег вместо создания нового
                try {
                    const existingTag = await UserSemanticTag.findOne({
                        where: {
                            userId,
                            tag: duplicate.tag
                        }
                    });
                    
                    if (existingTag) {
                        const currentWeight = parseFloat(existingTag.weight.toString());
                        existingTag.weight = currentWeight + WEIGHT_INCREMENT;
                        existingTag.lastUsedAt = now;
                        await existingTag.save();
                        mergedCount++;
                        savedCount++;
                        console.log(`📌 [saveUserSemanticTags] Merged duplicate tag "${normalizedTheme}" -> "${duplicate.tag}" for user ${userId} (weight: ${existingTag.weight.toFixed(2)})`);
                        continue;
                    }
                } catch (error: any) {
                    console.warn(`⚠️ [saveUserSemanticTags] Failed to merge duplicate tag "${normalizedTheme}": ${error.message}`);
                }
            }

            try {
                // Ищем существующий тег
                const [tag, created] = await UserSemanticTag.findOrCreate({
                    where: {
                        userId,
                        tag: normalizedTheme,
                    },
                    defaults: {
                        userId,
                        tag: normalizedTheme,
                        weight: 1.0,
                        lastUsedAt: now,
                    },
                });

                if (!created) {
                    // Тег уже существует - увеличиваем вес более мягко (+0.5 вместо +1.0)
                    // Это предотвращает слишком быстрое раздувание весов при частых анализах
                    const currentWeight = parseFloat(tag.weight.toString());
                    tag.weight = currentWeight + WEIGHT_INCREMENT;
                    tag.lastUsedAt = now;
                    await tag.save();
                    console.log(`📌 [saveUserSemanticTags] Updated semantic tag "${normalizedTheme}" for user ${userId} (weight: ${tag.weight.toFixed(2)})`);
                } else {
                    console.log(`📌 [saveUserSemanticTags] Created new semantic tag "${normalizedTheme}" for user ${userId}`);
                }
                savedCount++;
            } catch (error: any) {
                errorCount++;
                console.warn(`⚠️ [saveUserSemanticTags] Failed to save semantic tag "${normalizedTheme}" for user ${userId}: ${error.message}`);
            }
        }
        
        // Логируем итоговую статистику сохранения
        const statsParts = [];
        if (mergedCount > 0) statsParts.push(`${mergedCount} merged`);
        if (skippedCount > 0) statsParts.push(`${skippedCount} skipped`);
        if (errorCount > 0) statsParts.push(`${errorCount} errors`);
        const statsStr = statsParts.length > 0 ? ` (${statsParts.join(', ')})` : '';
        console.log(`✅ [saveUserSemanticTags] Saved ${savedCount} out of ${themes.length} semantic tags for user ${userId}${statsStr}`);
    } catch (error: any) {
        console.error(`❌ [saveUserSemanticTags] Error saving semantic tags for user ${userId}: ${error.message}`);
    }
}

/**
 * Сохраняет семантические теги пользователя с указанным весом
 * Используется для комментариев - теги из комментария получают больший вес (показывают особый интерес)
 * 
 * @param userId - ID пользователя
 * @param themes - Массив тем для сохранения
 * @param initialWeight - Начальный вес для новых тегов (по умолчанию 1.0, для комментариев можно 2.0)
 */
export async function saveUserSemanticTagsWithWeight(
    userId: number, 
    themes: string[], 
    initialWeight: number = 1.0
): Promise<void> {
    if (!themes || themes.length === 0) {
        return;
    }

    const MAX_TAG_LENGTH = 255;
    const WEIGHT_INCREMENT = 0.5;
    
    try {
        const now = new Date();
        let savedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;
        let mergedCount = 0;
        
        const existingTags = await UserSemanticTag.findAll({
            where: { userId },
            attributes: ['tag', 'weight']
        });
        const existingTagsList = existingTags.map(t => ({
            tag: t.tag,
            weight: parseFloat(t.weight.toString())
        }));
        
        for (const theme of themes) {
            let normalizedTheme = normalizeTheme(theme);
            
            if (!normalizedTheme || normalizedTheme.length === 0) {
                skippedCount++;
                continue;
            }
            
            if (normalizedTheme.length > MAX_TAG_LENGTH) {
                normalizedTheme = normalizedTheme.substring(0, MAX_TAG_LENGTH);
            }
            
            const duplicate = findDuplicateTag(normalizedTheme, existingTagsList);
            if (duplicate) {
                try {
                    const existingTag = await UserSemanticTag.findOne({
                        where: {
                            userId,
                            tag: duplicate.tag
                        }
                    });
                    
                    if (existingTag) {
                        const currentWeight = parseFloat(existingTag.weight.toString());
                        // Для комментариев увеличиваем вес больше
                        existingTag.weight = currentWeight + (initialWeight > 1.0 ? initialWeight : WEIGHT_INCREMENT);
                        existingTag.lastUsedAt = now;
                        await existingTag.save();
                        mergedCount++;
                    }
                } catch (error: any) {
                    errorCount++;
                    console.warn(`⚠️ [saveUserSemanticTagsWithWeight] Failed to update duplicate tag "${normalizedTheme}": ${error.message}`);
                }
            } else {
                try {
                    const [tag, created] = await UserSemanticTag.findOrCreate({
                        where: {
                            userId,
                            tag: normalizedTheme,
                        },
                        defaults: {
                            userId,
                            tag: normalizedTheme,
                            weight: initialWeight, // Используем указанный вес
                            lastUsedAt: now,
                        },
                    });

                    if (!created) {
                        const currentWeight = parseFloat(tag.weight.toString());
                        tag.weight = currentWeight + (initialWeight > 1.0 ? initialWeight : WEIGHT_INCREMENT);
                        tag.lastUsedAt = now;
                        await tag.save();
                    }
                    savedCount++;
                } catch (error: any) {
                    errorCount++;
                    console.warn(`⚠️ [saveUserSemanticTagsWithWeight] Failed to save tag "${normalizedTheme}": ${error.message}`);
                }
            }
        }
        
        console.log(`✅ [saveUserSemanticTagsWithWeight] Saved ${savedCount} tags (${mergedCount} merged, ${skippedCount} skipped, ${errorCount} errors) with weight ${initialWeight}`);
    } catch (error: any) {
        console.error(`❌ [saveUserSemanticTagsWithWeight] Error saving semantic tags for user ${userId}: ${error.message}`);
    }
}

/**
 * Анализирует тональность комментария (положительный/отрицательный)
 * @param comment - Текст комментария
 * @returns Объект с тональностью и модификатором веса
 */
export async function analyzeCommentSentiment(comment: string): Promise<{ sentiment: 'positive' | 'negative' | 'neutral'; weightModifier: number }> {
    try {
        const prompt = `Проанализируй тональность комментария пользователя к статье. Определи, нравится ли статья пользователю или нет.

Комментарий: "${comment}"

Ответь ТОЛЬКО одним словом: "positive" (нравится), "negative" (не нравится) или "neutral" (нейтрально).`;

        // Используем ту же модель, что и в других местах (или из env)
        const aiModel = process.env.AI_MODEL || 'gemini-2.5-flash';
        
        const result = await apiRequestQueue.add(() => 
            genAI.models.generateContent({
                model: aiModel,
                contents: prompt,
            })
        ) as any;

        // Извлекаем текст ответа (как в других местах кода)
        let responseText = '';
        if (result.text) {
            responseText = result.text;
        } else if (result.response && result.response.text) {
            responseText = result.response.text();
        } else if (typeof result === 'string') {
            responseText = result;
        } else {
            responseText = 'neutral';
        }
        responseText = responseText.trim().toLowerCase();
        if (responseText.includes('positive') || responseText.includes('нравится')) {
            return { sentiment: 'positive', weightModifier: 1.5 }; // Увеличиваем вес
        } else if (responseText.includes('negative') || responseText.includes('не нравится')) {
            return { sentiment: 'negative', weightModifier: 0.5 }; // Уменьшаем вес
        }
        return { sentiment: 'neutral', weightModifier: 1.0 };
    } catch (error: any) {
        console.warn(`⚠️ [analyzeCommentSentiment] Failed to analyze sentiment: ${error.message}`);
        return { sentiment: 'neutral', weightModifier: 1.0 };
    }
}

/**
 * Получает теги из статей с комментариями пользователя
 * @param userId - ID пользователя
 * @returns Массив объектов с тегами статьи и комментарием
 */
async function getCommentedArticlesThemes(userId: number): Promise<Array<{ themes: string[]; comment: string; sentiment: 'positive' | 'negative' | 'neutral' }>> {
    try {
        const AnalysisHistory = (await import('../models/AnalysisHistory')).default;
        const historyRecords = await AnalysisHistory.findAll({
            where: { userId },
            attributes: ['reasoning'],
            order: [['createdAt', 'DESC']],
            limit: 50 // Берем последние 50 статей
        });

        const commentedArticles: Array<{ themes: string[]; comment: string; sentiment: 'positive' | 'negative' | 'neutral' }> = [];

        for (const record of historyRecords) {
            if (record.reasoning && record.reasoning.includes('[COMMENT_DATA]')) {
                const match = record.reasoning.match(/\[COMMENT_DATA\](.*?)\[END_COMMENT_DATA\]/);
                if (match) {
                    try {
                        const commentData = JSON.parse(match[1]);
                        if (commentData.comment && commentData.articleThemes && Array.isArray(commentData.articleThemes)) {
                            // Используем сохраненную тональность (если есть) или анализируем
                            const sentiment = commentData.sentiment || (await analyzeCommentSentiment(commentData.comment)).sentiment;
                            commentedArticles.push({
                                themes: commentData.articleThemes,
                                comment: commentData.comment,
                                sentiment: sentiment
                            });
                        }
                    } catch (parseError) {
                        console.warn('Failed to parse comment data:', parseError);
                    }
                }
            }
        }

        return commentedArticles;
    } catch (error: any) {
        console.warn(`⚠️ [getCommentedArticlesThemes] Failed to get commented articles: ${error.message}`);
        return [];
    }
}

/**
 * Результат сравнения тем статьи с тегами пользователя
 */
export interface ThemeComparisonResult {
    matchPercentage: number;
    matchedThemes: Array<{ theme: string; userTag: string; weight: number }>;
    unmatchedArticleThemes: string[];
    totalUserTagsWeight: number;
    matchedWeight: number;
    hasNoTags: boolean;
    semanticVerdict?: string;
}

/**
 * Сравнивает темы статьи с тегами пользователя из "облака смыслов"
 * Используется в режиме 'unread' для определения релевантности статьи на основе семантики
 * 
 * @param articleThemes - Темы, извлеченные из статьи
 * @param userTags - Теги пользователя из БД (с весами)
 * @param userId - ID пользователя (опционально, для учета комментариев)
 * @returns Результат сравнения с информацией о совпадениях и проценте релевантности
 */
export async function compareThemes(
    articleThemes: string[],
    userTags: Array<{ tag: string; weight: number }>,
    userId?: number
): Promise<ThemeComparisonResult> {
    if (!articleThemes || articleThemes.length === 0) {
        return {
            matchPercentage: 0,
            matchedThemes: [],
            unmatchedArticleThemes: [],
            totalUserTagsWeight: 0,
            matchedWeight: 0,
            hasNoTags: false,
        };
    }

    if (!userTags || userTags.length === 0) {
        return {
            matchPercentage: 0,
            matchedThemes: [],
            unmatchedArticleThemes: articleThemes,
            totalUserTagsWeight: 0,
            matchedWeight: 0,
            hasNoTags: true, // У пользователя нет тегов
        };
    }

    // Нормализуем темы статьи для сравнения
    const normalizedArticleThemes = articleThemes.map(theme => normalizeTagForComparison(theme));
    
    // Создаем Map для быстрого поиска тегов пользователя (с нормализацией)
    const userTagsMap = new Map<string, { originalTag: string; weight: number }>();
    let totalUserTagsWeight = 0;
    
    for (const userTag of userTags) {
        const normalizedTag = normalizeTagForComparison(userTag.tag);
        const weight = parseFloat(userTag.weight.toString());
        // Сохраняем оригинальный тег для отображения
        userTagsMap.set(normalizedTag, { originalTag: userTag.tag, weight });
        totalUserTagsWeight += weight;
    }

    // Находим совпадения
    const matchedThemes: Array<{ theme: string; userTag: string; weight: number }> = [];
    const unmatchedArticleThemes: string[] = [];
    const matchedIndices = new Set<number>(); // Индексы тем, которые уже совпали

    for (let i = 0; i < normalizedArticleThemes.length; i++) {
        const articleTheme = normalizedArticleThemes[i];
        const originalTheme = articleThemes[i];
        let foundMatch = false;
        
        // 1. Проверяем точное совпадение после нормализации
        const exactMatch = userTagsMap.get(articleTheme);
        if (exactMatch) {
            matchedThemes.push({
                theme: originalTheme,
                userTag: exactMatch.originalTag,
                weight: exactMatch.weight,
            });
            matchedIndices.add(i);
            foundMatch = true;
        } else {
            // 2. Проверяем синонимы
            for (const [normalizedUserTag, tagData] of userTagsMap.entries()) {
                if (areSynonyms(articleTheme, normalizedUserTag)) {
                    matchedThemes.push({
                        theme: originalTheme,
                        userTag: tagData.originalTag,
                        weight: tagData.weight,
                    });
                    matchedIndices.add(i);
                    foundMatch = true;
                    break;
                }
            }
            
                    // 3. Проверяем частичное совпадение (улучшенная логика)
            if (!foundMatch) {
                // Разбиваем теги на слова для более точного сравнения
                const articleWords = articleTheme.split(/\s+/).filter(w => w.length > 2);
                
                for (const [normalizedUserTag, tagData] of userTagsMap.entries()) {
                    const userTagWords = normalizedUserTag.split(/\s+/).filter(w => w.length > 2);
                    
                    // Проверяем, есть ли общие значимые слова
                    const commonWords = articleWords.filter(w => userTagWords.includes(w));
                    
                    // Если есть хотя бы одно общее слово или одно содержит другое
                    if (commonWords.length > 0 || 
                        articleTheme.includes(normalizedUserTag) || 
                        normalizedUserTag.includes(articleTheme)) {
                        matchedThemes.push({
                            theme: originalTheme,
                            userTag: tagData.originalTag,
                            weight: tagData.weight,
                        });
                        matchedIndices.add(i);
                        foundMatch = true;
                        break;
                    }
                }
            }
        }
        
        if (!foundMatch) {
            unmatchedArticleThemes.push(originalTheme);
        }
    }

    // УЧЕТ КОММЕНТАРИЕВ: Проверяем совпадения с тегами из статей с комментариями
    let commentBoost = 0;
    if (userId) {
        try {
            const commentedArticles = await getCommentedArticlesThemes(userId);
            
            // Проверяем совпадения тегов новой статьи с тегами из статей с комментариями
            for (const commentedArticle of commentedArticles) {
                const commonThemes = articleThemes.filter(theme => 
                    commentedArticle.themes.some(ct => 
                        normalizeTagForComparison(theme) === normalizeTagForComparison(ct)
                    )
                );
                
                if (commonThemes.length > 0) {
                    // Если есть совпадения, учитываем тональность комментария
                    if (commentedArticle.sentiment === 'positive') {
                        // Положительный комментарий - увеличиваем вес совпавших тегов
                        commentBoost += commonThemes.length * 0.3; // +0.3% за каждое совпадение
                        console.log(`📌 [compareThemes] Found ${commonThemes.length} matching themes with positive comment`);
                    } else if (commentedArticle.sentiment === 'negative') {
                        // Отрицательный комментарий - уменьшаем вес
                        commentBoost -= commonThemes.length * 0.2; // -0.2% за каждое совпадение
                        console.log(`📌 [compareThemes] Found ${commonThemes.length} matching themes with negative comment`);
                    }
                }
            }
        } catch (error: any) {
            console.warn(`⚠️ [compareThemes] Failed to check commented articles: ${error.message}`);
        }
    }

    // Вычисляем процент совпадения комбинированным способом
    const matchedWeight = matchedThemes.reduce((sum, match) => sum + match.weight, 0);
    
    // 1. Процент совпадения тем статьи (сколько тем из статьи совпало) - ГЛАВНЫЙ показатель
    const articleMatchRatio = normalizedArticleThemes.length > 0
        ? matchedThemes.length / normalizedArticleThemes.length
        : 0;
    
    // 2. Процент веса совпавших тем относительно веса всех тегов пользователя (вторичный показатель)
    const weightMatchRatio = totalUserTagsWeight > 0
        ? matchedWeight / totalUserTagsWeight
        : 0;
    
    // Комбинированный процент: 80% от совпадения тем статьи + 20% от веса совпавших тем
    // Это учитывает, что главное - сколько тем из статьи совпало, а не сколько это от всех тегов пользователя
    let combinedMatchPercentage = Math.round(
        articleMatchRatio * 80 + weightMatchRatio * 20
    );
    
    // Бонусы за количество совпавших тем
    if (matchedThemes.length >= 8) {
        // Если совпало ≥8 тем, это очень хорошее совпадение
        combinedMatchPercentage = Math.max(combinedMatchPercentage, 60);
    } else if (matchedThemes.length >= 5) {
        // Если совпало ≥5 тем, это хорошее совпадение
        combinedMatchPercentage = Math.max(combinedMatchPercentage, 45);
    } else if (matchedThemes.length >= 3) {
        // Если совпало ≥3 темы, это умеренное совпадение
        combinedMatchPercentage = Math.max(combinedMatchPercentage, 30);
    }
    
    // Дополнительный бонус, если совпало много тем относительно статьи
    if (articleMatchRatio >= 0.6 && matchedThemes.length >= 5) {
        // Если совпало ≥60% тем статьи и хотя бы 5 тем, это отличное совпадение
        combinedMatchPercentage = Math.max(combinedMatchPercentage, Math.round(articleMatchRatio * 100));
    }
    
    // Применяем бонус/штраф от комментариев
    combinedMatchPercentage += commentBoost;
    
    // Ограничиваем процент до 0-100
    const finalMatchPercentage = Math.max(0, Math.min(Math.round(combinedMatchPercentage), 100));

    console.log(`📊 [compareThemes] Comparison result: ${finalMatchPercentage}% match (${matchedThemes.length}/${normalizedArticleThemes.length} themes matched)`);
    
    return {
        matchPercentage: finalMatchPercentage,
        matchedThemes,
        unmatchedArticleThemes,
        totalUserTagsWeight,
        matchedWeight,
        hasNoTags: false,
    };
}

/**
 * Получает RAG контекст из похожих статей для улучшения рекомендаций
 * 
 * @param articleText - Текст статьи для анализа
 * @param userId - ID пользователя
 * @returns Контекст из похожих статей или пустая строка
 */
async function getRAGContextForRecommendation(
    articleText: string,
    userId: number
): Promise<string> {
    try {
        // Используем весь текст статьи (до 50000 символов) для максимальной точности рекомендаций
        const MAX_TEXT_LENGTH = 50000; // Максимум для очень длинных статей
        const textForEmbedding = articleText.length > MAX_TEXT_LENGTH ? articleText.substring(0, MAX_TEXT_LENGTH) : articleText;
        if (textForEmbedding.length < 50) {
            return '';
        }

        const articleEmbedding = await generateEmbedding(textForEmbedding);
        const similarArticles = await findSimilarArticles(
            articleEmbedding,
            userId,
            undefined,
            3, // Топ-3 для рекомендаций
            0.45 // Порог схожести 45%
        );

        if (similarArticles.length === 0) {
            return '';
        }

        return `\n\n**Контекст из похожих статей в вашей истории:**
${similarArticles.map((a, idx) => 
    `${idx + 1}. ${a.url} (${Math.round(a.similarity * 100)}% похоже)${a.summary ? `\n   Саммари: ${a.summary.substring(0, 150)}${a.summary.length > 150 ? '...' : ''}` : ''}`
).join('\n\n')}

Используй эту информацию: если статья похожа на те, что пользователь читал ранее, это может быть хорошим признаком релевантности.`;
    } catch (error: any) {
        console.warn(`⚠️ [RAG Recommendation] Failed to get RAG context: ${error.message}`);
        return '';
    }
}

/**
 * Генерирует AI-рекомендацию на основе сравнения тем статьи с тегами пользователя
 * Используется в режиме 'unread' для предоставления персонализированной рекомендации
 * 
 * @param articleThemes - Темы, извлеченные из статьи
 * @param userTags - Теги пользователя из БД (с весами)
 * @param comparisonResult - Результат сравнения тем
 * @param articleText - Текст статьи для RAG контекста (опционально)
 * @param userId - ID пользователя для RAG контекста (опционально)
 * @returns AI-рекомендация в виде текста
 */
export async function generateSemanticRecommendation(
    articleThemes: string[],
    userTags: Array<{ tag: string; weight: number }>,
    comparisonResult: {
        matchPercentage: number;
        matchedThemes: Array<{ theme: string; userTag: string; weight: number }>;
        unmatchedArticleThemes: string[];
    },
    articleText?: string,
    userId?: number
): Promise<string> {
    // Если у пользователя нет тегов или совпадение 0%, возвращаем стандартное сообщение
    // (этот случай обрабатывается на уровне контроллера, но на всякий случай)
    if (!userTags || userTags.length === 0) {
        return 'У вас пока нет тегов в "облаке смыслов". Проанализируйте несколько статей в режиме "Я это прочитал и понравилось", чтобы начать формировать облако смыслов и получать персонализированные рекомендации.';
    }

    // Если совпадение очень низкое (< 10%), не тратим API-запрос, возвращаем простую рекомендацию
    if (comparisonResult.matchPercentage < 10) {
        const themesPreview = articleThemes.slice(0, 5).join(', ') || 'неизвестные темы';
        return `Эта статья имеет низкое совпадение с вашими интересами (${comparisonResult.matchPercentage}%). Темы статьи (${themesPreview}) не совпадают с темами, которые вы изучали ранее.`;
    }

    // Проверяем, что у нас есть темы для анализа
    if (!articleThemes || articleThemes.length === 0) {
        return 'Не удалось извлечь темы из статьи. Рекомендуется прочитать статью самостоятельно, чтобы оценить её релевантность.';
    }

    try {
        const systemInstruction = `Ты — помощник для анализа релевантности контента на основе семантических тегов пользователя. Твоя задача — дать краткую рекомендацию о том, стоит ли пользователю читать статью на основе совпадения тем.

ВАЖНО:
- Твой ответ должен быть ТОЛЬКО текстом рекомендации БЕЗ markdown разметки.
- Рекомендация должна быть на русском языке.
- Будь конкретным и полезным.
- Учитывай процент совпадения и вес совпавших тем.
- Длина рекомендации: 2-4 предложения (50-150 символов).

Формат ответа: Просто текст рекомендации, без дополнительных форматирований.`;

        // Формируем список совпавших тем с весами
        const matchedThemesList = comparisonResult.matchedThemes
            .slice(0, 5) // Топ-5 совпавших тем
            .map(m => `"${m.theme}" (вес: ${m.weight.toFixed(1)})`)
            .join(', ');

        // Формируем список новых тем
        const newThemesList = comparisonResult.unmatchedArticleThemes
            .slice(0, 5) // Топ-5 новых тем
            .join(', ');

        // Формируем список тегов пользователя (топ-10 по весу)
        const topUserTags = userTags
            .slice(0, 10)
            .map(t => `"${t.tag}" (вес: ${t.weight.toFixed(1)})`)
            .join(', ');

        // Получаем RAG контекст из похожих статей (опционально)
        let ragContext = '';
        if (articleText && userId) {
            try {
                ragContext = await getRAGContextForRecommendation(articleText, userId);
            } catch (error: any) {
                console.warn(`⚠️ [generateSemanticRecommendation] RAG context failed: ${error.message}`);
                // Продолжаем без RAG контекста
            }
        }

        const userPrompt = `Проанализируй релевантность статьи для пользователя на основе совпадения тем.

**Темы статьи:**
${articleThemes.slice(0, 10).join(', ')}

**Теги пользователя (из "облака смыслов", топ-10 по важности):**
${topUserTags}

**Результат сравнения:**
- Процент совпадения: ${comparisonResult.matchPercentage}%
- Совпавшие темы: ${comparisonResult.matchedThemes.length} из ${articleThemes.length} тем статьи (${Math.round(comparisonResult.matchedThemes.length / articleThemes.length * 100)}% тем статьи)
- Список совпавших тем: ${matchedThemesList || 'нет совпадений'}
- Новые темы в статье: ${comparisonResult.unmatchedArticleThemes.length} (${newThemesList || 'нет новых тем'})${ragContext}

**Твоя задача:**
Дай конкретную и полезную рекомендацию (2-4 предложения, 50-200 символов): стоит ли пользователю читать эту статью?

ВАЖНО - учитывай КОЛИЧЕСТВО совпавших тем, а не только процент:
- Если совпало ${comparisonResult.matchedThemes.length >= 5 ? 'много тем (≥5)' : comparisonResult.matchedThemes.length >= 3 ? 'несколько тем (3-4)' : 'мало тем (<3)'} - это ${comparisonResult.matchedThemes.length >= 5 ? 'хороший признак релевантности' : comparisonResult.matchedThemes.length >= 3 ? 'умеренный признак релевантности' : 'слабый признак релевантности'}
- Процент совпадения ${comparisonResult.matchPercentage}% может быть занижен, если у пользователя много разных тегов
- Если совпало ${comparisonResult.matchedThemes.length} тем из ${articleThemes.length}, это ${comparisonResult.matchedThemes.length >= articleThemes.length * 0.5 ? 'хорошее совпадение' : comparisonResult.matchedThemes.length >= articleThemes.length * 0.3 ? 'умеренное совпадение' : 'слабое совпадение'}

Будь конкретным и позитивным: если совпало много тем (≥5) - обязательно скажи, что статья релевантна, даже если процент низкий. Если совпало несколько тем (3-4) - укажи на потенциальную пользу. Если мало тем (<3) - объясни, почему может быть не интересно.

Ответь ТОЛЬКО текстом рекомендации на русском языке, без markdown разметки, без кавычек, без префиксов типа "Рекомендация:".`;

        // Используем ту же модель и очередь запросов, что и в extractThemes
        let aiModel = process.env.AI_MODEL || 'gemini-2.5-flash';
        
        // Автоматическая замена неподдерживаемых моделей
        if (aiModel.includes('anthropic') || aiModel.includes('claude')) {
            aiModel = 'gemini-2.5-flash';
        }
        
        if (aiModel.includes('gemini-3-pro') || aiModel === 'gemini-3-pro-preview') {
            aiModel = 'gemini-2.5-flash';
        }
        
        const validGeminiModels = ['gemini-2.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
        if (!validGeminiModels.includes(aiModel)) {
            aiModel = 'gemini-2.5-flash';
        }

        console.log(`🤖 [generateSemanticRecommendation] Generating recommendation using ${aiModel}`);

        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timed out.')), 30000) // 30 секунд для рекомендации
        );
        
        const completionPromise = apiRequestQueue.add(async () => {
            try {
                const response = await genAI.models.generateContent({
                    model: aiModel,
                    contents: `${systemInstruction}\n\n${userPrompt}`,
                });
                return response;
            } catch (apiError: any) {
                console.error(`❌ [generateSemanticRecommendation] API call failed: ${apiError.message}`);
                throw apiError;
            }
        });
        
        const result = await Promise.race([completionPromise, timeoutPromise]) as any;

        // Извлекаем текст ответа
        let rawResponse: string;
        if (result.text) {
            rawResponse = result.text;
        } else if (result.response && typeof result.response.text === 'function') {
            rawResponse = await result.response.text();
        } else if (result.response && result.response.text) {
            rawResponse = result.response.text;
        } else if (typeof result === 'string') {
            rawResponse = result;
        } else {
            console.error('❌ [generateSemanticRecommendation] AI response has unexpected structure:', JSON.stringify(result, null, 2));
            throw new Error('AI service returned response in unexpected format.');
        }

        if (!rawResponse) {
            console.error('❌ [generateSemanticRecommendation] AI response content is empty');
            throw new Error('AI response is empty.');
        }

        // Очистка от markdown разметки
        let cleanedResponse = rawResponse.trim();
        
        // Удаляем ``` в начале и конце
        if (cleanedResponse.startsWith('```')) {
            cleanedResponse = cleanedResponse.replace(/^```[a-z]*\s*/i, '');
        }
        if (cleanedResponse.endsWith('```')) {
            cleanedResponse = cleanedResponse.replace(/\s*```$/, '');
        }
        
        cleanedResponse = cleanedResponse.trim();

        // Ограничиваем длину рекомендации
        if (cleanedResponse.length > 300) {
            cleanedResponse = cleanedResponse.substring(0, 297) + '...';
        }

        console.log(`✅ [generateSemanticRecommendation] Generated recommendation (${cleanedResponse.length} chars)`);
        return cleanedResponse;

    } catch (error: any) {
        const errorMessage = error.message || String(error);
        let errorType = 'Unknown error';
        
        if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
            errorType = 'Timeout error';
        } else if (errorMessage.includes('quota') || errorMessage.includes('QUOTA_EXCEEDED') || error.status === 429) {
            errorType = 'API quota exceeded';
        } else if (errorMessage.includes('network') || errorMessage.includes('ECONNREFUSED')) {
            errorType = 'Network error';
        }
        
        console.error(`❌ [generateSemanticRecommendation] Error generating recommendation (${errorType}): ${errorMessage}`);
        
        // Возвращаем fallback рекомендацию на основе процента совпадения
        if (comparisonResult.matchPercentage >= 70) {
            return `Эта статья хорошо соответствует вашим интересам (${comparisonResult.matchPercentage}% совпадение тем). Рекомендуется к прочтению.`;
        } else if (comparisonResult.matchPercentage >= 40) {
            return `Статья частично соответствует вашим интересам (${comparisonResult.matchPercentage}% совпадение). Может быть интересна для расширения кругозора.`;
        } else {
            return `Статья имеет низкое совпадение с вашими интересами (${comparisonResult.matchPercentage}%). Возможно, стоит поискать более релевантный контент.`;
        }
    }
}
