import { Response } from 'express';
import TelegramChannel from '../models/TelegramChannel';
import TelegramChannelPost from '../models/TelegramChannelPost';
import { getChannelInfo, processPostUrl } from '../services/telegram-channel.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { processSingleUrlAnalysis } from './analysis.controller';
import UserInterest from '../models/UserInterest';
import { getUserTagsCached } from '../services/semantic.service';

/**
 * GET /api/telegram-channels
 * Получить список каналов пользователя
 */
export const getUserChannels = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const channels = await TelegramChannel.findAll({
            where: { userId },
            order: [['created_at', 'DESC']],
            include: [{
                model: TelegramChannelPost,
                as: 'TelegramChannelPosts',
                required: false,
                limit: 1,
                order: [['created_at', 'DESC']]
            }]
        });

        return res.status(200).json({
            success: true,
            channels: channels.map(ch => ({
                id: ch.id,
                channelUsername: ch.channelUsername,
                channelId: ch.channelId,
                isActive: ch.isActive,
                checkFrequency: ch.checkFrequency,
                lastCheckedAt: ch.lastCheckedAt,
                createdAt: ch.createdAt
            }))
        });
    } catch (error: any) {
        console.error('Error getting user channels:', error);
        return res.status(500).json({ message: 'Error getting channels', error: error.message });
    }
};

/**
 * POST /api/telegram-channels
 * Добавить канал для мониторинга
 * Body: { channelUsername: string, checkFrequency?: 'daily' | 'weekly' }
 * ИЛИ
 * Body: { postUrl: string } - добавить конкретный пост
 */
export const addChannel = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const { channelUsername, postUrl, checkFrequency = 'daily', initialPostsCount = 10 } = req.body;

        // Если передан postUrl или channelUsername содержит ссылку на канал/пост
        let actualPostUrl = postUrl;
        let actualChannelUsername = channelUsername;
        
        // Проверяем, является ли channelUsername ссылкой на канал или пост
        if (channelUsername && !actualPostUrl) {
            const telegramUrlMatch = channelUsername.match(/https?:\/\/t\.me\/([^\/]+)(?:\/(\d+))?/);
            if (telegramUrlMatch) {
                const [, username, messageId] = telegramUrlMatch;
                if (messageId) {
                    // Это ссылка на пост
                    actualPostUrl = channelUsername;
                    actualChannelUsername = undefined;
                } else {
                    // Это ссылка на канал
                    actualChannelUsername = username;
                }
            }
        }

        // Если передан postUrl, обрабатываем как ссылку на пост
        if (actualPostUrl) {
            const postInfo = await processPostUrl(actualPostUrl);
            if (!postInfo) {
                return res.status(400).json({ 
                    message: 'Invalid post URL format. Expected: https://t.me/channel_username/message_id',
                    error: 'Invalid URL format'
                });
            }

            // Проверяем, есть ли уже канал для этого username
            let channel = await TelegramChannel.findOne({
                where: {
                    userId,
                    channelUsername: postInfo.channelUsername
                }
            });

            if (!channel) {
                // Получаем информацию о канале
                const channelInfo = await getChannelInfo(postInfo.channelUsername);
                
                channel = await TelegramChannel.create({
                    userId,
                    channelUsername: postInfo.channelUsername,
                    channelId: channelInfo?.id || null,
                    isActive: true,
                    checkFrequency: checkFrequency as 'daily' | 'weekly'
                });
            }

            // Сохраняем пост
            const match = actualPostUrl.match(/https?:\/\/t\.me\/[^\/]+\/(\d+)/);
            const messageId = match ? parseInt(match[1], 10) : Date.now();

            const channelPost = await TelegramChannelPost.create({
                channelId: channel.id,
                messageId,
                postUrl: actualPostUrl,
                postText: postInfo.text
            });

            // Сразу анализируем пост
            let analysisResult = null;
            try {
                // Получаем теги пользователя (облако смыслов) — приоритет над интересами
                const userTags = await getUserTagsCached(userId);
                let contextForAnalysis = userTags.length > 0
                    ? userTags.map(t => t.tag).join(', ')
                    : (await UserInterest.findAll({ where: { userId, isActive: true } })).map(ui => ui.interest).join(', ');

                if (contextForAnalysis) {
                    console.log(`🔍 [telegram-channel] Analyzing post ${actualPostUrl} for user ${userId}...`);
                    analysisResult = await processSingleUrlAnalysis(
                        actualPostUrl,
                        contextForAnalysis,
                        [], // feedbackHistory
                        userId,
                        'unread' // режим "стоит ли читать"
                    );

                    // Сохраняем ID анализа в пост
                    // Проверяем, что анализ успешен и не содержит ошибок
                    if (analysisResult && typeof analysisResult === 'object' && !('error' in analysisResult && analysisResult.error)) {
                        const result = analysisResult as any;
                        if (result && typeof result.analysisHistoryId === 'number') {
                            await channelPost.update({
                                analysisHistoryId: result.analysisHistoryId
                            });
                        }
                        if (result && typeof result.score === 'number' && typeof result.verdict === 'string') {
                            console.log(`✅ [telegram-channel] Post analyzed: score=${result.score}, verdict=${result.verdict}`);
                        }
                    }
                }
            } catch (analysisError: any) {
                console.error(`⚠️ [telegram-channel] Failed to analyze post: ${analysisError.message}`);
                // Продолжаем без анализа, пост уже сохранён
            }

            return res.status(201).json({
                success: true,
                message: analysisResult ? 'Post added and analyzed successfully' : 'Post added successfully (analysis pending)',
                channel: {
                    id: channel.id,
                    channelUsername: channel.channelUsername,
                    postUrl
                },
                analysis: analysisResult && typeof analysisResult === 'object' && !('error' in analysisResult && analysisResult.error) ? (() => {
                    const result = analysisResult as any;
                    if (result && typeof result.score === 'number' && typeof result.verdict === 'string') {
                        return {
                            score: result.score,
                            verdict: result.verdict,
                            summary: typeof result.summary === 'string' ? result.summary : null,
                            reasoning: typeof result.reasoning === 'string' ? result.reasoning : null
                        };
                    }
                    return null;
                })() : null
            });
        }

        // Если передан channelUsername, добавляем канал для мониторинга
        if (!actualChannelUsername) {
            return res.status(400).json({ 
                message: 'channelUsername or postUrl is required',
                error: 'Missing required field'
            });
        }

        // Убираем @ если есть
        const username = actualChannelUsername.replace('@', '').trim();
        if (!username) {
            return res.status(400).json({ 
                message: 'Invalid channel username',
                error: 'Empty username'
            });
        }

        // Проверяем, не добавлен ли уже этот канал
        let channel = await TelegramChannel.findOne({
            where: {
                userId,
                channelUsername: username
            }
        });

        if (!channel) {
            // Получаем информацию о канале и создаем запись
            const channelInfo = await getChannelInfo(username);
            channel = await TelegramChannel.create({
                userId,
                channelUsername: username,
                channelId: channelInfo?.id || null,
                isActive: true,
                checkFrequency: checkFrequency as 'daily' | 'weekly'
            });
        } else {
            console.log(`ℹ️ [telegram-channel] Channel @${username} already added for user ${userId}, analyzing latest posts...`);
        }

        // Анализируем последние N постов из канала (по умолчанию 6, можно настроить через initialPostsCount)
        const postsToAnalyze = Math.min(Math.max(parseInt(String(initialPostsCount)) || 6, 1), 20);
        
        // Запрашиваем больше постов (буфер), т.к. страница может подгрузить не все — потом возьмём нужное количество
        const fetchLimit = Math.max(postsToAnalyze + 5, 15);
        
        console.log(`📊 [telegram-channel] Will analyze last ${postsToAnalyze} posts from @${username} for user ${userId} (fetching up to ${fetchLimit})`);
        const { getChannelPosts } = await import('../services/telegram-channel.service');
        const allFetched = await getChannelPosts(username, fetchLimit);
        const posts = allFetched.slice(0, postsToAnalyze);
        
        const analyzedPosts: Array<{
            url: string;
            score: number;
            verdict: string;
            summary?: string;
            text?: string;
        }> = [];
        
        let relevantCount = 0;
        
        if (posts.length > 0) {
            // Получаем теги пользователя (облако смыслов) — приоритет над интересами
            const userTags = await getUserTagsCached(userId);
            const contextForAnalysis = userTags.length > 0
                ? userTags.map(t => t.tag).join(', ')
                : (await UserInterest.findAll({ where: { userId, isActive: true } })).map(ui => ui.interest).join(', ');

            if (!contextForAnalysis) {
                console.log(`ℹ️ [telegram-channel] No tags or interests for user ${userId}, skipping post analysis`);
            }

            if (contextForAnalysis && posts.length > 0) {
                console.log(`🔍 [telegram-channel] Analyzing ${posts.length} posts from @${username} for user ${userId}...`);
                
                // Анализируем каждый пост
                for (const post of posts) {
                    if (post.url) {
                        try {
                            const analysisResult = await processSingleUrlAnalysis(
                                post.url,
                                contextForAnalysis,
                                [],
                                userId,
                                'unread' // режим "стоит ли читать"
                            );

                            if (analysisResult && typeof analysisResult === 'object' && !('error' in analysisResult && analysisResult.error)) {
                                const result = analysisResult as any;
                                if (result && typeof result.score === 'number' && typeof result.verdict === 'string') {
                                    analyzedPosts.push({
                                        url: post.url,
                                        score: result.score,
                                        verdict: result.verdict,
                                        summary: typeof result.summary === 'string' ? result.summary : undefined,
                                        text: post.text || undefined
                                    });
                                    
                                    // Сохраняем пост в БД
                                    const match = post.url.match(/https?:\/\/t\.me\/[^\/]+\/(\d+)/);
                                    const messageId = match ? parseInt(match[1], 10) : post.messageId;
                                    
                                    let channelPost = await TelegramChannelPost.findOne({
                                        where: {
                                            channelId: channel.id,
                                            messageId
                                        }
                                    });
                                    
                                    if (!channelPost) {
                                        channelPost = await TelegramChannelPost.create({
                                            channelId: channel.id,
                                            messageId,
                                            postUrl: post.url,
                                            postText: post.text
                                        });
                                    }
                                    
                                    if (result.analysisHistoryId) {
                                        await channelPost.update({
                                            analysisHistoryId: result.analysisHistoryId
                                        });
                                    }
                                    
                                    if (result.score >= 70) {
                                        relevantCount++;
                                    }
                                }
                            }
                        } catch (analysisError: any) {
                            console.error(`⚠️ [telegram-channel] Failed to analyze post ${post.url}:`, analysisError.message);
                        }
                    }
                }
            }
        }

        // Формируем рекомендацию на основе результатов
        let recommendation = '';
        if (analyzedPosts.length === 0) {
            recommendation = posts.length === 0
                ? 'Не удалось получить посты из канала. Возможно, канал приватный или недоступен.'
                : 'Не удалось проанализировать посты. Добавьте темы в облако смыслов: проанализируйте статьи в режиме "Я прочитал и понравилось".';
        } else if (relevantCount === 0) {
            recommendation = `Проанализировано ${analyzedPosts.length} постов. К сожалению, ни один из них не совпадает с вашими тегами в облаке смыслов (порог релевантности: 70%). Возможно, стоит пересмотреть выбор канала или проанализировать больше статей в режиме "Я прочитал и понравилось".`;
        } else {
            recommendation = `Проанализировано ${analyzedPosts.length} постов. Найдено ${relevantCount} релевантных постов (${Math.round(relevantCount / analyzedPosts.length * 100)}%), которые могут быть вам интересны. Канал стоит читать!`;
        }

        return res.status(201).json({
            success: true,
            message: 'Channel analyzed successfully',
            channel: {
                id: channel.id,
                channelUsername: channel.channelUsername,
                channelId: channel.channelId,
                isActive: channel.isActive,
                checkFrequency: channel.checkFrequency
            },
            analysis: {
                totalPosts: analyzedPosts.length,
                relevantPosts: relevantCount,
                posts: analyzedPosts,
                recommendation
            }
        });
    } catch (error: any) {
        console.error('Error adding channel:', error);
        return res.status(500).json({ 
            message: 'Error adding channel', 
            error: error.message 
        });
    }
};

/**
 * DELETE /api/telegram-channels/:id
 * Удалить канал из мониторинга
 */
export const deleteChannel = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const channelId = parseInt(req.params.id, 10);
        if (isNaN(channelId)) {
            return res.status(400).json({ message: 'Invalid channel ID' });
        }

        const channel = await TelegramChannel.findOne({
            where: {
                id: channelId,
                userId
            }
        });

        if (!channel) {
            return res.status(404).json({ message: 'Channel not found' });
        }

        await channel.destroy();

        return res.status(200).json({
            success: true,
            message: 'Channel deleted successfully'
        });
    } catch (error: any) {
        console.error('Error deleting channel:', error);
        return res.status(500).json({ 
            message: 'Error deleting channel', 
            error: error.message 
        });
    }
};

/**
 * PATCH /api/telegram-channels/:id
 * Обновить настройки канала (активность, частота проверки)
 */
export const updateChannel = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const channelId = parseInt(req.params.id, 10);
        if (isNaN(channelId)) {
            return res.status(400).json({ message: 'Invalid channel ID' });
        }

        const { isActive, checkFrequency } = req.body;

        const channel = await TelegramChannel.findOne({
            where: {
                id: channelId,
                userId
            }
        });

        if (!channel) {
            return res.status(404).json({ message: 'Channel not found' });
        }

        if (isActive !== undefined) {
            channel.isActive = isActive;
        }
        if (checkFrequency && (checkFrequency === 'daily' || checkFrequency === 'weekly')) {
            channel.checkFrequency = checkFrequency;
        }

        await channel.save();

        return res.status(200).json({
            success: true,
            message: 'Channel updated successfully',
            channel: {
                id: channel.id,
                channelUsername: channel.channelUsername,
                isActive: channel.isActive,
                checkFrequency: channel.checkFrequency
            }
        });
    } catch (error: any) {
        console.error('Error updating channel:', error);
        return res.status(500).json({ 
            message: 'Error updating channel', 
            error: error.message 
        });
    }
};
