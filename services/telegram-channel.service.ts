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
 * Получает новые посты из канала через веб-скрапинг
 * Использует Puppeteer для получения последних постов из публичного канала Telegram
 */
export async function getChannelPosts(
    channelUsername: string,
    limit: number = 10,
    sinceMessageId?: number
): Promise<Array<{ messageId: number; text: string; url: string | null; date: Date }>> {
    try {
        const username = channelUsername.replace('@', '');
        const posts: Array<{ messageId: number; text: string; url: string | null; date: Date }> = [];

        // Метод 1: Пробуем через Telegram Bot API (если бот подписан на канал)
        try {
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
                        
                        if (chatUsername.toLowerCase() === username.toLowerCase()) {
                            const messageId = update.channel_post.message_id;
                            
                            if (sinceMessageId && messageId <= sinceMessageId) {
                                continue;
                            }

                            const text = update.channel_post.text || update.channel_post.caption || '';
                            const date = new Date(update.channel_post.date * 1000);
                            const postUrl = `https://t.me/${username}/${messageId}`;

                            posts.push({
                                messageId,
                                text,
                                url: postUrl,
                                date
                            });

                            if (posts.length >= limit) {
                                return posts;
                            }
                        }
                    }
                }
            }
        } catch (apiError: any) {
            console.log(`ℹ️ [getChannelPosts] Bot API method not available: ${apiError.message}`);
        }

        // Метод 2: Веб-скрапинг через Puppeteer (для публичных каналов)
        if (posts.length < limit) {
            try {
                console.log(`🌐 [getChannelPosts] Trying web scraping for @${username}...`);
                const puppeteer = (await import('puppeteer-extra')).default;
                const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
                puppeteer.use(StealthPlugin());

                const channelUrl = `https://t.me/s/${username}`;
                
                const browser = await puppeteer.launch({
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                });

                const page = await browser.newPage();
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                
                await page.goto(channelUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                
                // Ждем загрузки постов
                await new Promise(resolve => setTimeout(resolve, 4000));
                
                // Прокручиваем страницу несколько раз, чтобы подгрузить больше постов (Telegram lazy-load)
                for (let i = 0; i < 5; i++) {
                    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                    await new Promise(resolve => setTimeout(resolve, 2500));
                }

                // Извлекаем все посты со страницы, затем возьмём последние N (по messageId)
                const sinceIdArg = sinceMessageId ?? 0;
                const scrapedPosts = await page.evaluate((sinceId: number) => {
                    const posts: Array<{ messageId: number; text: string; url: string | null; date: Date }> = [];
                    
                    // Селекторы для постов в Telegram Web
                    const messageElements = document.querySelectorAll('.tgme_widget_message, [data-post]');
                    
                    for (const element of Array.from(messageElements)) {
                        try {
                            // Извлекаем message ID из data-post атрибута или из URL
                            let messageId = 0;
                            const dataPost = (element as HTMLElement).getAttribute('data-post');
                            if (dataPost) {
                                const match = dataPost.match(/\/(\d+)$/);
                                if (match) {
                                    messageId = parseInt(match[1], 10);
                                }
                            }
                            
                            // Если не нашли в data-post, пробуем из URL
                            if (!messageId) {
                                const linkEl = element.querySelector('a[href*="/"]');
                                if (linkEl) {
                                    const href = linkEl.getAttribute('href') || '';
                                    const match = href.match(/\/(\d+)$/);
                                    if (match) {
                                        messageId = parseInt(match[1], 10);
                                    }
                                }
                            }
                            
                            if (!messageId || (sinceId && messageId <= sinceId)) {
                                continue;
                            }
                            
                            // Извлекаем текст поста (допускаем посты с коротким текстом - медиа, подписи)
                            const textEl = element.querySelector('.tgme_widget_message_text');
                            let text = '';
                            if (textEl) {
                                const clone = textEl.cloneNode(true) as HTMLElement;
                                clone.querySelectorAll('a').forEach(a => {
                                    const linkText = a.textContent;
                                    if (linkText) {
                                        a.replaceWith(document.createTextNode(linkText));
                                    } else {
                                        a.remove();
                                    }
                                });
                                clone.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\n')));
                                text = clone.textContent?.trim() || '';
                            }
                            
                            // Извлекаем дату
                            const dateEl = element.querySelector('.tgme_widget_message_date time');
                            let date = new Date();
                            if (dateEl) {
                                const datetime = dateEl.getAttribute('datetime');
                                if (datetime) {
                                    date = new Date(datetime);
                                }
                            }
                            
                            if (messageId) {
                                const postUrl = `https://t.me/${(window.location.pathname.match(/\/s\/([^\/]+)/) || [])[1]}/${messageId}`;
                                posts.push({
                                    messageId,
                                    text,
                                    url: postUrl,
                                    date
                                });
                            }
                        } catch (e) {
                            // Пропускаем проблемные элементы
                            continue;
                        }
                    }
                    
                    // Сортируем по messageId (новые первые) и возвращаем все — фильтрация по limit будет снаружи
                    posts.sort((a, b) => b.messageId - a.messageId);
                    return posts;
                }, sinceIdArg);

                await browser.close();

                // Добавляем скрапленные посты (уже отсортированы по messageId desc)
                for (const post of scrapedPosts) {
                    if (!posts.find(p => p.messageId === post.messageId)) {
                        posts.push(post);
                    }
                }

                console.log(`✓ [getChannelPosts] Scraped ${scrapedPosts.length} posts from @${username}`);
            } catch (scrapingError: any) {
                console.warn(`⚠️ [getChannelPosts] Web scraping failed: ${scrapingError.message}`);
            }
        }

        // Сортируем по messageId (по убыванию - самые новые первые)
        posts.sort((a, b) => b.messageId - a.messageId);
        
        // Возвращаем ровно limit последних постов (с наибольшим messageId)
        return posts.slice(0, limit);
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
