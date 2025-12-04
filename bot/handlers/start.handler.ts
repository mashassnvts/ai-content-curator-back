import TelegramBot from 'node-telegram-bot-api';
import { Message } from 'node-telegram-bot-api';
import axios from 'axios';
import botUserService from '../services/bot-user.service';
import { promptModeSelection } from './mode.handler';

const API_URL = process.env.API_URL || 'http://localhost:5000';

export const handleStart = async (bot: TelegramBot, msg: Message) => {
    const chatId = msg.chat.id;
    const firstName = msg.from?.first_name || 'пользователь';
    const telegramId = msg.from?.id?.toString();
    const messageText = msg.text || '';
    const payload = messageText.split(' ')[1];

    if (telegramId) {
        await botUserService.getOrCreateProfile(telegramId, msg.from?.username, chatId.toString());
    }

    let autoLinkNotice = '';

    if (payload && telegramId) {
        try {
            const { data } = await axios.post(`${API_URL}/api/bot/link`, {
                code: payload,
                telegramId,
                telegramUsername: msg.from?.username,
                telegramChatId: chatId.toString(),
            });

            if (data?.user?.id) {
                await botUserService.linkProfileToUser(telegramId, data.user.id, msg.from?.username, chatId.toString());
            }

            autoLinkNotice =
                '✅ Аккаунт успешно привязан через ссылку!\n' +
                'Теперь интересы и история будут общими с веб-приложением.';
        } catch (error: any) {
            const message = error.response?.data?.message || 'Не удалось привязать аккаунт автоматически.';
            autoLinkNotice =
                `❌ ${message}\n` +
                'Вы можете попробовать снова: получи код в профиле веб-приложения и отправь /link <код>.';
        }
    }

    const welcomeMessage = `👋 Привет, ${firstName}!

Я помогу отобрать интересный контент. 

⚡️ *Как это работает:*
1. Мы настраиваем твои интересы.
2. Ты кидаешь мне ссылки (статьи, видео).
3. Я говорю, стоит ли тратить на них время.

Для начала выбери режим работы 👇`;

    await bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
    });

    await promptModeSelection(bot, chatId);
};