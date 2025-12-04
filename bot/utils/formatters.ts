import { AnalysisResult } from '../../services/ai.service';

export interface BotAnalysisResult {
    originalUrl: string;
    score?: number;
    verdict?: string;
    summary?: string;
    reasoning?: string;
    error?: boolean;
    message?: string;
    analysisHistoryId?: number;
}

/**
 * Экранирует специальные символы Markdown для Telegram
 */
const escapeMarkdown = (text: string): string => {
    if (!text) return '';
    // Экранируем специальные символы Markdown V2
    return text
        .replace(/\*/g, '\\*')
        .replace(/_/g, '\\_')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/~/g, '\\~')
        .replace(/`/g, '\\`')
        .replace(/>/g, '\\>')
        .replace(/#/g, '\\#')
        .replace(/\+/g, '\\+')
        .replace(/-/g, '\\-')
        .replace(/=/g, '\\=')
        .replace(/\|/g, '\\|')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\./g, '\\.')
        .replace(/!/g, '\\!');
};

export const formatAnalysisResult = (result: BotAnalysisResult): string => {
    if (result.error) {
        return `❌ *Ошибка анализа*\n\n${escapeMarkdown(result.message || 'Не удалось проанализировать контент.')}`;
    }

    const verdictEmoji = result.verdict === 'Полезно' ? '✅' : result.verdict === 'Нейтрально' ? '⚪' : '❌';
    const scoreBar = getScoreBar(result.score || 0);
    
    let message = `📊 *Результаты анализа*\n\n`;
    message += `🔗 URL: ${escapeMarkdown(result.originalUrl)}\n\n`;
    message += `${verdictEmoji} *Вердикт:* ${escapeMarkdown(result.verdict || 'Не определен')}\n`;
    message += `⭐ *Оценка:* ${result.score || 0}/100\n`;
    message += `${scoreBar}\n\n`;
    
    if (result.summary) {
        message += `📝 *Саммари:*\n${escapeMarkdown(result.summary)}\n\n`;
    }
    
    if (result.reasoning) {
        const reasoning = result.reasoning.length > 1000 
            ? result.reasoning.substring(0, 1000) + '...' 
            : result.reasoning;
        message += `💭 *Объяснение:*\n${escapeMarkdown(reasoning)}`;
    }

    return message;
};

const getScoreBar = (score: number): string => {
    const filled = Math.round(score / 10);
    const empty = 10 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty) + ` ${score}%`;
};

export const formatInterestsList = (interests: string[]): string => {
    if (interests.length === 0) {
        return 'Нет добавленных интересов';
    }
    return interests.map((interest, idx) => `${idx + 1}. ${interest}`).join('\n');
};

/**
 * Форматирует результат анализа без Markdown (для fallback)
 */
export const formatAnalysisResultPlain = (result: BotAnalysisResult): string => {
    if (result.error) {
        return `❌ Ошибка анализа\n\n${result.message || 'Не удалось проанализировать контент.'}`;
    }

    const verdictEmoji = result.verdict === 'Полезно' ? '✅' : result.verdict === 'Нейтрально' ? '⚪' : '❌';
    const scoreBar = getScoreBar(result.score || 0);
    
    let message = `📊 Результаты анализа\n\n`;
    message += `🔗 URL: ${result.originalUrl}\n\n`;
    message += `${verdictEmoji} Вердикт: ${result.verdict || 'Не определен'}\n`;
    message += `⭐ Оценка: ${result.score || 0}/100\n`;
    message += `${scoreBar}\n\n`;
    
    if (result.summary) {
        message += `📝 Саммари:\n${result.summary}\n\n`;
    }
    
    if (result.reasoning) {
        const reasoning = result.reasoning.length > 1000 
            ? result.reasoning.substring(0, 1000) + '...' 
            : result.reasoning;
        message += `💭 Объяснение:\n${reasoning}`;
    }

    return message;
};

