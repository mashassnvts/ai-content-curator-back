import AnalysisHistory from '../models/AnalysisHistory';
import BotAnalysisHistory from '../models/BotAnalysisHistory';
import UserInterest from '../models/UserInterest';
import { Op } from 'sequelize';

/**
 * Сервис для автоочистки истории по неактивным интересам
 */
class HistoryCleanupService {
    // Количество дней неактивности, после которого история удаляется
    private readonly INACTIVE_DAYS = parseInt(process.env.HISTORY_CLEANUP_DAYS || '90', 10);

    /**
     * Обновляет lastUsedAt для интересов, которые использовались в анализе
     */
    async updateInterestUsage(userId: number, interests: string[]): Promise<void> {
        try {
            const interestNames = interests.map(i => i.trim().toLowerCase());
            const now = new Date();

            // Находим все интересы пользователя
            const userInterests = await UserInterest.findAll({
                where: { userId }
            });

            // Обновляем lastUsedAt для совпадающих интересов
            const updatePromises = userInterests
                .filter(ui => {
                    const uiLower = ui.interest.toLowerCase();
                    return interestNames.some(inName => 
                        uiLower === inName || 
                        uiLower.includes(inName) || 
                        inName.includes(uiLower)
                    );
                })
                .map(interest => {
                    return interest.update({ lastUsedAt: now });
                });

            await Promise.all(updatePromises);
        } catch (error) {
            console.error('Error updating interest usage:', error);
            // Не прерываем выполнение при ошибке обновления
        }
    }

    /**
     * Находит неактивные интересы (не использовались более INACTIVE_DAYS дней)
     */
    private async getInactiveInterests(): Promise<Array<{ userId: number; interest: string }>> {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - this.INACTIVE_DAYS);

        const inactiveInterests = await UserInterest.findAll({
            where: {
                [Op.or]: [
                    { lastUsedAt: { [Op.lt]: cutoffDate } },
                    { 
                        lastUsedAt: null,
                        // @ts-ignore - createdAt exists as readonly property
                        createdAt: { [Op.lt]: cutoffDate }
                    }
                ]
            },
            attributes: ['userId', 'interest']
        });

        return inactiveInterests.map(ui => ({
            userId: ui.userId,
            interest: ui.interest
        }));
    }

    /**
     * Удаляет записи истории, связанные с неактивными интересами
     */
    async cleanupInactiveHistory(): Promise<{ deleted: number; usersAffected: number }> {
        try {
            console.log(`🧹 Starting history cleanup for interests inactive more than ${this.INACTIVE_DAYS} days...`);

            const inactiveInterests = await this.getInactiveInterests();
            
            if (inactiveInterests.length === 0) {
                console.log('✅ No inactive interests found. Cleanup skipped.');
                return { deleted: 0, usersAffected: 0 };
            }

            console.log(`Found ${inactiveInterests.length} inactive interests`);

            let totalDeleted = 0;
            const affectedUsers = new Set<number>();

            // Группируем по пользователям для эффективной обработки
            const interestsByUser = new Map<number, string[]>();
            inactiveInterests.forEach(({ userId, interest }) => {
                if (!interestsByUser.has(userId)) {
                    interestsByUser.set(userId, []);
                }
                interestsByUser.get(userId)!.push(interest);
            });

            // Обрабатываем каждого пользователя
            for (const [userId, interests] of interestsByUser.entries()) {
                try {
                    // Создаем паттерны для поиска интересов в истории
                    const interestPatterns = interests.map(interest => 
                        new RegExp(`\\b${interest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
                    );

                    // Находим записи истории, где упоминаются неактивные интересы
                    const historyEntries = await AnalysisHistory.findAll({
                        where: { userId }
                    });

                    const entriesToDelete = historyEntries.filter(entry => {
                        if (!entry.interests) return false;
                        const entryInterests = entry.interests.toLowerCase();
                        return interestPatterns.some(pattern => pattern.test(entryInterests));
                    });

                    if (entriesToDelete.length > 0) {
                        const idsToDelete = entriesToDelete.map(e => e.id);
                        const deleted = await AnalysisHistory.destroy({
                            where: {
                                id: { [Op.in]: idsToDelete }
                            }
                        });

                        totalDeleted += deleted;
                        affectedUsers.add(userId);
                        console.log(`  User ${userId}: Deleted ${deleted} history entries for inactive interests: ${interests.join(', ')}`);
                    }
                } catch (error) {
                    console.error(`Error cleaning up history for user ${userId}:`, error);
                }
            }

            // Также очищаем BotAnalysisHistory для связанных пользователей
            for (const [userId, interests] of interestsByUser.entries()) {
                try {
                    const interestPatterns = interests.map(interest => 
                        new RegExp(`\\b${interest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
                    );

                    const botHistoryEntries = await BotAnalysisHistory.findAll({
                        where: { user_id: userId }
                    });

                    const botEntriesToDelete = botHistoryEntries.filter(entry => {
                        if (!entry.interests) return false;
                        const entryInterests = entry.interests.toLowerCase();
                        return interestPatterns.some(pattern => pattern.test(entryInterests));
                    });

                    if (botEntriesToDelete.length > 0) {
                        const idsToDelete = botEntriesToDelete.map(e => e.id);
                        const deleted = await BotAnalysisHistory.destroy({
                            where: {
                                id: { [Op.in]: idsToDelete }
                            }
                        });

                        totalDeleted += deleted;
                        console.log(`  Bot history for user ${userId}: Deleted ${deleted} entries`);
                    }
                } catch (error) {
                    console.error(`Error cleaning up bot history for user ${userId}:`, error);
                }
            }

            console.log(`✅ Cleanup completed: ${totalDeleted} entries deleted, ${affectedUsers.size} users affected`);
            return { deleted: totalDeleted, usersAffected: affectedUsers.size };
        } catch (error) {
            console.error('❌ Error during history cleanup:', error);
            throw error;
        }
    }

    /**
     * Запускает периодическую очистку истории
     */
    startPeriodicCleanup(intervalHours: number = 24): void {
        console.log(`🔄 Starting periodic history cleanup (every ${intervalHours} hours)`);
        
        // Запускаем сразу при старте
        this.cleanupInactiveHistory().catch(err => {
            console.error('Error in initial cleanup:', err);
        });

        // Затем запускаем периодически
        setInterval(() => {
            this.cleanupInactiveHistory().catch(err => {
                console.error('Error in periodic cleanup:', err);
            });
        }, intervalHours * 60 * 60 * 1000);
    }
}

export default new HistoryCleanupService();

