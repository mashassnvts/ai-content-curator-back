import TelegramBot from 'node-telegram-bot-api';

export const MAIN_MENU_KEYBOARD = [
    [{ text: '📋 Мои интересы' }, { text: '➕ Добавить интерес' }],
    [{ text: '🗑 Удалить интерес' }, { text: '🔍 Проанализировать ссылку' }],
    [{ text: '🔗 Режим' }],
    [{ text: 'ℹ️ Помощь' }],
];

// Список текстов кнопок меню для фильтрации
export const MENU_BUTTONS = new Set([
    '📋 Мои интересы',
    '➕ Добавить интерес',
    '🗑 Удалить интерес',
    '🔍 Проанализировать ссылку',
    '🔗 Режим',
    'ℹ️ Помощь',
]);

/**
 * Проверяет, является ли текст кнопкой меню
 */
export const isMenuButton = (text: string): boolean => {
    return MENU_BUTTONS.has(text.trim());
};

/**
 * Фильтрует кнопки меню из списка интересов
 */
export const filterMenuButtons = (interests: string[]): string[] => {
    return interests.filter(interest => !isMenuButton(interest));
};

export const MAIN_MENU_MARKUP = {
    keyboard: MAIN_MENU_KEYBOARD,
    resize_keyboard: true,
    one_time_keyboard: false,
};

export const sendMainMenu = async (bot: TelegramBot, chatId: number, text: string) => {
    await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: MAIN_MENU_MARKUP,
    });
};

/**
 * Безопасное редактирование сообщения с обработкой ошибок
 */
export const safeEditMessage = async (
    bot: TelegramBot,
    chatId: number,
    messageId: number,
    text: string,
    options?: any
): Promise<boolean> => {
    try {
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            ...options,
        });
        return true;
    } catch (error: any) {
        // Игнорируем ошибки редактирования (сообщение может быть уже изменено, удалено или слишком старое)
        if (error.response?.body?.description?.includes("message can't be edited") ||
            error.message?.includes("message can't be edited") ||
            error.response?.body?.error_code === 400) {
            // Тихая ошибка - не логируем
            return false;
        }
        // Другие ошибки логируем
        console.warn(`Failed to edit message ${messageId}:`, error.message || error);
        return false;
    }
};

