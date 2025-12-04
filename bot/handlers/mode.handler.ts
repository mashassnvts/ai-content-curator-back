import TelegramBot, { Message, CallbackQuery } from 'node-telegram-bot-api';
import botUserService from '../services/bot-user.service';
import { MAIN_MENU_MARKUP } from '../utils/menu'; // <-- Импортируем меню

const MODE_CALLBACK_PREFIX = 'mode_select_';

const MODE_MESSAGES = {
    linked:
        '🔗 *Режим синхронизации*\n\n' +
        '1. В веб-приложении открой профиль и нажми «Привязать Telegram»\n' +
        '2. Получи 6-значный код\n' +
        '3. **Отправь этот код сюда** (просто текст, без команд)\n\n' +
        'Интересы и история станут общими.',
    guest:
        '🙈 *Гостевой режим*\n\n' +
        'Ты можешь использовать бота без привязки. Интересы будут храниться только здесь.',
};

export const promptModeSelection = async (bot: TelegramBot, chatId: number) => {
    await bot.sendMessage(
        chatId,
        'Выберите режим работы:\n\n🔗 Синхронизация — общие интересы с приложением.\n🙈 Гостевой — отдельные интересы только в боте.',
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🔗 Синхронизация', callback_data: `${MODE_CALLBACK_PREFIX}linked` },
                        { text: '🙈 Гостевой', callback_data: `${MODE_CALLBACK_PREFIX}guest` },
                    ],
                ],
            },
        }
    );
};

export const handleModeCommand = async (bot: TelegramBot, msg: Message) => {
    const chatId = msg.chat.id;
    await promptModeSelection(bot, chatId);
};

export const handleModeCallback = async (bot: TelegramBot, query: CallbackQuery) => {
    const chatId = query.message?.chat.id;
    const telegramId = query.from?.id?.toString();
    const data = query.data || '';

    if (!chatId || !telegramId) {
        await bot.answerCallbackQuery(query.id);
        return;
    }

    const mode = data.replace(MODE_CALLBACK_PREFIX, '');

    if (mode === 'linked') {
        await bot.answerCallbackQuery(query.id, { text: 'Следуйте инструкции.' });
        
        const profile = await botUserService.getOrCreateProfile(telegramId);
        if (profile.mode === 'linked' && profile.user_id) {
            await bot.sendMessage(chatId, '✅ Вы уже привязаны к аккаунту!', {
                parse_mode: 'Markdown',
                reply_markup: MAIN_MENU_MARKUP,
            });
            return;
        }
        
        await bot.sendMessage(chatId, MODE_MESSAGES.linked + '\n\n💡 *Совет:* Если вы передумали, просто отправьте ссылку или используйте команду /mode для выбора другого режима.', { 
            parse_mode: 'Markdown',
            reply_markup: { remove_keyboard: true } 
        });
        return;
    }

    if (mode === 'guest') {
        await botUserService.setMode(telegramId, 'guest');
        await bot.answerCallbackQuery(query.id, { text: 'Гостевой режим активирован.' });
        
        // ИЗМЕНЕНИЕ: Включаем меню только сейчас, когда режим выбран
        await bot.sendMessage(chatId, MODE_MESSAGES.guest + '\n\n👇 **Используйте меню внизу:**', { 
            parse_mode: 'Markdown',
            reply_markup: MAIN_MENU_MARKUP 
        });
        return;
    }

    await bot.answerCallbackQuery(query.id);
};

export { MODE_CALLBACK_PREFIX };