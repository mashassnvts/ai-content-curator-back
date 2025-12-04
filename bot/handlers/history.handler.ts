import TelegramBot from 'node-telegram-bot-api';
import { Message, CallbackQuery } from 'node-telegram-bot-api';
import botUserService from '../services/bot-user.service';
import { MAIN_MENU_MARKUP } from '../utils/menu';
import { formatAnalysisResult } from '../utils/formatters';

const HISTORY_PAGE_SIZE = 5;
const REANALYZE_PREFIX = 'reanalyze_';

export const handleHistoryCommand = async (bot: TelegramBot, msg: Message) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id.toString() || '';

    if (!telegramId) {
        await bot.sendMessage(chatId, '❌ Не удалось определить ваш Telegram ID.');
        return;
    }

    try {
        const history = await botUserService.getAnalysisHistory(telegramId);
        console.log(`[History] Loaded ${history.length} history items for telegramId ${telegramId}`);

        if (history.length === 0) {
            await bot.sendMessage(
                chatId,
                '📋 История анализов пуста.\n\nПроанализируйте ссылки, чтобы они появились в истории.',
                { reply_markup: MAIN_MENU_MARKUP }
            );
            return;
        }

        await sendHistoryPage(bot, chatId, history, 0);
    } catch (error: any) {
        console.error('[History] Error loading history:', error);
        await bot.sendMessage(
            chatId,
            '❌ Произошла ошибка при загрузке истории. Попробуйте позже.',
            { reply_markup: MAIN_MENU_MARKUP }
        );
    }
};

const sendHistoryPage = async (bot: TelegramBot, chatId: number, history: any[], page: number) => {
    const start = page * HISTORY_PAGE_SIZE;
    const end = start + HISTORY_PAGE_SIZE;
    const pageItems = history.slice(start, end);
    const totalPages = Math.ceil(history.length / HISTORY_PAGE_SIZE);

    if (pageItems.length === 0) {
        await bot.sendMessage(chatId, '📋 Больше записей нет.', { reply_markup: MAIN_MENU_MARKUP });
        return;
    }

    let message = `📋 *История анализов* (${history.length} записей)\n\n`;
    message += `*Страница ${page + 1} из ${totalPages}*\n\n`;

    for (const [idx, item] of pageItems.entries()) {
        const globalIdx = start + idx;
        const date = new Date(item.createdAt).toLocaleDateString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });

        message += `${globalIdx + 1}. *${item.url}*\n`;
        if (item.score !== null) {
            message += `   Оценка: ${item.score}/100 | ${item.verdict || '—'}\n`;
        }
        message += `   Интересы: ${item.interests}\n`;
        message += `   Дата: ${date}\n\n`;
    }

    const keyboard: any[] = [];

    pageItems.forEach((item, idx) => {
        const globalIdx = start + idx;
        // ID может быть строкой или числом
        const itemId = typeof item.id === 'string' ? item.id : String(item.id);
        keyboard.push([
            {
                text: `🔍 ${globalIdx + 1}. ${item.url.substring(0, 30)}${item.url.length > 30 ? '...' : ''}`,
                callback_data: `history_detail_${itemId}`,
            },
        ]);
    });

    if (totalPages > 1) {
        const navRow: any[] = [];
        if (page > 0) {
            navRow.push({ text: '◀️ Назад', callback_data: `history_page_${page - 1}` });
        }
        if (page < totalPages - 1) {
            navRow.push({ text: 'Вперёд ▶️', callback_data: `history_page_${page + 1}` });
        }
        if (navRow.length > 0) {
            keyboard.push(navRow);
        }
    }

    keyboard.push([{ text: '🔙 Главное меню', callback_data: 'history_back' }]);

    await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard },
    });
};

export const handleHistoryCallback = async (bot: TelegramBot, query: CallbackQuery) => {
    const chatId = query.message?.chat.id;
    const telegramId = query.from.id.toString();
    const data = query.data || '';

    if (!chatId) {
        await bot.answerCallbackQuery(query.id);
        return;
    }

    if (data === 'history_back') {
        await bot.answerCallbackQuery(query.id);
        try {
            await bot.editMessageText('Главное меню', {
                chat_id: chatId,
                message_id: query.message?.message_id,
            });
        } catch (error: any) {
            // Если не удалось отредактировать, отправляем новое сообщение
            await bot.sendMessage(chatId, 'Главное меню', {
                reply_markup: MAIN_MENU_MARKUP,
            });
        }
        return;
    }

    if (data.startsWith('history_page_')) {
        try {
            const page = parseInt(data.replace('history_page_', ''), 10);
            const history = await botUserService.getAnalysisHistory(telegramId);
            await bot.answerCallbackQuery(query.id);
            // Удаляем старое сообщение перед отправкой нового
            if (query.message) {
                try {
                    await bot.deleteMessage(chatId, query.message.message_id);
                } catch (error) {
                    // Игнорируем ошибки удаления (сообщение может быть уже удалено)
                }
            }
            await sendHistoryPage(bot, chatId, history, page);
        } catch (error: any) {
            console.error('[History] Error loading history page:', error);
            await bot.answerCallbackQuery(query.id, { text: 'Ошибка загрузки истории' });
        }
        return;
    }

    if (data.startsWith('history_detail_')) {
        const historyIdStr = data.replace('history_detail_', '');
        const history = await botUserService.getAnalysisHistory(telegramId);
        // ID может быть строкой (bot_123, web_456) или числом
        const item = history.find((h) => {
            const hId = typeof h.id === 'string' ? h.id : String(h.id);
            return hId === historyIdStr || String(h.id) === historyIdStr;
        });

        if (!item) {
            await bot.answerCallbackQuery(query.id, { text: 'Запись не найдена' });
            return;
        }

        const date = new Date(item.createdAt).toLocaleDateString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });

        let detailMessage = `📊 *Детали анализа*\n\n`;
        detailMessage += `🔗 *URL:* ${item.url}\n`;
        detailMessage += `📅 *Дата:* ${date}\n`;
        detailMessage += `🎯 *Интересы:* ${item.interests}\n\n`;

        if (item.score !== null) {
            detailMessage += `⭐ *Оценка:* ${item.score}/100\n`;
            detailMessage += `📝 *Вердикт:* ${item.verdict || '—'}\n\n`;
        }

        if (item.summary) {
            detailMessage += `📄 *Саммари:*\n${item.summary}\n\n`;
        }

        if (item.reasoning) {
            const reasoning = item.reasoning.length > 1000 ? item.reasoning.substring(0, 1000) + '...' : item.reasoning;
            detailMessage += `💭 *Объяснение:*\n${reasoning}`;
        }

        const keyboard = [
            [
                {
                    text: '🔄 Повторить анализ',
                    callback_data: `reanalyze_${item.id}`,
                },
            ],
            [{ text: '🔙 Назад к истории', callback_data: 'history_back_to_list' }],
        ];

        await bot.answerCallbackQuery(query.id);
        try {
            await bot.editMessageText(detailMessage, {
                chat_id: chatId,
                message_id: query.message?.message_id,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard },
            });
        } catch (error: any) {
            // Если не удалось отредактировать, отправляем новое сообщение
            await bot.sendMessage(chatId, detailMessage, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard },
            });
        }
        return;
    }

    if (data.startsWith('reanalyze_')) {
        const historyIdStr = data.replace('reanalyze_', '');
        const history = await botUserService.getAnalysisHistory(telegramId);
        // ID может быть строкой (bot_123, web_456) или числом
        const item = history.find((h) => {
            const hId = typeof h.id === 'string' ? h.id : String(h.id);
            return hId === historyIdStr || String(h.id) === historyIdStr;
        });

        if (!item) {
            await bot.answerCallbackQuery(query.id, { text: 'Запись не найдена' });
            return;
        }

        await bot.answerCallbackQuery(query.id, { text: 'Запускаю повторный анализ...' });

        const fakeMsg = {
            ...query.message,
            text: item.url,
            from: query.from,
        } as Message;

        const analyzeHandler = await import('./analyze.handler');
        await analyzeHandler.handleAnalyze(bot, fakeMsg);
        return;
    }

    if (data === 'history_back_to_list') {
        const history = await botUserService.getAnalysisHistory(telegramId);
        await bot.answerCallbackQuery(query.id);
        await sendHistoryPage(bot, chatId, history, 0);
        return;
    }

    await bot.answerCallbackQuery(query.id);
};

export { REANALYZE_PREFIX };

