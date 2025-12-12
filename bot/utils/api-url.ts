/**
 * Утилита для автоматического определения API_URL в зависимости от окружения
 */
export function getApiUrl(): string {
    // Если API_URL явно установлен, используем его
    if (process.env.API_URL) {
        return process.env.API_URL;
    }

    const PORT = parseInt(process.env.PORT || '5000', 10);

    // На Railway используем публичный домен или внутренний адрес
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
        return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    } else if (process.env.RAILWAY_ENVIRONMENT) {
        // Используем внутренний адрес Railway
        return `http://localhost:${PORT}`;
    } else {
        // Локальная разработка
        return `http://localhost:${PORT}`;
    }
}

