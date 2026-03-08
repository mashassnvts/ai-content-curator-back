/**
 * Единый провайдер LLM: Gemini или DeepSeek.
 * Переключение: AI_PROVIDER=gemini | deepseek
 * Ключи: GEMINI_API_KEY (для gemini), DEEPSEEK_API_KEY (для deepseek)
 * Модель: AI_MODEL (gemini-2.5-flash / deepseek-chat по умолчанию)
 *
 * Эмбеддинги остаются на Gemini (embedding.service.ts).
 */

import axios from 'axios';

export type LlmProvider = 'gemini' | 'deepseek';

const PROVIDER = (process.env.AI_PROVIDER || 'gemini').toLowerCase().trim() as LlmProvider;
const VALID_PROVIDERS: LlmProvider[] = ['gemini', 'deepseek'];

export function getProvider(): LlmProvider {
    if (VALID_PROVIDERS.includes(PROVIDER)) return PROVIDER;
    return 'gemini';
}

const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';
const VALID_GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
const VALID_DEEPSEEK_MODELS = ['deepseek-chat', 'deepseek-reasoner'];

/**
 * Возвращает имя модели для запроса. Для gemini — только Gemini-модели, для deepseek — только DeepSeek.
 */
export function getModelForRequest(override?: string): string {
    const provider = getProvider();
    const envModel = (process.env.AI_MODEL || '').trim();
    const raw = override || envModel || (provider === 'deepseek' ? DEEPSEEK_DEFAULT_MODEL : GEMINI_DEFAULT_MODEL);

    if (provider === 'deepseek') {
        if (VALID_DEEPSEEK_MODELS.includes(raw)) return raw;
        if (raw && !raw.includes('gemini')) return raw; // разрешаем кастомные имена DeepSeek
        return DEEPSEEK_DEFAULT_MODEL;
    }

    if (VALID_GEMINI_MODELS.includes(raw)) return raw;
    if (raw && (raw.includes('gemini-3-pro') || raw === 'gemini-3-pro-preview')) return GEMINI_DEFAULT_MODEL;
    return GEMINI_DEFAULT_MODEL;
}

export interface GenerateCompletionOptions {
    modelName?: string;
}

export interface GenerateCompletionResult {
    text: string;
}

// Очередь запросов (общая для обоих провайдеров)
class RequestQueue {
    private queue: Array<() => Promise<void>> = [];
    private running = 0;
    private readonly maxConcurrent = 3;
    private readonly delayMs = 500;

    async add<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await fn();
                    resolve(result);
                } catch (e) {
                    reject(e);
                }
            });
            this.process();
        });
    }

    private process(): void {
        if (this.running >= this.maxConcurrent || this.queue.length === 0) return;
        this.running++;
        const task = this.queue.shift();
        if (task) {
            task()
                .finally(() => {
                    this.running--;
                    setTimeout(() => this.process(), this.delayMs);
                });
        } else {
            this.running--;
        }
    }
}

const requestQueue = new RequestQueue();

let genAI: import('@google/genai').GoogleGenAI | null = null;

function getGenAI(): import('@google/genai').GoogleGenAI {
    if (!genAI) {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error('GEMINI_API_KEY is not set. Get your key at https://aistudio.google.com/app/apikey');
        }
        const { GoogleGenAI } = require('@google/genai');
        genAI = new GoogleGenAI({ apiKey });
    }
    return genAI as import('@google/genai').GoogleGenAI;
}

function extractTextFromGeminiResponse(result: any): string {
    if (result?.text) return result.text;
    if (result?.response?.text) {
        const t = result.response.text;
        return typeof t === 'function' ? t() : String(t ?? '');
    }
    if (typeof result === 'string') return result;
    if (result?.candidates?.[0]?.content?.parts?.[0]?.text) return result.candidates[0].content.parts[0].text;
    throw new Error('AI response has unexpected structure.');
}

async function callGemini(modelName: string, systemInstruction: string, userPrompt: string): Promise<GenerateCompletionResult> {
    const fullPrompt = systemInstruction ? `${systemInstruction}\n\n${userPrompt}` : userPrompt;
    const ai = getGenAI();
    const response = await ai.models.generateContent({
        model: modelName,
        contents: fullPrompt,
    });
    const text = extractTextFromGeminiResponse(response);
    return { text };
}

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const LLM_TIMEOUT_MS = 120000;

async function callDeepSeek(modelName: string, systemInstruction: string, userPrompt: string): Promise<GenerateCompletionResult> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        throw new Error('DEEPSEEK_API_KEY is not set when AI_PROVIDER=deepseek. Get your key at https://platform.deepseek.com');
    }
    const messages: Array<{ role: string; content: string }> = [];
    if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
    messages.push({ role: 'user', content: userPrompt });

    const { data } = await axios.post(
        DEEPSEEK_API_URL,
        {
            model: modelName,
            messages,
            max_tokens: 8192,
        },
        {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            timeout: LLM_TIMEOUT_MS,
        }
    );

    const content = data?.choices?.[0]?.message?.content;
    if (content == null) {
        throw new Error('DeepSeek API returned response without choices[0].message.content');
    }
    return { text: typeof content === 'string' ? content : String(content) };
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function isRetryableError(error: any): boolean {
    const msg = String(error?.message ?? error?.response?.data?.error?.message ?? '');
    const code = error?.response?.status ?? error?.code ?? error?.statusCode;
    return (
        code === 503 ||
        code === 429 ||
        msg.includes('timed out') ||
        msg.includes('timeout') ||
        msg.includes('ECONNREFUSED') ||
        (msg.includes('RESOURCE_EXHAUSTED') && !msg.includes('QUOTA_EXCEEDED'))
    );
}

/**
 * Единая точка вызова LLM. Возвращает объект с полем text.
 * Очередь и повторные попытки выполняются внутри.
 */
export async function generateCompletion(
    systemInstruction: string,
    userPrompt: string,
    options?: GenerateCompletionOptions
): Promise<GenerateCompletionResult> {
    const provider = getProvider();
    const modelName = getModelForRequest(options?.modelName);

    const doCall = (): Promise<GenerateCompletionResult> => {
        if (provider === 'deepseek') {
            return callDeepSeek(modelName, systemInstruction, userPrompt);
        }
        return callGemini(modelName, systemInstruction, userPrompt);
    };

    let lastError: any;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await requestQueue.add(doCall);
            return result;
        } catch (error: any) {
            lastError = error;
            if (attempt < MAX_RETRIES && isRetryableError(error)) {
                const delay = RETRY_DELAY_MS * attempt;
                console.warn(`[LLM] Attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms:`, error?.message ?? error);
                await new Promise((r) => setTimeout(r, delay));
            } else {
                throw error;
            }
        }
    }
    throw lastError;
}

/**
 * Проверка при старте: при выбранном провайдере должен быть задан соответствующий ключ.
 */
export function ensureProviderKey(): void {
    const provider = getProvider();
    if (provider === 'gemini' && !process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not set. Get your key at https://aistudio.google.com/app/apikey');
    }
    if (provider === 'deepseek' && !process.env.DEEPSEEK_API_KEY) {
        throw new Error('DEEPSEEK_API_KEY is not set when AI_PROVIDER=deepseek. Get your key at https://platform.deepseek.com');
    }
}
