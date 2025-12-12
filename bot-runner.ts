// Точка входа для запуска Telegram бота
import './bot/bot';
import { getApiUrl } from './bot/utils/api-url';

const API_URL = getApiUrl();
const PORT = parseInt(process.env.PORT || '5000', 10);

console.log('🚀 Starting Telegram bot...');
console.log(`📝 API URL: ${API_URL}`);
console.log(`📝 Server PORT: ${PORT}`);

