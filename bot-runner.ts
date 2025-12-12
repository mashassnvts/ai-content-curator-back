// Точка входа для запуска Telegram бота
import './bot/bot';

const API_URL = process.env.API_URL || 'http://localhost:5000';
const PORT = parseInt(process.env.PORT || '5000', 10);

console.log('🚀 Starting Telegram bot...');
console.log(`📝 API URL: ${API_URL}`);
console.log(`📝 Server PORT: ${PORT}`);

// Если API_URL указывает на localhost и мы на Railway, используем внутренний порт
if (API_URL.includes('localhost') && process.env.RAILWAY_ENVIRONMENT) {
    console.log('⚠️ Detected Railway environment. Make sure API_URL is set correctly.');
}

