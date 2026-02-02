import axios from 'axios';
import TelegramChannel from '../models/TelegramChannel';
import TelegramChannelPost from '../models/TelegramChannelPost';

/**
 * Получает URL для Telegram API
 * Проверяет наличие токена перед использованием
 */
function getTelegramApiUrl(): string {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        throw new Error('TELEGRAM_BOT_TOKEN is not set in environment variables.');
    }
    return `https://api.telegram.org/bot${token}`;
}

/**
 * Получает информацию о канале по username
 */
export async function getChannelInfo(channelUsername: string): Promise<{ id: number; title: string } | null> {
    try {
        // Убираем @ если есть
        const username = channelUsername.replace('@', '');
        
        // Пробуем получить информацию через getChat
        const TELEGRAM_API_URL = getTelegramApiUrl();
        const response = await axios.get(`${TELEGRAM_API_URL}/getChat`, {
            params: {
                chat_id: `@${username}`
            }
        });

        if (response.data.ok) {
            return {
                id: response.data.result.id,
                title: response.data.result.title || username
            };
        }
    } catch (error: any) {
        console.error(`❌ [getChannelInfo] Failed to get channel info for @${channelUsername}:`, error.message);
    }
    
    return null;
}

/**
 * Получает новые посты из канала
 * ВАЖНО: Telegram Bot API не позволяет напрямую получать посты из каналов, если бот не является администратором
 * Для публичных каналов можно использовать альтернативные методы:
 * 1. Если бот добавлен в канал как администратор - использовать getUpdates или getChat
 * 2. Использовать MTProto API (требует отдельной библиотеки)
 * 3. Использовать веб-скрапинг Telegram Web (не рекомендуется)
 * 
 * В данной реализации мы используем упрощенный подход:
 * - Пользователь может добавить канал по username
 * - Система будет пытаться получить посты через getUpdates (если бот подписан на канал)
 * - Альтернативно: пользователь может добавлять прямые ссылки на посты
 */
export async function getChannelPosts(
    channelUsername: string,
    limit: number = 10,
    sinceMessageId?: number
): Promise<Array<{ messageId: number; text: string; url: string | null; date: Date }>> {
    try {
        const username = channelUsername.replace('@', '');
        const posts: Array<{ messageId: number; text: string; url: string | null; date: Date }> = [];

        // Пробуем получить обновления через getUpdates
        // ВАЖНО: Это работает только если бот подписан на канал и получает обновления
        const TELEGRAM_API_URL = getTelegramApiUrl();
        const updatesResponse = await axios.get(`${TELEGRAM_API_URL}/getUpdates`, {
            params: {
                timeout: 1,
                limit: 100
            }
        });

        if (updatesResponse.data.ok && Array.isArray(updatesResponse.data.result)) {
            for (const update of updatesResponse.data.result) {
                if (update.channel_post && update.channel_post.chat) {
                    const chat = update.channel_post.chat;
                    const chatUsername = chat.username || '';
                    
                    // Проверяем, что это нужный канал
                    if (chatUsername.toLowerCase() === username.toLowerCase()) {
                        const messageId = update.channel_post.message_id;
                        
                        // Пропускаем уже обработанные посты
                        if (sinceMessageId && messageId <= sinceMessageId) {
                            continue;
                        }

                        const text = update.channel_post.text || update.channel_post.caption || '';
                        const date = new Date(update.channel_post.date * 1000);
                        
                        // Формируем URL поста
                        const postUrl = `https://t.me/${username}/${messageId}`;

                        posts.push({
                            messageId,
                            text,
                            url: postUrl,
                            date
                        });

                        if (posts.length >= limit) {
                            break;
                        }
                    }
                }
            }
        }

        return posts;
    } catch (error: any) {
        console.error(`❌ [getChannelPosts] Failed to get posts from @${channelUsername}:`, error.message);
        return [];
    }
}

/**
 * Альтернативный метод: получение постов через прямые ссылки
 * Пользователь может добавить ссылку на конкретный пост, и система его проанализирует
 */
export async function processPostUrl(postUrl: string): Promise<{ text: string; channelUsername: string } | null> {
    try {
        // Формат URL: https://t.me/channel_username/message_id
        const match = postUrl.match(/https?:\/\/t\.me\/([^\/]+)\/(\d+)/);
        if (!match) {
            return null;
        }

        const channelUsername = match[1];
        const messageId = parseInt(match[2], 10);

        // Пробуем получить сообщение через forwardMessage или getChat
        // ВАЖНО: Это работает только если бот имеет доступ к каналу
        try {
            const TELEGRAM_API_URL = getTelegramApiUrl();
            const response = await axios.get(`${TELEGRAM_API_URL}/getChat`, {
                params: {
                    chat_id: `@${channelUsername}`
                }
            });

            if (response.data.ok) {
                // Если бот имеет доступ, можем попробовать получить сообщение
                // Но это требует дополнительных прав
                return {
                    text: '', // Текст будет получен при анализе через URL
                    channelUsername
                };
            }
        } catch (error: any) {
            // Если не удалось получить доступ, возвращаем хотя бы username
            return {
                text: '',
                channelUsername
            };
        }

        return null;
    } catch (error: any) {
        console.error(`❌ [processPostUrl] Failed to process post URL ${postUrl}:`, error.message);
        return null;
    }
}

/**
 * Анализирует новые посты из канала для пользователя
 */
export async function analyzeChannelPosts(
    channelId: number,
    userId: number
): Promise<{ analyzed: number; relevant: number }> {
    const channel = await TelegramChannel.findByPk(channelId);
    if (!channel || !channel.isActive || channel.userId !== userId) {
        throw new Error('Channel not found or not active');
    }

    // Получаем новые посты
    const posts = await getChannelPosts(
        channel.channelUsername,
        20, // Максимум 20 новых постов за раз
        channel.lastPostMessageId || undefined
    );

    if (posts.length === 0) {
        console.log(`ℹ️ [analyzeChannelPosts] No new posts found for channel @${channel.channelUsername}`);
        return { analyzed: 0, relevant: 0 };
    }

    let analyzed = 0;
    let relevant = 0;
    let lastMessageId = channel.lastPostMessageId || 0;

    // Анализируем каждый пост
    for (const post of posts) {
        try {
            // Проверяем, не анализировали ли мы уже этот пост
            const existingPost = await TelegramChannelPost.findOne({
                where: {
                    channelId: channel.id,
                    messageId: post.messageId
                }
            });

            if (existingPost) {
                continue; // Уже анализировали
            }

            // Если есть URL поста, анализируем через существующий API анализа
            if (post.url) {
                // Здесь нужно вызвать анализ через API
                // Пока что просто сохраняем пост
                await TelegramChannelPost.create({
                    channelId: channel.id,
                    messageId: post.messageId,
                    postUrl: post.url,
                    postText: post.text
                });

                analyzed++;
                
                // TODO: Вызвать анализ через API и сохранить результат
                // Это будет сделано в cron job сервисе
            }

            if (post.messageId > lastMessageId) {
                lastMessageId = post.messageId;
            }
        } catch (error: any) {
            console.error(`❌ [analyzeChannelPosts] Failed to process post ${post.messageId}:`, error.message);
        }
    }

    // Обновляем информацию о последней проверке
    await channel.update({
        lastCheckedAt: new Date(),
        lastPostMessageId: lastMessageId
    });

    return { analyzed, relevant };
}
