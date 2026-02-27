/**
 * Hindsight — память агента для AI Content Curator
 * retain() — сохранить факты о статьях/постах
 * recall() — поиск по памяти
 * reflect() — рассуждения для рекомендаций
 *
 * Опционально: если HINDSIGHT_URL не задан, все вызовы — no-op.
 */

import { HindsightClient } from '@vectorize-io/hindsight-client';

const HINDSIGHT_URL = process.env.HINDSIGHT_URL || '';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const IS_DEBUG = LOG_LEVEL === 'debug';

let client: HindsightClient | null = null;

function getClient(): HindsightClient | null {
    if (!HINDSIGHT_URL) return null;
    if (!client) {
        try {
            client = new HindsightClient({ baseUrl: HINDSIGHT_URL });
            if (IS_DEBUG) console.log('✅ [Hindsight] Client initialized');
        } catch (e: any) {
            console.warn(`⚠️ [Hindsight] Failed to init client: ${e.message}`);
            return null;
        }
    }
    return client;
}

export function isHindsightEnabled(): boolean {
    return !!HINDSIGHT_URL;
}

/**
 * Bank ID для пользователя — изоляция памяти по пользователям
 */
function bankId(userId: number): string {
    return `user-${userId}`;
}

/**
 * Сохранить в память факт об анализе статьи
 */
export async function retainArticle(params: {
    userId: number;
    url: string;
    summary: string;
    themes: string[];
    verdict?: string;
    sourceType?: string;
}): Promise<void> {
    const c = getClient();
    if (!c) return;

    const { userId, url, summary, themes, verdict, sourceType } = params;
    const themesStr = themes?.length ? themes.join(', ') : 'не указаны';
    const content = `Пользователь проанализировал статью: ${url}. Саммари: ${summary}. Темы/смыслы: ${themesStr}.${verdict ? ` Вердикт: ${verdict}.` : ''}${sourceType ? ` Источник: ${sourceType}.` : ''}`;

    try {
        await c.retain(bankId(userId), content, {
            context: 'article_analysis',
            metadata: { url, sourceType: sourceType || 'article' },
        });
        console.log(`📝 [Hindsight] Retained article for user ${userId} (${url.substring(0, 50)}...)`);
    } catch (e: any) {
        console.warn(`⚠️ [Hindsight] retainArticle failed: ${e.message}`);
    }
}

/**
 * Сохранить в память факт об анализе поста канала
 */
export async function retainPost(params: {
    userId: number;
    postUrl: string;
    channelUsername: string;
    summary: string;
    themes: string[];
    verdict?: string;
}): Promise<void> {
    const c = getClient();
    if (!c) return;

    const { userId, postUrl, channelUsername, summary, themes, verdict } = params;
    const themesStr = themes?.length ? themes.join(', ') : 'не указаны';
    const content = `Пост из канала @${channelUsername}: ${postUrl}. Саммари: ${summary}. Темы: ${themesStr}.${verdict ? ` Вердикт: ${verdict}.` : ''}`;

    try {
        await c.retain(bankId(userId), content, {
            context: 'channel_post',
            metadata: { postUrl, channel: channelUsername },
        });
        console.log(`📝 [Hindsight] Retained post for user ${userId} (@${channelUsername})`);
    } catch (e: any) {
        console.warn(`⚠️ [Hindsight] retainPost failed: ${e.message}`);
    }
}

/**
 * Поиск по памяти пользователя (для RAG-контекста)
 */
export async function recallForUser(
    userId: number,
    query: string,
    options?: { maxTokens?: number }
): Promise<string> {
    const c = getClient();
    if (!c) return '';

    try {
        const result = await c.recall(bankId(userId), query, {
            maxTokens: options?.maxTokens ?? 1024,
        });
        const results = (result as { results?: Array<{ text?: string }> })?.results ?? [];
        const content = results.map((r) => r.text || '').filter(Boolean).join('\n');
        if (content.length > 0) {
            console.log(`📝 [Hindsight] Recall for user ${userId}: ${results.length} memory(s) found`);
        }
        return content;
    } catch (e: any) {
        if (IS_DEBUG) console.warn(`⚠️ [Hindsight] recall failed: ${e.message}`);
        return '';
    }
}

/**
 * Reflect — рассуждение на основе памяти (для улучшения рекомендаций)
 */
export async function reflectForUser(userId: number, query: string): Promise<string> {
    const c = getClient();
    if (!c) return '';

    try {
        const result = await c.reflect(bankId(userId), query, {
            budget: 'low',
        });
        const text = (result as { text?: string })?.text ?? '';
        return typeof text === 'string' ? text : '';
    } catch (e: any) {
        if (IS_DEBUG) console.warn(`⚠️ [Hindsight] reflect failed: ${e.message}`);
        return '';
    }
}
