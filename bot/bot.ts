import TelegramBot, { Message } from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import axios from 'axios';
import { handleStart } from './handlers/start.handler';
import { handleAnalyze } from './handlers/analyze.handler';
import { handleInterests, showInterests, handleAddInterestInput, promptRemoveInterest, handleRemoveInterestCallback, handleToggleInterestCallback, handleSetInterestLevelCallback, handleChangeInterestLevel, REMOVE_INTEREST_PREFIX, TOGGLE_INTEREST_PREFIX, SET_LEVEL_PREFIX, CHANGE_LEVEL_PREFIX } from './handlers/interests.handler';
import { handleFeedback } from './handlers/feedback.handler';
import { handleLinkCommand, handleLinkCodeMessage } from './handlers/link.handler';
import { handleModeCommand, handleModeCallback, MODE_CALLBACK_PREFIX } from './handlers/mode.handler';
import { handleHistoryCommand, handleHistoryCallback } from './handlers/history.handler';
import { MAIN_MENU_MARKUP } from './utils/menu';
import { getPendingAction, setPendingAction, clearPendingAction } from './utils/sessionStore';

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_URL = process.env.API_URL || 'http://localhost:5000';
const HELP_TEXT =
    'ℹ️ *Как пользоваться ботом*\n\n' +
    '📋 *Управление интересами:*\n' +
    '• \"📋 Мои интересы\" — просмотр и управление интересами\n' +
    '• Нажмите на интерес (✅/○) — включить/выключить\n' +
    '• Нажмите \"📊\" — изменить уровень (🟢 Новичок / 🟡 Любитель / 🔴 Профессионал)\n' +
    '• \"➕ Добавить интерес\" — добавьте темы через запятую\n' +
    '• \"🗑 Удалить интерес\" — удаление интересов\n\n' +
    '🔍 *Анализ контента:*\n' +
    '• \"🔍 Проанализировать ссылку\" — отправьте URL после нажатия кнопки\n' +
    '• Или просто отправьте ссылку — бот автоматически проанализирует\n\n' +
    '⚙️ *Настройки:*\n' +
    '• \"🔗 Режим\" — переключение между гостевым и синхронным режимом\n' +
    '• Синхронный режим — данные синхронизируются с веб-приложением';

if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set in environment variables. Please set it in .env file.');
}

const checkServerAvailability = async () => {
    try {
        await axios.get(`${API_URL}/`, { timeout: 3000 });
        console.log(`✅ Server is available at ${API_URL}`);
    } catch (error: any) {
        if (error.code === 'ECONNREFUSED') {
            console.warn(`⚠️ WARNING: Server is not available at ${API_URL}`);
            console.warn('⚠️ Make sure the server is running: npm run dev');
            console.warn('⚠️ Bot will still start, but analysis requests will fail.');
        } else {
            console.log(`ℹ️ Server check: ${error.message}`);
        }
    }
};

export const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { 
    polling: {
        interval: 300,
        params: {
            timeout: 10
        }
    }
});

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 5000; // 5 секунд

const scheduleReconnect = () => {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('❌ Max reconnection attempts reached. Please restart the bot manually.');
        return;
    }
    
    reconnectAttempts++;
    const delay = Math.min(RECONNECT_DELAY * reconnectAttempts, 60000); // Максимум 60 секунд
    
    console.log(`🔄 Attempting to reconnect in ${delay / 1000} seconds... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    
    setTimeout(() => {
        try {
            // Останавливаем текущий polling
            bot.stopPolling().then(() => {
                console.log('🔄 Restarting polling...');
                // Polling перезапустится автоматически, так как он настроен в конструкторе
                reconnectAttempts = 0; // Сбрасываем счетчик при успешном переподключении
            }).catch((err: any) => {
                console.error('❌ Error stopping polling:', err.message);
                scheduleReconnect();
            });
        } catch (error: any) {
            console.error('❌ Error during reconnection:', error.message);
            scheduleReconnect();
        }
    }, delay);
};

bot.on('polling_error', (error: any) => {
    const errorCode = error.code || error.response?.statusCode;
    const errorMessage = error.message || error.toString();
    
    console.error('❌ Telegram Bot polling error:', errorMessage);
    
    // Проверяем, является ли это ошибкой соединения, которую нужно обработать
    if (errorCode === 'EFATAL' || errorCode === 'ECONNRESET' || errorCode === 'ETIMEDOUT' || 
        errorMessage.includes('ECONNRESET') || errorMessage.includes('ETIMEDOUT')) {
        console.warn('⚠️ Connection error detected. Will attempt to reconnect...');
        scheduleReconnect();
    } else {
        // Для других ошибок просто логируем, но не переподключаемся
        console.warn('⚠️ Non-critical polling error. Bot will continue running.');
    }
});

bot.on('error', (error: any) => {
    const errorCode = error.code || error.response?.statusCode;
    const errorMessage = error.message || error.toString();
    
    console.error('❌ Telegram Bot error:', errorMessage);
    
    // Для критических ошибок пытаемся переподключиться
    if (errorCode === 'EFATAL' || errorCode === 'ECONNRESET' || 
        errorMessage.includes('ECONNRESET') || errorMessage.includes('EFATAL')) {
        console.warn('⚠️ Critical error detected. Will attempt to reconnect...');
        scheduleReconnect();
    }
});

bot.onText(/\/start/, async (msg) => {
    await handleStart(bot, msg);
});

bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id, HELP_TEXT, {
        parse_mode: 'Markdown',
        reply_markup: MAIN_MENU_MARKUP,
    });
});

bot.onText(/\/analyze/, async (msg) => {
    await handleAnalyze(bot, msg);
});

bot.onText(/\/interests/, async (msg) => {
    await handleInterests(bot, msg);
});

bot.onText(/\/add_interest/, async (msg) => {
    await handleInterests(bot, msg);
});

bot.onText(/\/remove_interest/, async (msg) => {
    await handleInterests(bot, msg);
});

bot.onText(/\/link/, async (msg) => {
    await handleLinkCommand(bot, msg);
});

bot.onText(/\/mode/, async (msg) => {
    await handleModeCommand(bot, msg);
});

bot.onText(/\/history/, async (msg) => {
    await handleHistoryCommand(bot, msg);
});

const URL_REGEX = /(https?:\/\/[^\s]+)/i;

bot.on('message', async (msg) => {
    const text = msg.text?.trim();
    if (!text) {
        return;
    }

    if (text.startsWith('/')) {
        return;
    }

    const handledByCode = await handleLinkCodeMessage(bot, msg, text);
    if (handledByCode) {
        return;
    }

    const telegramId = msg.from?.id?.toString();
    if (!telegramId) {
        return;
    }

    const chatId = msg.chat.id;

    const pending = getPendingAction(telegramId);

    if (pending?.type === 'add_interest') {
        clearPendingAction(telegramId);
        await handleAddInterestInput(bot, chatId, telegramId, text);
        return;
    }

    if (pending?.type === 'analyze_url') {
        if (URL_REGEX.test(text)) {
            clearPendingAction(telegramId);
            const fakeMsg = { ...msg, text } as Message;
            await handleAnalyze(bot, fakeMsg);
        } else {
            await bot.sendMessage(chatId, '❌ Пожалуйста, отправьте корректную ссылку (начинается с http/https).', {
                reply_markup: MAIN_MENU_MARKUP,
            });
        }
        return;
    }

    switch (text) {
        case '📋 Мои интересы':
            await showInterests(bot, chatId, telegramId);
            return;
        case '➕ Добавить интерес':
            setPendingAction(telegramId, { type: 'add_interest' });
            await bot.sendMessage(chatId, '✍️ Отправьте интересы (можно несколько через запятую).', {
                reply_markup: MAIN_MENU_MARKUP,
            });
            return;
        case '🗑 Удалить интерес':
            await promptRemoveInterest(bot, chatId, telegramId);
            return;
        case '🔍 Проанализировать ссылку':
            setPendingAction(telegramId, { type: 'analyze_url' });
            await bot.sendMessage(chatId, '🔗 Отправьте ссылку на видео или статью, и я её проанализирую.', {
                reply_markup: MAIN_MENU_MARKUP,
            });
            return;
        case '🔗 Режим':
            await handleModeCommand(bot, msg);
            return;
        case 'ℹ️ Помощь':
            await bot.sendMessage(chatId, HELP_TEXT, { parse_mode: 'Markdown', reply_markup: MAIN_MENU_MARKUP });
            return;
        default:
            break;
    }

    if (URL_REGEX.test(text)) {
        await handleAnalyze(bot, msg);
    }
});

bot.on('callback_query', async (query) => {
    if (query.data?.startsWith(MODE_CALLBACK_PREFIX)) {
        await handleModeCallback(bot, query);
        return;
    }
    if (query.data?.startsWith('feedback_')) {
        await handleFeedback(bot, query);
        return;
    }
    if (query.data?.startsWith(REMOVE_INTEREST_PREFIX)) {
        const idx = parseInt(query.data.replace(REMOVE_INTEREST_PREFIX, ''), 10);
        await handleRemoveInterestCallback(bot, query, idx);
        return;
    }
    if (query.data?.startsWith(TOGGLE_INTEREST_PREFIX)) {
        const idx = parseInt(query.data.replace(TOGGLE_INTEREST_PREFIX, ''), 10);
        await handleToggleInterestCallback(bot, query, idx);
        return;
    }
    
    if (query.data?.startsWith(CHANGE_LEVEL_PREFIX)) {
        const idx = parseInt(query.data.replace(CHANGE_LEVEL_PREFIX, ''), 10);
        await handleChangeInterestLevel(bot, query, idx);
        return;
    }
    if (query.data?.startsWith(SET_LEVEL_PREFIX)) {
        const data = query.data.replace(SET_LEVEL_PREFIX, '');
        const [interest, level, action] = data.split('|');
        const isChange = action === 'change';
        await handleSetInterestLevelCallback(bot, query, interest, level, isChange);
        return;
    }
    if (query.data === 'show_remove_interests') {
        const telegramId = query.from.id.toString();
        const chatId = query.message?.chat.id;
        if (chatId) {
            await promptRemoveInterest(bot, chatId, telegramId);
            await bot.answerCallbackQuery(query.id);
        }
        return;
    }
    if (query.data?.startsWith('history_') || query.data?.startsWith('reanalyze_')) {
        await handleHistoryCallback(bot, query);
        return;
    }
    await bot.answerCallbackQuery(query.id);
});

checkServerAvailability().then(() => {
    console.log('🤖 Telegram bot is running and ready to receive messages!');
}).catch((error) => {
    console.error('Error checking server availability:', error);
    console.log('🤖 Telegram bot is running, but server check failed.');
});

