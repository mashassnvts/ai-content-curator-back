import TelegramBot, { Message } from 'node-telegram-bot-api';
import axios from 'axios';
import { MAIN_MENU_MARKUP } from '../utils/menu'; // Импортируем меню

const API_URL = process.env.API_URL || 'http://localhost:5000';
const LINK_CODE_REGEX = /^[A-F0-9]{6}$/i;

interface LinkPayload {
    code: string;
    telegramId: string;
    telegramUsername?: string;
    chatId: string;
}

const linkProfile = async (bot: TelegramBot, { code, telegramId, telegramUsername, chatId }: LinkPayload) => {
    const numericChatId = Number(chatId);
    const statusMessage = await bot.sendMessage(numericChatId, '⏳ Проверяю код и связываю аккаунт...', {
        reply_markup: { remove_keyboard: true },
    });

    const typingInterval = setInterval(() => {
        bot.sendChatAction(numericChatId, 'typing');
    }, 4000);

    try {
        await axios.post(`${API_URL}/api/bot/link`, {
            code,
            telegramId,
            telegramUsername,
            telegramChatId: chatId,
        });

        try {
            await bot.editMessageText(
                '✅ **Аккаунт успешно привязан!**\n\n' +
                    'Теперь бот знает ваши интересы из веб-приложения.\n\n' +
                    '👇 **Что делать дальше?**\n' +
                    '1. Нажми «📋 Мои интересы», чтобы проверить синхронизацию.\n' +
                    '2. Или просто отправь мне ссылку на статью/видео для анализа.',
                {
                    chat_id: numericChatId,
                    message_id: statusMessage.message_id,
                    parse_mode: 'Markdown',
                }
            );
        } catch (error: any) {
            // Если не удалось отредактировать, отправляем новое сообщение
            await bot.sendMessage(
                numericChatId,
                '✅ **Аккаунт успешно привязан!**\n\n' +
                    'Теперь бот знает ваши интересы из веб-приложения.\n\n' +
                    '👇 **Что делать дальше?**\n' +
                    '1. Нажми «📋 Мои интересы», чтобы проверить синхронизацию.\n' +
                    '2. Или просто отправь мне ссылку на статью/видео для анализа.',
                {
                    parse_mode: 'Markdown',
                    reply_markup: MAIN_MENU_MARKUP,
                }
            );
        }

        await bot.sendMessage(
            numericChatId,
            'Меню ниже поможет продолжить работу.',
            { reply_markup: MAIN_MENU_MARKUP }
        );
    } catch (error: any) {
        const message =
            error.response?.data?.message || 'Не удалось привязать аккаунт. Проверьте код и попробуйте снова.';

        try {
            await bot.editMessageText(`❌ Ошибка привязки: ${message}`, {
                chat_id: numericChatId,
                message_id: statusMessage.message_id,
            });
        } catch (error: any) {
            // Если не удалось отредактировать, отправляем новое сообщение
            await bot.sendMessage(numericChatId, `❌ Ошибка привязки: ${message}`, {
                reply_markup: MAIN_MENU_MARKUP,
            });
        }
    } finally {
        clearInterval(typingInterval);
    }
};

export const handleLinkCommand = async (bot: TelegramBot, msg: Message) => {
    // Оставляем для совместимости, но пользователю об этом знать не обязательно
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id?.toString();
    const telegramUsername = msg.from?.username || undefined;
    const messageText = msg.text || '';

    if (!telegramId) {
        await bot.sendMessage(chatId, '❌ Не удалось определить ваш Telegram ID.');
        return;
    }

    const code = messageText.replace('/link', '').trim().toUpperCase();

    if (!code) {
        await bot.sendMessage(chatId, 'ℹ️ Просто отправьте 6-значный код из приложения в чат.');
        return;
    }

    await linkProfile(bot, {
        code,
        telegramId,
        telegramUsername,
        chatId: chatId.toString(),
    });
};

export const handleLinkCodeMessage = async (bot: TelegramBot, msg: Message, text: string) => {
    const normalized = text.trim();

    // Проверяем, похоже ли это на код
    if (!LINK_CODE_REGEX.test(normalized)) {
        return false;
    }

    const chatId = msg.chat.id;
    const telegramId = msg.from?.id?.toString();
    const telegramUsername = msg.from?.username || undefined;

    if (!telegramId) {
        await bot.sendMessage(chatId, '❌ Не удалось определить ваш Telegram ID.');
        return true;
    }

    await linkProfile(bot, {
        code: normalized.toUpperCase(),
        telegramId,
        telegramUsername,
        chatId: chatId.toString(),
    });

    return true;
};