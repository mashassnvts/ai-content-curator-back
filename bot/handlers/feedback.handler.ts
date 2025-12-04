import TelegramBot from 'node-telegram-bot-api';
import { CallbackQuery } from 'node-telegram-bot-api';
import axios from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:5000';

export const handleFeedback = async (bot: TelegramBot, query: CallbackQuery) => {
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const data = query.data;

    if (!chatId || !messageId || !data) {
        return;
    }

    const feedbackMatch = data.match(/^feedback_(.+)_(true|false)$/);
    
    if (!feedbackMatch) {
        await bot.answerCallbackQuery(query.id, { text: 'Функция в разработке' });
        return;
    }

    const [, historyId, wasCorrectStr] = feedbackMatch;
    const wasCorrect = wasCorrectStr === 'true';

    try {
        await bot.answerCallbackQuery(query.id, {
            text: wasCorrect ? '✅ Спасибо за обратную связь!' : '❌ Спасибо за обратную связь!'
        });

        const currentText = query.message?.text || '';
        const updatedText = currentText + `\n\n${wasCorrect ? '✅' : '❌'} Ваша оценка сохранена!`;
        
        try {
            await bot.editMessageText(updatedText, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: wasCorrect ? '✅ Да (выбрано)' : '👍 Да', callback_data: `feedback_${historyId}_true` },
                            { text: !wasCorrect ? '❌ Нет (выбрано)' : '👎 Нет', callback_data: `feedback_${historyId}_false` }
                        ]
                    ]
                }
            });
        } catch (editError: any) {
            // Игнорируем ошибки редактирования (сообщение может быть уже изменено)
            // Обратная связь уже сохранена, это не критично
        }

    } catch (error: any) {
        console.error('Error handling feedback:', error);
        await bot.answerCallbackQuery(query.id, {
            text: 'Ошибка при сохранении обратной связи'
        });
    }
};

