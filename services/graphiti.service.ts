/**
 * Graphiti — граф знаний для AI Content Curator
 * addEpisode — сохранить эпизод (статья/пост) в граф
 * searchForUser — поиск по графу для RAG-контекста
 *
 * Опционально: если GRAPHITI_URL не задан, все вызовы — no-op.
 */

const GRAPHITI_URL = process.env.GRAPHITI_URL || '';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const IS_DEBUG = LOG_LEVEL === 'debug';

function groupId(userId: number): string {
    return `user-${userId}`;
}

async function fetchGraphiti<T>(path: string, options: RequestInit): Promise<T | null> {
    if (!GRAPHITI_URL) return null;
    try {
        const res = await fetch(`${GRAPHITI_URL.replace(/\/$/, '')}${path}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Graphiti ${path}: ${res.status} ${text}`);
        }
        return (await res.json()) as T;
    } catch (e: any) {
        if (IS_DEBUG) console.warn(`⚠️ [Graphiti] ${path} failed: ${e.message}`);
        return null;
    }
}

export function isGraphitiEnabled(): boolean {
    return !!GRAPHITI_URL;
}

interface AddMessage {
    content: string;
    uuid?: string;
    name?: string;
    role_type: 'user' | 'assistant' | 'system';
    role?: string;
    timestamp?: string;
    source_description?: string;
}

/**
 * Добавить эпизод в граф (асинхронно, 202 Accepted)
 */
async function addMessages(groupId: string, messages: AddMessage[]): Promise<boolean> {
    const result = await fetchGraphiti<{ success?: boolean }>('/messages', {
        method: 'POST',
        body: JSON.stringify({ group_id: groupId, messages }),
    });
    return result?.success ?? false;
}

/**
 * Сохранить в граф факт об анализе статьи
 */
export async function retainArticle(params: {
    userId: number;
    url: string;
    summary: string;
    themes: string[];
    verdict?: string;
    sourceType?: string;
}): Promise<void> {
    if (!GRAPHITI_URL) return;

    const { userId, url, summary, themes, verdict, sourceType } = params;
    const themesStr = themes?.length ? themes.join(', ') : 'не указаны';
    const content = `Пользователь проанализировал статью: ${url}. Саммари: ${summary}. Темы/смыслы: ${themesStr}.${verdict ? ` Вердикт: ${verdict}.` : ''}${sourceType ? ` Источник: ${sourceType}.` : ''}`;

    try {
        const ok = await addMessages(groupId(userId), [
            {
                content,
                role_type: 'user',
                role: 'article_analysis',
                source_description: sourceType || 'article',
                timestamp: new Date().toISOString(),
            },
        ]);
        if (ok) {
            console.log(`📊 [Graphiti] Retained article for user ${userId} (${url.substring(0, 50)}...)`);
        }
    } catch (e: any) {
        console.warn(`⚠️ [Graphiti] retainArticle failed: ${e.message}`);
    }
}

/**
 * Сохранить в граф факт об анализе поста канала
 */
export async function retainPost(params: {
    userId: number;
    postUrl: string;
    channelUsername: string;
    summary: string;
    themes: string[];
    verdict?: string;
}): Promise<void> {
    if (!GRAPHITI_URL) return;

    const { userId, postUrl, channelUsername, summary, themes, verdict } = params;
    const themesStr = themes?.length ? themes.join(', ') : 'не указаны';
    const content = `Пост из канала @${channelUsername}: ${postUrl}. Саммари: ${summary}. Темы: ${themesStr}.${verdict ? ` Вердикт: ${verdict}.` : ''}`;

    try {
        const ok = await addMessages(groupId(userId), [
            {
                content,
                role_type: 'user',
                role: 'channel_post',
                source_description: `@${channelUsername}`,
                timestamp: new Date().toISOString(),
            },
        ]);
        if (ok) {
            console.log(`📊 [Graphiti] Retained post for user ${userId} (@${channelUsername})`);
        }
    } catch (e: any) {
        console.warn(`⚠️ [Graphiti] retainPost failed: ${e.message}`);
    }
}

interface FactResult {
    uuid: string;
    name: string;
    fact: string;
    valid_at?: string;
    invalid_at?: string;
    created_at?: string;
    expired_at?: string;
}

/**
 * Поиск по графу для RAG-контекста (рекомендации «Стоит ли читать»)
 */
export async function searchForUser(
    userId: number,
    query: string,
    options?: { maxFacts?: number }
): Promise<string> {
    if (!GRAPHITI_URL) return '';

    try {
        const result = await fetchGraphiti<{ facts?: FactResult[] }>('/search', {
            method: 'POST',
            body: JSON.stringify({
                group_ids: [groupId(userId)],
                query,
                max_facts: options?.maxFacts ?? 10,
            }),
        });
        const facts = result?.facts ?? [];
        if (facts.length > 0) {
            console.log(`📊 [Graphiti] Search for user ${userId}: ${facts.length} fact(s) found`);
        }
        return facts.map((f) => f.fact).filter(Boolean).join('\n');
    } catch (e: any) {
        if (IS_DEBUG) console.warn(`⚠️ [Graphiti] search failed: ${e.message}`);
        return '';
    }
}
