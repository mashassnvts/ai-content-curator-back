import { GoogleGenAI } from '@google/genai';
import sequelize from '../config/database';
import { traceSpan } from '../observability/langfuse-helpers';
import { QueryTypes } from 'sequelize';

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in environment variables.');
}

const genAI = apiKey ? new GoogleGenAI({ apiKey }) : new GoogleGenAI({});

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const IS_DEBUG = LOG_LEVEL === 'debug';

// Очередь запросов для предотвращения rate limiting
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

/**
 * Генерирует эмбеддинг для текста через Gemini API
 * Использует модель text-embedding-004 или аналогичную
 * 
 * @param text - Текст для генерации эмбеддинга
 * @returns Массив чисел (вектор эмбеддинга)
 */
export async function generateEmbedding(text: string): Promise<number[]> {
    if (!text || text.trim().length < 10) {
        throw new Error('Text is too short for embedding generation. Minimum 10 characters.');
    }

    try {
        // Используем Gemini для генерации эмбеддингов
        // Примечание: Gemini может не иметь прямого embedding API, поэтому используем альтернативный подход
        // Если у Gemini есть embedding API, используйте его напрямую
        
        // Для Gemini используем models.embedContent если доступно, иначе используем альтернативный метод
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Embedding generation timed out.')), 30000)
        );

        let embedding: number[] | undefined;

        // Используем Gemini Embedding API
        // Модель: gemini-embedding-001 (размерность по умолчанию: 3072, можно уменьшить до 768)
        const embeddingResponse = await Promise.race([
            traceSpan(
                'embedding-gemini',
                () => apiRequestQueue.add(async () => {
                    try {
                        let result: any;
                        try {
                            result = await genAI.models.embedContent({
                                model: 'gemini-embedding-001',
                                contents: text
                            });
                        } catch (simpleError: any) {
                            if (IS_DEBUG) {
                                console.log(`⚠️ [generateEmbedding] Simple format failed, trying array: ${simpleError.message}`);
                            }
                            result = await genAI.models.embedContent({
                                model: 'gemini-embedding-001',
                                contents: text
                            });
                        }
                        return result;
                    } catch (apiError: any) {
                        console.error(`❌ [generateEmbedding] API call failed: ${apiError.message}`);
                        console.error(`❌ [generateEmbedding] Error details:`, apiError);
                        throw apiError;
                    }
                }),
                { model: 'gemini-embedding-001', inputLength: text.length }
            ),
            timeoutPromise
        ]) as any;

        // Извлекаем эмбеддинг из ответа
        // Формат ответа Gemini API: { embeddings: [{ values: [числа] }] }
        if (embeddingResponse && embeddingResponse.embeddings && Array.isArray(embeddingResponse.embeddings)) {
            // Если массив эмбеддингов (для нескольких текстов)
            const firstEmbedding = embeddingResponse.embeddings[0];
            if (firstEmbedding && firstEmbedding.values && Array.isArray(firstEmbedding.values)) {
                embedding = firstEmbedding.values;
            } else if (Array.isArray(firstEmbedding)) {
                embedding = firstEmbedding;
            }
        } else if (embeddingResponse && embeddingResponse.embedding) {
            // Альтернативный формат
            if (embeddingResponse.embedding.values && Array.isArray(embeddingResponse.embedding.values)) {
                embedding = embeddingResponse.embedding.values;
            } else if (Array.isArray(embeddingResponse.embedding)) {
                embedding = embeddingResponse.embedding;
            }
        } else if (embeddingResponse && Array.isArray(embeddingResponse)) {
            // Прямой массив
            embedding = embeddingResponse;
        }
        
        if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
            console.error(`❌ [generateEmbedding] Unexpected embedding response format:`, JSON.stringify(embeddingResponse, null, 2));
            throw new Error('Unexpected embedding response format');
        }

        const validEmbedding: number[] = embedding;

        // Gemini embedding-001 по умолчанию возвращает 3072 измерения
        // Для совместимости с pgvector (vector(768)) обрезаем до 768, если больше
        const targetDimension = 768;
        let finalEmbedding: number[];
        if (validEmbedding.length > targetDimension) {
            if (IS_DEBUG) {
                console.log(`📊 [generateEmbedding] Truncating embedding from ${validEmbedding.length} to ${targetDimension} dimensions`);
            }
            finalEmbedding = validEmbedding.slice(0, targetDimension);
        } else if (validEmbedding.length < targetDimension) {
            console.warn(`⚠️ [generateEmbedding] Embedding dimension is ${validEmbedding.length}, expected at least ${targetDimension}`);
            finalEmbedding = [...validEmbedding, ...new Array(targetDimension - validEmbedding.length).fill(0)];
        } else {
            finalEmbedding = validEmbedding;
        }

        if (IS_DEBUG) {
            console.log(`✅ [generateEmbedding] Generated embedding (dimension: ${finalEmbedding.length})`);
        }
        return finalEmbedding;

    } catch (error: any) {
        const errorMessage = error.message || String(error);
        console.error(`❌ [generateEmbedding] Error generating embedding: ${errorMessage}`);
        throw new Error(`Failed to generate embedding: ${errorMessage}`);
    }
}

/**
 * Сохраняет эмбеддинг статьи в БД
 * 
 * @param analysisHistoryId - ID записи в analysis_history
 * @param embedding - Массив чисел (вектор эмбеддинга)
 */
export async function saveEmbedding(analysisHistoryId: number, embedding: number[]): Promise<void> {
    if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
        throw new Error('Invalid embedding: must be a non-empty array');
    }

    try {
        // Преобразуем массив в формат для PostgreSQL vector типа
        // Формат: '[0.1,0.2,0.3]' или просто массив чисел
        const embeddingString = `[${embedding.join(',')}]`;

        await sequelize.query(`
            UPDATE analysis_history 
            SET embedding = $embedding::vector
            WHERE id = $id
        `, {
            bind: { 
                embedding: embeddingString,
                id: analysisHistoryId 
            }
            // Не указываем type для UPDATE запросов
        });

        if (IS_DEBUG) {
            console.log(`✅ [saveEmbedding] Saved embedding for analysis_history ID: ${analysisHistoryId}`);
        }
    } catch (error: any) {
        console.error(`❌ [saveEmbedding] Error saving embedding: ${error.message}`);
        throw error;
    }
}

/**
 * Находит похожие статьи на основе эмбеддинга
 * 
 * @param queryEmbedding - Эмбеддинг для поиска
 * @param userId - ID пользователя (опционально, для фильтрации по пользователю)
 * @param excludeId - ID статьи для исключения из результатов
 * @param limit - Максимальное количество результатов (по умолчанию 5)
 * @param similarityThreshold - Минимальный порог схожести (0-1, по умолчанию 0.7)
 * @returns Массив похожих статей с полями id, url, summary, similarity
 */
export async function findSimilarArticles(
    queryEmbedding: number[],
    userId?: number | null,
    excludeId?: number,
    limit: number = 5,
    similarityThreshold: number = 0.45 // Порог схожести 45% - более мягкий для лучшего покрытия
): Promise<Array<{
    id: number;
    url: string;
    summary: string | null;
    similarity: number;
}>> {
    if (!queryEmbedding || !Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
        throw new Error('Invalid query embedding');
    }

    try {
        const embeddingString = `[${queryEmbedding.join(',')}]`;
        
        let whereClause = 'embedding IS NOT NULL';
        const bindParams: any = {
            embedding: embeddingString,
            threshold: 1 - similarityThreshold, // Преобразуем similarity в distance
            limit
        };

        if (userId) {
            whereClause += ' AND "userId" = $userId';
            bindParams.userId = userId;
            if (IS_DEBUG) {
                console.log(`🔍 [findSimilarArticles] Filtering by userId: ${userId}`);
            }
        } else {
            if (IS_DEBUG) {
                console.log(`🔍 [findSimilarArticles] No userId filter - searching all users`);
            }
        }

        if (excludeId) {
            whereClause += ' AND id != $excludeId';
            bindParams.excludeId = excludeId;
            if (IS_DEBUG) {
                console.log(`🔍 [findSimilarArticles] Excluding article ID: ${excludeId}`);
            }
        }

        if (IS_DEBUG) {
            console.log(`🔍 [findSimilarArticles] Similarity threshold: ${similarityThreshold} (distance threshold: ${bindParams.threshold})`);
        }

        // Улучшенный запрос: используем cosine similarity напрямую
        // 1 - (embedding <=> $embedding) дает similarity от 0 до 1
        const results = await sequelize.query(`
            SELECT 
                id, 
                url, 
                summary,
                ROUND((1 - (embedding <=> $embedding::vector))::numeric, 4) as similarity
            FROM analysis_history
            WHERE ${whereClause}
              AND (1 - (embedding <=> $embedding::vector)) >= $threshold
            ORDER BY embedding <=> $embedding::vector ASC
            LIMIT $limit
        `, {
            bind: bindParams,
            type: QueryTypes.SELECT
        }) as Array<{
            id: number;
            url: string;
            summary: string | null;
            similarity: number | string;
        }>;
        
        if (IS_DEBUG) {
            console.log(`📊 [findSimilarArticles] Raw results from DB: ${results.length} articles`);
        }
        
        // Преобразуем similarity в число, если это строка
        const normalizedResults = results.map(r => ({
            ...r,
            similarity: typeof r.similarity === 'string' ? parseFloat(r.similarity) : r.similarity
        }));

        // Дополнительная фильтрация на клиенте для гарантии соответствия порогу
        // (на случай, если SQL запрос вернул результаты ниже порога из-за округления)
        const filteredResults = normalizedResults.filter(r => r.similarity >= similarityThreshold);
        
        if (IS_DEBUG) {
            console.log(`✅ [findSimilarArticles] Found ${filteredResults.length} similar articles (after filtering by threshold ${similarityThreshold})`);
            if (filteredResults.length > 0) {
                console.log(`📋 [findSimilarArticles] Top result: ID ${filteredResults[0].id}, similarity: ${filteredResults[0].similarity}`);
            } else if (normalizedResults.length > 0) {
                console.log(`⚠️ [findSimilarArticles] All ${normalizedResults.length} results were below threshold ${similarityThreshold}`);
                console.log(`📋 [findSimilarArticles] Top result (below threshold): ID ${normalizedResults[0].id}, similarity: ${normalizedResults[0].similarity}`);
            }
        }
        
        return filteredResults;

    } catch (error: any) {
        const msg = error.message || String(error);
        if (msg.includes('operator does not exist') && msg.includes('text <=> vector')) {
            console.warn(`⚠️ [findSimilarArticles] Column 'embedding' is TEXT, not vector. Run fix-embedding-column.sql in Neon. Returning empty.`);
            return [];
        }
        console.error(`❌ [findSimilarArticles] Error finding similar articles: ${msg}`);
        throw error;
    }
}

/**
 * Генерирует эмбеддинг и сохраняет его для статьи
 * 
 * @param text - Текст статьи
 * @param analysisHistoryId - ID записи в analysis_history
 */
export async function generateAndSaveEmbedding(text: string, analysisHistoryId: number): Promise<void> {
    try {
        const embedding = await generateEmbedding(text);
        await saveEmbedding(analysisHistoryId, embedding);
    } catch (error: any) {
        console.error(`❌ [generateAndSaveEmbedding] Error: ${error.message}`);
        // Не прерываем основной процесс, если эмбеддинг не удалось сохранить
        throw error;
    }
}
