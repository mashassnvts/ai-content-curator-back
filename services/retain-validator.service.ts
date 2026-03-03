/**
 * Валидатор перед сохранением в Hindsight/Graphiti.
 * Проверяет, что саммари и темы адекватны и соответствуют исходному контенту.
 * При провале — отказ от сохранения, чтобы не засорять память некорректными данными.
 */

const MIN_SUMMARY_LENGTH = 30;
const MIN_THEMES_COUNT = 1;
const MIN_CONTENT_OVERLAP_WORDS = 2; // Минимум значимых слов из summary должны быть в контенте

/** Слова, которые считаем "мусором" — слишком общие, не несут смысла */
const GENERIC_WORDS = new Set([
    'статья', 'видео', 'пост', 'контент', 'материал', 'информация',
    'текст', 'описание', 'обзор', 'рассказ', 'рассказывает', 'рассказано',
    'автор', 'рассказывает о', 'посвящен', 'посвящена', 'посвящено',
]);

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2);
}

function getSignificantWords(text: string, maxWords = 15): string[] {
    const tokens = tokenize(text);
    const significant = tokens.filter((w) => !GENERIC_WORDS.has(w));
    return [...new Set(significant)].slice(0, maxWords);
}

export interface ValidateBeforeRetainResult {
    valid: boolean;
    reason?: string;
}

/**
 * Проверяет, стоит ли сохранять результат анализа в Hindsight/Graphiti.
 * @param summary — саммари от AI
 * @param themes — извлечённые темы
 * @param extractedContent — исходный контент (опционально, для проверки соответствия)
 */
export function validateBeforeRetain(
    summary: string,
    themes: string[],
    extractedContent?: string
): ValidateBeforeRetainResult {
    const trimmedSummary = (summary || '').trim();

    if (trimmedSummary.length < MIN_SUMMARY_LENGTH) {
        return { valid: false, reason: `summary too short (${trimmedSummary.length} < ${MIN_SUMMARY_LENGTH})` };
    }

    const themesFiltered = (themes || []).filter((t) => (t || '').trim().length > 0);
    if (themesFiltered.length < MIN_THEMES_COUNT) {
        return { valid: false, reason: `no themes (need at least ${MIN_THEMES_COUNT})` };
    }

    // Проверка на слишком общий/пустой саммари
    const summaryWords = getSignificantWords(trimmedSummary);
    if (summaryWords.length < 3) {
        return { valid: false, reason: 'summary too generic (few meaningful words)' };
    }

    // Соответствие контенту: ключевые слова из summary должны встречаться в контенте
    if (extractedContent && extractedContent.length > 100) {
        const contentLower = extractedContent.toLowerCase();
        const overlap = summaryWords.filter((w) => contentLower.includes(w));
        if (overlap.length < MIN_CONTENT_OVERLAP_WORDS) {
            return {
                valid: false,
                reason: `summary does not match content (only ${overlap.length} overlapping words)`,
            };
        }
    }

    return { valid: true };
}
