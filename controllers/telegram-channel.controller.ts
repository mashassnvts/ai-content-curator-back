import { Response } from 'express';
import TelegramChannel from '../models/TelegramChannel';
import TelegramChannelPost from '../models/TelegramChannelPost';
import { getChannelInfo, processPostUrl } from '../services/telegram-channel.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { processSingleUrlAnalysis } from './analysis.controller';
import UserInterest from '../models/UserInterest';

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

        const { channelUsername, postUrl, checkFrequency = 'daily' } = req.body;

        // Если передан postUrl, обрабатываем как ссылку на пост
        if (postUrl) {
            const postInfo = await processPostUrl(postUrl);
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
            const match = postUrl.match(/https?:\/\/t\.me\/[^\/]+\/(\d+)/);
            const messageId = match ? parseInt(match[1], 10) : Date.now();

            const channelPost = await TelegramChannelPost.create({
                channelId: channel.id,
                messageId,
                postUrl: postUrl,
                postText: postInfo.text
            });

            // Сразу анализируем пост
            let analysisResult = null;
            try {
                // Получаем интересы пользователя
                const userInterests = await UserInterest.findAll({
                    where: { userId, isActive: true }
                });
                const interests = userInterests.map(ui => ui.interest).join(', ');

                if (interests) {
                    console.log(`🔍 [telegram-channel] Analyzing post ${postUrl} for user ${userId}...`);
                    analysisResult = await processSingleUrlAnalysis(
                        postUrl,
                        interests,
                        [], // feedbackHistory
                        userId,
                        'unread' // режим "стоит ли читать"
                    );

                    // Сохраняем ID анализа в пост
                    if (analysisResult && analysisResult.analysisHistoryId) {
                        await channelPost.update({
                            analysisHistoryId: analysisResult.analysisHistoryId
                        });
                    }
                    console.log(`✅ [telegram-channel] Post analyzed: score=${analysisResult?.score}, verdict=${analysisResult?.verdict}`);
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
                analysis: analysisResult ? {
                    score: analysisResult.score,
                    verdict: analysisResult.verdict,
                    summary: analysisResult.summary,
                    reasoning: analysisResult.reasoning
                } : null
            });
        }

        // Если передан channelUsername, добавляем канал для мониторинга
        if (!channelUsername) {
            return res.status(400).json({ 
                message: 'channelUsername or postUrl is required',
                error: 'Missing required field'
            });
        }

        // Убираем @ если есть
        const username = channelUsername.replace('@', '').trim();
        if (!username) {
            return res.status(400).json({ 
                message: 'Invalid channel username',
                error: 'Empty username'
            });
        }

        // Проверяем, не добавлен ли уже этот канал
        const existingChannel = await TelegramChannel.findOne({
            where: {
                userId,
                channelUsername: username
            }
        });

        if (existingChannel) {
            return res.status(400).json({ 
                message: 'Channel already added',
                error: 'Duplicate channel'
            });
        }

        // Получаем информацию о канале
        const channelInfo = await getChannelInfo(username);
        
        // Создаем запись о канале
        const channel = await TelegramChannel.create({
            userId,
            channelUsername: username,
            channelId: channelInfo?.id || null,
            isActive: true,
            checkFrequency: checkFrequency as 'daily' | 'weekly'
        });

        return res.status(201).json({
            success: true,
            message: 'Channel added successfully',
            channel: {
                id: channel.id,
                channelUsername: channel.channelUsername,
                channelId: channel.channelId,
                isActive: channel.isActive,
                checkFrequency: channel.checkFrequency
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
