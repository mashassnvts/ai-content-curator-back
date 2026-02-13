/**
 * Экранирует управляющие символы (\n, \r, \t и т.д.) внутри JSON-строк до парсинга.
 * AI часто возвращает неэкранированные переносы строк в summary/reasoning/explanation.
 */
export function escapeControlCharsInJsonStrings(jsonStr: string): string {
    let result = '';
    let inString = false;
    let escapeNext = false;
    for (let i = 0; i < jsonStr.length; i++) {
        const char = jsonStr[i];
        const code = char.charCodeAt(0);
        if (escapeNext) {
            result += char;
            escapeNext = false;
            continue;
        }
        if (char === '\\') {
            escapeNext = true;
            result += char;
            continue;
        }
        if (char === '"') {
            let backslashes = 0;
            for (let j = i - 1; j >= 0 && jsonStr[j] === '\\'; j--) backslashes++;
            if (backslashes % 2 === 0) inString = !inString;
            result += char;
            continue;
        }
        if (inString && code >= 0x00 && code <= 0x1F) {
            if (code === 0x0A) result += '\\n';
            else if (code === 0x0D) result += '\\r';
            else if (code === 0x09) result += '\\t';
            else if (code === 0x08) result += '\\b';
            else if (code === 0x0C) result += '\\f';
            else result += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
            result += char;
        }
    }
    return result;
}
