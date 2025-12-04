import { Op } from 'sequelize';
import User from '../../models/User';
import UserInterest from '../../models/UserInterest';
import BotProfile, { BotMode } from '../../models/BotProfile';
import BotAnalysisHistory from '../../models/BotAnalysisHistory';
import historyCleanupService from '../../services/history-cleanup.service';

class BotUserService {
    async getOrCreateProfile(telegramId: string, username?: string, chatId?: string) {
        let profile = await BotProfile.findOne({ where: { telegram_id: telegramId } });
        if (!profile) {
            profile = await BotProfile.create({
                telegram_id: telegramId,
                telegram_username: username,
                telegram_chat_id: chatId,
                mode: 'guest',
            });
        } else if (username || chatId) {
            await profile.update({
                telegram_username: username || profile.telegram_username,
                telegram_chat_id: chatId || profile.telegram_chat_id,
            });
        }
        return profile;
    }

    async setMode(telegramId: string, mode: BotMode, userId?: number | null) {
        const profile = await this.getOrCreateProfile(telegramId);
        await profile.update({
            mode,
            user_id: mode === 'linked' ? userId ?? profile.user_id : null,
        });
        return profile;
    }

    async linkProfileToUser(telegramId: string, userId: number, username?: string, chatId?: string) {
        const profile = await this.getOrCreateProfile(telegramId, username, chatId);
        await profile.update({
            mode: 'linked',
            user_id: userId,
        });
        return profile;
    }

    async unlinkProfile(telegramId: string) {
        const profile = await this.getOrCreateProfile(telegramId);
        await profile.update({
            mode: 'guest',
            user_id: null,
        });
    }

    async ensureLinkedUser(telegramId: string) {
        if (!telegramId) return null;
        const user = await User.findOne({ where: { telegram_id: telegramId } });
        if (!user) return null;
        await this.linkProfileToUser(telegramId, user.id);
        return user;
    }

    async getMode(telegramId: string) {
        const profile = await this.getOrCreateProfile(telegramId);
        return profile.mode;
    }

    async getUserInterests(telegramId: string): Promise<{ interests: string[]; activeInterests: string[]; mode: BotMode; linkedUserId?: number; levels?: Record<string, string> }> {
        const profile = await this.getOrCreateProfile(telegramId);
        
        // Импортируем функцию фильтрации кнопок меню
        const { filterMenuButtons } = await import('../utils/menu');
        const UserInterestLevel = (await import('../../models/UserInterestLevel')).default;
        
        if (profile.mode === 'linked' && profile.user_id) {
            const interests = await UserInterest.findAll({
                where: { userId: profile.user_id },
                order: [['createdAt', 'ASC']],
            });
            const allInterests = filterMenuButtons(interests.map((i) => i.interest)); // Фильтруем кнопки меню
            const interestIdMap = new Map(interests.map(i => [i.id, i.interest]));
            
            // Для linked режима сначала пытаемся загрузить активные интересы с сервера
            let activeInterests: string[] = [];
            try {
                const UserService = (await import('../../services/user.service')).default;
                const activeInterestIds = await UserService.getActiveInterests(profile.user_id);
                activeInterests = activeInterestIds
                    .map(id => interestIdMap.get(id))
                    .filter((name): name is string => typeof name === 'string');
                
                // Если получили активные интересы с сервера, обновляем BotProfile
                if (activeInterests.length > 0) {
                    await profile.update({ guest_active_interests: JSON.stringify(activeInterests) });
                }
            } catch (error) {
                console.warn('Failed to load active interests from server, using BotProfile:', error);
            }
            
            // Если не удалось загрузить с сервера, используем сохраненные в BotProfile
            if (activeInterests.length === 0) {
                const activeInterestsJson = profile.guest_active_interests;
                if (activeInterestsJson) {
                    const savedActive = JSON.parse(activeInterestsJson);
                    // Фильтруем только те, которые существуют
                    activeInterests = savedActive.filter((interest: string) => allInterests.includes(interest));
                }
            }
            
            // Если нет активных, используем все
            if (activeInterests.length === 0) {
                activeInterests = allInterests;
            }
            
            // Фильтруем кнопки меню из активных интересов
            const filteredActiveInterests = filterMenuButtons(activeInterests);
            
            // Получаем уровни пользователя
            const userLevelsRecords = await UserInterestLevel.findAll({
                where: { userId: profile.user_id },
            });
            const levels: Record<string, string> = {};
            userLevelsRecords.forEach(ul => {
                levels[ul.interest.toLowerCase()] = ul.level;
            });
            
            return { 
                interests: allInterests, 
                activeInterests: filteredActiveInterests, 
                mode: 'linked', 
                linkedUserId: profile.user_id,
                levels 
            };
        }

        const guestInterests = profile.guest_interests ? JSON.parse(profile.guest_interests) : [];
        const filteredGuestInterests = filterMenuButtons(guestInterests); // Фильтруем кнопки меню
        const activeInterestsJson = profile.guest_active_interests;
        const activeInterests = activeInterestsJson ? JSON.parse(activeInterestsJson) : filteredGuestInterests;
        const filteredActiveInterests = filterMenuButtons(activeInterests); // Фильтруем кнопки меню из активных
        
        // Получаем уровни для гостевых пользователей
        const guestLevelsJson = profile.guest_levels;
        const levels: Record<string, string> = guestLevelsJson ? JSON.parse(guestLevelsJson) : {};
        
        return { 
            interests: filteredGuestInterests, 
            activeInterests: filteredActiveInterests, 
            mode: 'guest',
            levels 
        };
    }

    async setActiveInterests(telegramId: string, activeInterests: string[]): Promise<void> {
        const profile = await this.getOrCreateProfile(telegramId);
        // Сохраняем активные интересы для обоих режимов
        await profile.update({ guest_active_interests: JSON.stringify(activeInterests) });
        
        // Для linked пользователей также синхронизируем через API
        if (profile.mode === 'linked' && profile.user_id) {
            try {
                // Получаем ID интересов по их названиям
                const interests = await UserInterest.findAll({
                    where: { userId: profile.user_id },
                });
                const interestIdMap = new Map(interests.map(i => [i.interest, i.id]));
                const activeInterestIds = activeInterests
                    .map(name => interestIdMap.get(name))
                    .filter((id): id is number => typeof id === 'number');
                
                // Синхронизируем через API (если есть доступ к API_URL)
                const API_URL = process.env.API_URL || 'http://localhost:5000';
                // Для синхронизации нужно использовать внутренний вызов UserService
                const UserService = (await import('../../services/user.service')).default;
                await UserService.setActiveInterests(profile.user_id, activeInterestIds);
            } catch (error) {
                console.error('Failed to sync active interests via API:', error);
                // Не прерываем выполнение при ошибке синхронизации
            }
        }
    }

    async addInterest(telegramId: string, interest: string, level?: string): Promise<void> {
        const profile = await this.getOrCreateProfile(telegramId);

        // Импортируем функцию фильтрации кнопок меню
        const { isMenuButton } = await import('../utils/menu');
        const UserInterestLevel = (await import('../../models/UserInterestLevel')).default;

        const interestValues = interest
            .split(',')
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
            .filter((value) => !isMenuButton(value)); // Фильтруем кнопки меню

        if (!interestValues.length) {
            return;
        }

        const validLevels = ['novice', 'amateur', 'professional'];
        
        // Миграция старых значений на новые
        let normalizedLevel = level;
        if (level === 'beginner' || level === 'intermediate') {
            normalizedLevel = 'novice';
        } else if (level === 'advanced') {
            normalizedLevel = 'amateur';
        } else if (level === 'expert') {
            normalizedLevel = 'professional';
        }
        
        const userLevel = normalizedLevel && validLevels.includes(normalizedLevel) ? normalizedLevel : 'novice'; // По умолчанию novice

        if (profile.mode === 'linked' && profile.user_id) {
            const existingInterests = await UserInterest.findAll({
                where: { userId: profile.user_id },
            });

            const existingSet = new Set(existingInterests.map((i) => i.interest.toLowerCase()));

            const now = new Date();
            const createPromises = interestValues
                .filter((value) => !existingSet.has(value.toLowerCase()))
                .map(async (value) => {
                    if (!profile.user_id) return;
                    
                    // Создаем интерес
                    const interestRecord = await UserInterest.create({ 
                        userId: profile.user_id, 
                        interest: value, 
                        lastUsedAt: now 
                    });
                    
                    // Создаем или обновляем уровень
                    const [userLevelRecord] = await UserInterestLevel.findOrCreate({
                        where: {
                            userId: profile.user_id,
                            interest: value.toLowerCase().trim(),
                        },
                        defaults: {
                            userId: profile.user_id,
                            interest: value.toLowerCase().trim(),
                            level: userLevel as 'novice' | 'amateur' | 'professional',
                        },
                    });
                    
                    if (userLevelRecord.level !== userLevel) {
                        userLevelRecord.level = userLevel as 'novice' | 'amateur' | 'professional';
                        await userLevelRecord.save();
                    }
                    
                    return interestRecord;
                });

            await Promise.all(createPromises);
        } else {
            // Для гостевых пользователей сохраняем уровни в JSON формате
            const guestInterests = profile.guest_interests ? JSON.parse(profile.guest_interests) : [];
            const guestLevels = profile.guest_levels ? JSON.parse(profile.guest_levels) : {};
            const lowerSet = new Set(guestInterests.map((i: string) => i.toLowerCase()));
            
            interestValues.forEach((value) => {
                if (!lowerSet.has(value.toLowerCase())) {
                    guestInterests.push(value);
                    lowerSet.add(value.toLowerCase());
                }
                // Сохраняем уровень для каждого интереса
                guestLevels[value.toLowerCase()] = userLevel;
            });
            
            await profile.update({ 
                guest_interests: JSON.stringify(guestInterests),
                guest_levels: JSON.stringify(guestLevels),
            });
        }
    }

    async removeInterest(telegramId: string, interestIndex: number): Promise<void> {
        const profile = await this.getOrCreateProfile(telegramId);

        if (profile.mode === 'linked' && profile.user_id) {
            const interests = await UserInterest.findAll({
                where: { userId: profile.user_id },
                order: [['createdAt', 'ASC']],
            });

            if (interestIndex >= 0 && interestIndex < interests.length) {
                const interestToDelete = interests[interestIndex];
                await interestToDelete.destroy();
            }
        } else {
            const guestInterests = profile.guest_interests ? JSON.parse(profile.guest_interests) : [];
            if (interestIndex >= 0 && interestIndex < guestInterests.length) {
                guestInterests.splice(interestIndex, 1);
                await profile.update({ guest_interests: JSON.stringify(guestInterests) });
            }
        }
    }

    /**
     * Удаляет интерес по тексту (используется для удаления кнопок меню)
     */
    async removeInterestByText(telegramId: string, interestText: string): Promise<void> {
        const profile = await this.getOrCreateProfile(telegramId);

        if (profile.mode === 'linked' && profile.user_id) {
            const interests = await UserInterest.findAll({
                where: { userId: profile.user_id },
            });

            const interestToRemove = interests.find(i => i.interest === interestText);
            if (interestToRemove) {
                await interestToRemove.destroy();
            }
        } else {
            const guestInterests = profile.guest_interests ? JSON.parse(profile.guest_interests) : [];
            const filtered = guestInterests.filter((i: string) => i !== interestText);
            if (filtered.length !== guestInterests.length) {
                await profile.update({ guest_interests: JSON.stringify(filtered) });
            }
        }
    }

    async saveAnalysisHistory(
        telegramId: string,
        url: string,
        interests: string,
        result: {
            sourceType?: string;
            score?: number;
            verdict?: string;
            summary?: string;
            reasoning?: string;
        },
        userId?: number | null
    ): Promise<BotAnalysisHistory> {
        // Сохраняем в BotAnalysisHistory
        const botHistory = await BotAnalysisHistory.create({
            telegram_id: telegramId,
            url,
            interests,
            sourceType: result.sourceType || '',
            score: result.score || 0,
            verdict: result.verdict || '',
            summary: result.summary || '',
            reasoning: result.reasoning || '',
            user_id: userId || null,
        });

        // Если пользователь linked, также сохраняем в AnalysisHistory для синхронизации с веб-приложением
        if (userId) {
            try {
                const AnalysisHistory = (await import('../../models/AnalysisHistory')).default;
                await AnalysisHistory.create({
                    userId,
                    url,
                    interests,
                    sourceType: result.sourceType || '',
                    score: result.score || 0,
                    verdict: result.verdict || '',
                    summary: result.summary || '',
                    reasoning: result.reasoning || '',
                });
            } catch (error) {
                console.error('Error saving to AnalysisHistory:', error);
                // Не прерываем выполнение, если не удалось сохранить в AnalysisHistory
            }

            // Обновляем lastUsedAt для использованных интересов
            const interestsList = interests.split(',').map(i => i.trim());
            await historyCleanupService.updateInterestUsage(userId, interestsList);
        }

        return botHistory;
    }

    async getAnalysisHistory(telegramId: string, limit?: number): Promise<any[]> {
        const profile = await this.getOrCreateProfile(telegramId);
        
        try {
            // Для linked пользователей объединяем историю из BotAnalysisHistory и AnalysisHistory
            if (profile.mode === 'linked' && profile.user_id) {
                const [botHistory, webHistory] = await Promise.all([
                    BotAnalysisHistory.findAll({
                        where: { telegram_id: telegramId },
                        order: [['createdAt', 'DESC']],
                    }),
                    (async () => {
                        try {
                            if (!profile.user_id) return [];
                            const AnalysisHistory = (await import('../../models/AnalysisHistory')).default;
                            return await AnalysisHistory.findAll({
                                where: { userId: profile.user_id },
                                order: [['createdAt', 'DESC']],
                            });
                        } catch (error) {
                            console.error('Error loading web history:', error);
                            return [];
                        }
                    })()
                ]);
                
                console.log(`[BotHistory] Loaded ${botHistory.length} bot records and ${webHistory.length} web records for user ${profile.user_id}`);
                
                // Объединяем и сортируем по дате
                // Используем уникальные ID: для bot истории добавляем префикс 'bot_', для web - 'web_'
                const combined: Array<{ id: string; originalId: number; createdAt: Date; [key: string]: any }> = [
                    ...botHistory.map((item, idx) => {
                        const plain = item.get({ plain: true }) as any;
                        return {
                            ...plain,
                            id: `bot_${plain.id}`, // Уникальный ID для bot истории
                            originalId: plain.id,
                            createdAt: plain.createdAt || new Date(),
                            source: 'bot' as const
                        };
                    }),
                    ...webHistory.map((item, idx) => {
                        const plain = item.get({ plain: true }) as any;
                        return {
                            id: `web_${plain.id}`, // Уникальный ID для web истории
                            originalId: plain.id,
                            telegram_id: telegramId,
                            url: plain.url,
                            interests: plain.interests || '',
                            sourceType: plain.sourceType,
                            score: plain.score,
                            verdict: plain.verdict,
                            summary: plain.summary,
                            reasoning: plain.reasoning,
                            user_id: profile.user_id || null,
                            createdAt: plain.createdAt || new Date(),
                            updatedAt: plain.updatedAt,
                            source: 'web' as const
                        };
                    })
                ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
                
                // Применяем лимит только если он указан
                const limited = limit && limit > 0 ? combined.slice(0, limit) : combined;
                console.log(`[BotHistory] Combined ${limited.length} records${limit ? ` (limited to ${limit})` : ' (no limit)'}`);
                return limited;
            }
            
            // Для guest пользователей только BotAnalysisHistory
            const findAllOptions: any = {
                where: { telegram_id: telegramId },
                order: [['createdAt', 'DESC']],
            };
            if (limit && limit > 0) {
                findAllOptions.limit = limit;
            }
            const guestHistory = await BotAnalysisHistory.findAll(findAllOptions);
            
            console.log(`[BotHistory] Loaded ${guestHistory.length} records for guest user ${telegramId}`);
            return guestHistory.map((item, idx) => {
                const plain = item.get({ plain: true });
                return {
                    ...plain,
                    id: `bot_${plain.id}`, // Уникальный ID для совместимости
                    originalId: plain.id,
                    source: 'bot' as const
                };
            });
        } catch (error) {
            console.error('[BotHistory] Error loading history:', error);
            return [];
        }
    }

    async deleteOldHistory(daysOld: number = 30): Promise<number> {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysOld);
        const result = await BotAnalysisHistory.destroy({
            where: {
                // @ts-ignore - createdAt exists as readonly property
                createdAt: {
                    [Op.lt]: cutoffDate,
                },
            },
        });
        return result;
    }
}

export default new BotUserService();

