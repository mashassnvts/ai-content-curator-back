import TelegramChannel from '../models/TelegramChannel';
import TelegramChannelPost from '../models/TelegramChannelPost';
import User from '../models/User';
import { getChannelPosts } from './telegram-channel.service';
import { Op } from 'sequelize';
import UserInterest from '../models/UserInterest';
import { processSingleUrlAnalysis } from '../controllers/analysis.controller';
import * as cron from 'node-cron';

/**
 * Сервис для периодического мониторинга Telegram-каналов
 * Анализирует новые посты из каналов и отправляет уведомления пользователям
 */

interface AnalysisResult {
    analyzed: number;
    relevant: number;
    relevantPosts: Array<{ url: string; score: number; verdict: string }>;
}

/**
 * Анализирует новые посты из канала для пользователя
 */
async function analyzeChannelForUser(
    channel: TelegramChannel,
    userId: number
): Promise<AnalysisResult> {
    const user = await User.findByPk(userId);
    if (!user) {
        throw new Error(`User ${userId} not found`);
    }

    // Получаем новые посты
    const posts = await getChannelPosts(
        channel.channelUsername,
        20, // Максимум 20 новых постов за раз
        channel.lastPostMessageId || undefined
    );

    if (posts.length === 0) {
        console.log(`ℹ️ [telegram-channel-monitor] No new posts found for channel @${channel.channelUsername} (user ${userId})`);
        return { analyzed: 0, relevant: 0, relevantPosts: [] };
    }

    let analyzed = 0;
    let relevant = 0;
    const relevantPosts: Array<{ url: string; score: number; verdict: string }> = [];
    let lastMessageId = channel.lastPostMessageId || 0;

    // Получаем теги пользователя (облако смыслов) — приоритет над интересами
    const { getUserTagsCached } = await import('./semantic.service');
    const userTags = await getUserTagsCached(userId);
    const interests = userTags.length > 0
        ? userTags.map(t => t.tag)
        : (await UserInterest.findAll({ where: { userId, isActive: true } })).map(ui => ui.interest);

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

            if (existingPost && existingPost.analysisHistoryId) {
                continue; // Уже анализировали
            }

            // Если есть URL поста, анализируем его
            if (post.url) {
                try {
                    // Сохраняем пост сначала
                    let channelPost = await TelegramChannelPost.findOne({
                        where: {
                            channelId: channel.id,
                            messageId: post.messageId
                        }
                    });

                    if (!channelPost) {
                        channelPost = await TelegramChannelPost.create({
                            channelId: channel.id,
                            messageId: post.messageId,
                            postUrl: post.url,
                            postText: post.text
                        });
                    }

                    // Если уже есть анализ, пропускаем
                    if (channelPost.analysisHistoryId) {
                        continue;
                    }

                    // Анализируем пост через внутренний вызов
                    // Используем режим 'unread' (стоит ли читать)
                    try {
                        // Преобразуем массив интересов в строку (формат, который ожидает функция)
                        const interestsString = interests.join(', ');

                        const analysisResult = await processSingleUrlAnalysis(
                            post.url,
                            interestsString,
                            [], // feedbackHistory - пустой массив для автоматического анализа
                            userId,
                            'unread'
                        );

                        // Проверяем, что анализ успешен и не содержит ошибок
                        if (analysisResult && !('error' in analysisResult && analysisResult.error)) {
                            const result = analysisResult as any;
                            
                            if (result.analysisHistoryId) {
                                // Обновляем пост с ID анализа
                                await channelPost.update({
                                    analysisHistoryId: result.analysisHistoryId
                                });

                                analyzed++;

                                // Если оценка высокая (>= 70), считаем релевантным
                                const score = result.score;
                                const verdict = result.verdict;
                                
                                if (score && typeof score === 'number' && score >= 70) {
                                    relevant++;
                                    relevantPosts.push({
                                        url: post.url,
                                        score: score,
                                        verdict: verdict || 'Полезно'
                                    });
                                }
                            }
                        }
                    } catch (analysisError: any) {
                        console.error(`❌ [telegram-channel-monitor] Failed to analyze post ${post.messageId}:`, analysisError.message);
                        // Продолжаем обработку других постов
                    }
                } catch (error: any) {
                    console.error(`❌ [telegram-channel-monitor] Failed to process post ${post.messageId}:`, error.message);
                }
            }

            if (post.messageId > lastMessageId) {
                lastMessageId = post.messageId;
            }
        } catch (error: any) {
            console.error(`❌ [telegram-channel-monitor] Error processing post ${post.messageId}:`, error.message);
        }
    }

    // Обновляем информацию о последней проверке
    await channel.update({
        lastCheckedAt: new Date(),
        lastPostMessageId: lastMessageId
    });

    return { analyzed, relevant, relevantPosts };
}

/**
 * Проверяет все активные каналы и анализирует новые посты
 */
export async function checkAllChannels(): Promise<void> {
    try {
        console.log('🔍 [telegram-channel-monitor] Starting channel check...');

        // Находим все активные каналы, которые нужно проверить
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const channelsToCheck = await TelegramChannel.findAll({
            where: {
                isActive: true,
                [Op.or]: [
                    { lastCheckedAt: null },
                    { 
                        [Op.and]: [
                            { checkFrequency: 'daily' },
                            { lastCheckedAt: { [Op.lt]: oneDayAgo } }
                        ]
                    },
                    {
                        [Op.and]: [
                            { checkFrequency: 'weekly' },
                            { lastCheckedAt: { [Op.lt]: oneWeekAgo } }
                        ]
                    }
                ]
            },
            include: [{
                model: User,
                required: true
            }]
        });

        console.log(`📊 [telegram-channel-monitor] Found ${channelsToCheck.length} channels to check`);

        let totalAnalyzed = 0;
        let totalRelevant = 0;

        for (const channel of channelsToCheck) {
            try {
                console.log(`🔍 [telegram-channel-monitor] Checking channel @${channel.channelUsername} for user ${channel.userId}...`);
                
                const result = await analyzeChannelForUser(channel, channel.userId);
                
                totalAnalyzed += result.analyzed;
                totalRelevant += result.relevant;

                if (result.relevant > 0) {
                    // Отправляем уведомление пользователю
                    await sendNotification(channel.userId, channel.channelUsername, result);
                }

                console.log(`✅ [telegram-channel-monitor] Channel @${channel.channelUsername}: analyzed ${result.analyzed}, relevant ${result.relevant}`);
            } catch (error: any) {
                console.error(`❌ [telegram-channel-monitor] Error checking channel @${channel.channelUsername}:`, error.message);
            }
        }

        console.log(`✅ [telegram-channel-monitor] Channel check completed: ${totalAnalyzed} analyzed, ${totalRelevant} relevant`);
    } catch (error: any) {
        console.error(`❌ [telegram-channel-monitor] Error in checkAllChannels:`, error.message);
    }
}

export async function checkUserChannelsNow(userId: number): Promise<void> {
    try {
        console.log(`🔍 [telegram-channel-monitor] On-demand check: user ${userId}`);

        const channelsToCheck = await TelegramChannel.findAll({
            where: {
                isActive: true,
                userId
            },
            include: [{
                model: User,
                required: true
            }]
        });

        if (channelsToCheck.length === 0) {
            console.log(`ℹ️ [telegram-channel-monitor] On-demand: no active channels for user ${userId}`);
            return;
        }

        console.log(`📊 [telegram-channel-monitor] On-demand: found ${channelsToCheck.length} channel(s) for user ${userId}`);

        let totalAnalyzed = 0;
        let totalRelevant = 0;

        for (const channel of channelsToCheck) {
            try {
                console.log(`🔍 [telegram-channel-monitor] On-demand: checking @${channel.channelUsername} for user ${userId}...`);
                const result = await analyzeChannelForUser(channel, userId);
                totalAnalyzed += result.analyzed;
                totalRelevant += result.relevant;
                console.log(`✅ [telegram-channel-monitor] On-demand @${channel.channelUsername}: analyzed ${result.analyzed}, relevant ${result.relevant}`);
            } catch (error: any) {
                console.error(`❌ [telegram-channel-monitor] On-demand: error checking @${channel.channelUsername} for user ${userId}:`, error.message);
            }
        }

        console.log(`✅ [telegram-channel-monitor] On-demand check completed for user ${userId}: ${totalAnalyzed} analyzed, ${totalRelevant} relevant`);
    } catch (error: any) {
        console.error(`❌ [telegram-channel-monitor] On-demand check failed for user ${userId}:`, error.message);
    }
}

/**
 * Отправляет уведомление пользователю о новых релевантных постах
 */
async function sendNotification(
    userId: number,
    channelUsername: string,
    result: AnalysisResult
): Promise<void> {
    try {
        const user = await User.findByPk(userId);
        if (!user || !user.telegram_chat_id) {
            // Пользователь не привязан к Telegram или не имеет chat_id
            return;
        }

        // Импортируем бота динамически, чтобы избежать циклических зависимостей
        const { bot } = await import('../bot/bot');
        
        const message = `📢 *Новые статьи в канале @${channelUsername}*\n\n` +
            `Найдено ${result.analyzed} новых постов.\n` +
            `${result.relevant} из них могут быть вам интересны.\n\n` +
            `Проверьте канал: https://t.me/${channelUsername}`;

        await bot.sendMessage(user.telegram_chat_id, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: false
        });

        console.log(`✅ [telegram-channel-monitor] Notification sent to user ${userId} about @${channelUsername}`);
    } catch (error: any) {
        console.error(`❌ [telegram-channel-monitor] Failed to send notification to user ${userId}:`, error.message);
    }
}

/**
 * Запускает периодическую проверку каналов через cron jobs
 * Проверяет каналы каждые N часов (можно настроить)
 */
let cronTask: ReturnType<typeof cron.schedule> | null = null;

export function startChannelMonitoring(intervalHours: number = 6): void {
    if (cronTask) {
        console.log('⚠️ [telegram-channel-monitor] Monitoring already started');
        return;
    }

    // Конвертируем часы в cron выражение
    // Например, каждые 6 часов: '0 */6 * * *' (в 0 минут каждого 6-го часа)
    const cronExpression = `0 */${intervalHours} * * *`;
    
    console.log(`🔄 [telegram-channel-monitor] Starting periodic channel monitoring (every ${intervalHours} hours)`);
    console.log(`   Cron expression: ${cronExpression}`);
    
    // Первая проверка через 1 минуту после запуска
    setTimeout(() => {
        checkAllChannels();
    }, 60000);

    // Настраиваем cron задачу
    cronTask = cron.schedule(cronExpression, () => {
        console.log(`⏰ [telegram-channel-monitor] Cron triggered - checking channels...`);
        checkAllChannels();
    }, {
        timezone: "UTC" // Можно изменить на нужный часовой пояс
    });

    console.log(`✅ [telegram-channel-monitor] Channel monitoring started with cron`);
}

export function stopChannelMonitoring(): void {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
        console.log('🛑 [telegram-channel-monitor] Channel monitoring stopped');
    }
}
