import TelegramBot from 'node-telegram-bot-api';
import { Message } from 'node-telegram-bot-api';
import axios from 'axios';
import { formatAnalysisResult, formatAnalysisResultPlain } from '../utils/formatters';
import botUserService from '../services/bot-user.service';
import { MAIN_MENU_MARKUP } from '../utils/menu';

import { getApiUrl } from '../utils/api-url';
const API_URL = getApiUrl();
const GUEST_NOTE =
    'ℹ️ Вы используете гостевой режим. Чтобы синхронизировать интересы с веб-приложением, используйте /mode или /link.';
const URL_REGEX_GLOBAL = /(https?:\/\/[^\s]+)/gi;

const STATUS_MESSAGES = [
    '🔍 Загружаю контент...',
    '📝 Анализирую текст...',
    '🧠 Обрабатываю информацию...',
    '🎯 Проверяю релевантность...',
    '⭐ Оцениваю качество...',
    '📊 Формирую выводы...',
    '⏳ Почти готово...',
    '✨ Завершаю анализ...',
    '🔎 Изучаю контент...',
    '📈 Сравниваю с интересами...',
    '💡 Генерирую оценку...',
];

const updateStatusMessage = async (
    bot: TelegramBot,
    chatId: number,
    messageId: number,
    currentIndex: number,
    totalUrls: number,
    processedCount: number
): Promise<void> => {
    const messageIndex = currentIndex % STATUS_MESSAGES.length;
    const statusText = STATUS_MESSAGES[messageIndex];
    const progress = totalUrls > 1 ? `\n\n📊 Обработано: ${processedCount} из ${totalUrls}` : '';
    
    try {
        await bot.editMessageText(
            `${statusText}${progress}`,
            {
                chat_id: chatId,
                message_id: messageId,
            }
        );
    } catch (error: any) {
        // Игнорируем ошибки редактирования (сообщение может быть уже изменено, удалено или слишком старое)
        if (error.response?.body?.description?.includes("message can't be edited") ||
            error.message?.includes("message can't be edited") ||
            error.response?.body?.error_code === 400) {
            // Тихая ошибка - не логируем
            return;
        }
        // Другие ошибки логируем только в режиме отладки
    }
};

export const handleAnalyze = async (bot: TelegramBot, msg: Message) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id.toString() || '';
    const messageText = msg.text || '';

    if (!telegramId) {
        await bot.sendMessage(chatId, '❌ Не удалось определить ваш Telegram ID.');
        return;
    }

    const urls = Array.from(
        new Set((messageText.match(URL_REGEX_GLOBAL) || []).map((u) => u.trim()))
    );

    if (!urls.length) {
        await bot.sendMessage(
            chatId,
            '❌ Не нашёл ссылок. Отправьте одну или несколько ссылок (каждая с новой строки).'
        );
        return;
    }

    const { interests: userInterests, activeInterests, mode, linkedUserId } = await botUserService.getUserInterests(telegramId);

    const interestsToUse = activeInterests.length > 0 ? activeInterests : userInterests;

    if (interestsToUse.length === 0) {
        await bot.sendMessage(
            chatId,
            '❌ У вас пока нет активных интересов.\n\n' +
                'Отправьте /interests и включите хотя бы один интерес перед анализом.'
        );
        return;
    }

    const interestsString = interestsToUse.join(', ');

    const statusMessage = await bot.sendMessage(
        chatId,
        urls.length === 1
            ? '🔍 Анализирую ссылку... это может занять пару минут.'
            : `🔍 Анализирую ${urls.length} ссылок... это займёт немного времени.`,
        {
            reply_to_message_id: msg.message_id,
        }
    );

    let statusUpdateInterval: NodeJS.Timeout | null = null;
    let statusMessageIndex = 0;
    let processedCount = 0;

    // Запускаем обновление статуса каждые 3 секунды
    if (urls.length > 1) {
        statusUpdateInterval = setInterval(async () => {
            statusMessageIndex++;
            await updateStatusMessage(bot, chatId, statusMessage.message_id, statusMessageIndex, urls.length, processedCount);
        }, 3000);
    }

    try {
        // Обрабатываем каждую ссылку отдельно для показа результатов по мере готовности
        const allResults: any[] = [];
        
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            
            try {
                // Обновляем статус перед обработкой каждой ссылки
                if (urls.length > 1) {
                    statusMessageIndex++;
                    await updateStatusMessage(bot, chatId, statusMessage.message_id, statusMessageIndex, urls.length, processedCount);
                }

                const response = await axios.post(`${API_URL}/api/analysis/guest-analyze`, {
                    urls: url,
                    interests: interestsString,
                });

                const result = Array.isArray(response.data) ? response.data[0] : response.data;
                
                if (result) {
                    allResults.push(result);
                    processedCount++;

                    // Показываем результат сразу, как только он готов
                    if (!result.error) {
                        await botUserService.saveAnalysisHistory(
                            telegramId,
                            result.originalUrl,
                            interestsString,
                            {
                                sourceType: result.sourceType,
                                score: result.score,
                                verdict: result.verdict,
                                summary: result.summary,
                                reasoning: result.reasoning,
                            },
                            linkedUserId || null
                        );
                    }

                    const formattedMessage = formatAnalysisResult(result);
                    try {
                        await bot.sendMessage(chatId, formattedMessage, {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: '👍 Да', callback_data: `feedback_${result.analysisHistoryId || 'none'}_true` },
                                        { text: '👎 Нет', callback_data: `feedback_${result.analysisHistoryId || 'none'}_false` },
                                    ],
                                ],
                            },
                        });
                    } catch (markdownError: any) {
                        // Если Markdown не работает, отправляем без форматирования
                        console.warn('Markdown parsing error, sending plain text:', markdownError.message);
                        const plainMessage = formatAnalysisResultPlain(result);
                        await bot.sendMessage(chatId, plainMessage, {
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: '👍 Да', callback_data: `feedback_${result.analysisHistoryId || 'none'}_true` },
                                        { text: '👎 Нет', callback_data: `feedback_${result.analysisHistoryId || 'none'}_false` },
                                    ],
                                ],
                            },
                        });
                    }
                }
            } catch (error: any) {
                console.error(`Error analyzing URL ${url}:`, error);
                
                // Добавляем результат с ошибкой
                const errorResult = {
                    originalUrl: url,
                    error: true,
                    message: error.response?.data?.message || error.message || 'Не удалось обработать эту ссылку'
                };
                allResults.push(errorResult);
                processedCount++;

                await bot.sendMessage(chatId, `❌ Ошибка при анализе ${url}:\n${errorResult.message}`, {
                    parse_mode: 'Markdown',
                });
            }
        }

        // Останавливаем обновление статуса
        if (statusUpdateInterval) {
            clearInterval(statusUpdateInterval);
        }

        if (allResults.length === 0) {
            try {
                await bot.editMessageText('❌ Не удалось получить результаты анализа.', {
                    chat_id: chatId,
                    message_id: statusMessage.message_id
                });
            } catch (error: any) {
                // Если не удалось отредактировать, отправляем новое сообщение
                await bot.sendMessage(chatId, '❌ Не удалось получить результаты анализа.', {
                    reply_markup: MAIN_MENU_MARKUP
                });
            }
            return;
        }

        if (mode === 'guest') {
            await bot.sendMessage(chatId, GUEST_NOTE);
        }

        try {
            await bot.editMessageText(
                `✅ Анализ завершён (${allResults.length} из ${urls.length})`,
                {
                    chat_id: chatId,
                    message_id: statusMessage.message_id,
                }
            );
        } catch (error: any) {
            // Игнорируем ошибки редактирования
        }

        await bot.sendMessage(chatId, '✅ Все результаты отправлены. Используйте меню для новых действий.', {
            reply_markup: MAIN_MENU_MARKUP,
        });

    } catch (error: any) {
        // Останавливаем обновление статуса при ошибке
        if (statusUpdateInterval) {
            clearInterval(statusUpdateInterval);
        }

        console.error('Error in analyze handler:', error);
        
        let errorMessage = 'Произошла ошибка при анализе. Попробуйте еще раз.';
        
        if (error.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED')) {
            errorMessage = '❌ Сервер недоступен. Убедитесь, что сервер запущен на порту 5000.\n\nЗапустите сервер командой: npm run dev';
        } else if (error.response) {
            errorMessage = error.response.data?.message || `Ошибка сервера: ${error.response.status}`;
        } else if (error.request) {
            errorMessage = 'Не удалось подключиться к серверу. Проверьте, что сервер запущен.';
        }
        
        try {
            await bot.editMessageText(`❌ Ошибка: ${errorMessage}`, {
                chat_id: chatId,
                message_id: statusMessage.message_id,
            });
        } catch (editError: any) {
            // Если не удалось отредактировать, отправляем новое сообщение
            await bot.sendMessage(chatId, `❌ Ошибка: ${errorMessage}`, {
                reply_markup: MAIN_MENU_MARKUP,
            });
        }
    }
};

