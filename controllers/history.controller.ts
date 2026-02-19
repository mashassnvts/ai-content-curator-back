import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import AnalysisHistory from '../models/AnalysisHistory';
import { Op } from 'sequelize';
import { extractThemes, clearUserTagsCache } from '../services/semantic.service';
import UserSemanticTag from '../models/UserSemanticTag';

export const getHistory = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        // Пагинация: получаем параметры из query string
        const page = parseInt(req.query.page as string) || 1; // Страница (по умолчанию 1)
        const limit = parseInt(req.query.limit as string) || 20; // Записей на странице (по умолчанию 20)
        const offset = (page - 1) * limit; // Смещение для SQL запроса

        // Используем findAndCountAll для получения данных И общего количества записей
        // Это позволяет загружать только нужную страницу из БД, а не все записи
        const { count, rows: history } = await AnalysisHistory.findAndCountAll({
            where: {
                userId: userId
            },
            order: [['createdAt', 'DESC']],
            limit: limit, // Загружаем только нужное количество записей
            offset: offset, // Пропускаем записи предыдущих страниц
        });

        // Преобразуем данные в нужный формат
        const result = history.map(item => ({
            id: item.id,
            url: item.url,
            interests: item.interests,
            sourceType: item.sourceType,
            score: item.score,
            verdict: item.verdict,
            summary: item.summary,
            reasoning: item.reasoning,
            originalText: item.originalText,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            source: item.telegramId ? 'bot' as const : 'web' as const
        }));

        // Возвращаем данные с метаинформацией о пагинации
        return res.status(200).json({
            data: result, // Массив записей текущей страницы
            pagination: {
                page: page, // Текущая страница
                limit: limit, // Записей на странице
                total: count, // Всего записей в БД
                totalPages: Math.ceil(count / limit), // Всего страниц
            }
        });
    } catch (error) {
        console.error('Error fetching history:', error);
        return res.status(500).json({ message: 'Failed to fetch history', error: error instanceof Error ? error.message : 'Unknown error' });
    }
};

export const getHistoryItem = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const userId = req.user?.userId;
        const historyId = parseInt(req.params.id);

        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const item = await AnalysisHistory.findOne({
            where: { id: historyId, userId },
        });

        if (!item) {
            return res.status(404).json({ message: 'History item not found' });
        }

        return res.status(200).json(item);
    } catch (error) {
        console.error('Error fetching history item:', error);
        return res.status(500).json({ message: 'Failed to fetch history item', error: error instanceof Error ? error.message : 'Unknown error' });
    }
};

export const reanalyzeFromHistory = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const userId = req.user?.userId;
        const historyId = parseInt(req.params.id);

        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const item = await AnalysisHistory.findOne({
            where: { id: historyId, userId },
        });

        if (!item) {
            return res.status(404).json({ message: 'History item not found' });
        }

        return res.status(200).json({
            url: item.url,
            interests: item.interests,
        });
    } catch (error) {
        console.error('Error preparing reanalysis:', error);
        return res.status(500).json({ message: 'Failed to prepare reanalysis', error: error instanceof Error ? error.message : 'Unknown error' });
    }
};

/**
 * Нормализует тему для сравнения (как в semantic.service.ts)
 */
const normalizeTheme = (theme: string): string => {
    let normalized = theme.trim().toLowerCase();
    const stopWords = [' и', ' или', ' для', ' в', ' на', ' с', ' по', ' от', ' к', ' из', ' о', ' об', ' про'];
    for (const stopWord of stopWords) {
        if (normalized.endsWith(stopWord)) {
            normalized = normalized.slice(0, -stopWord.length).trim();
        }
    }
    return normalized.replace(/\s+/g, ' ').trim();
};

/**
 * Удаляет или уменьшает вес семантических тегов, связанных с удаляемой записью истории
 */
const removeSemanticTagsForHistoryItem = async (userId: number, historyItem: AnalysisHistory): Promise<void> => {
    try {
        // Извлекаем темы из контента записи (summary, reasoning, originalText)
        const contentParts: string[] = [];
        if (historyItem.summary) contentParts.push(historyItem.summary);
        if (historyItem.reasoning) contentParts.push(historyItem.reasoning);
        if (historyItem.originalText) contentParts.push(historyItem.originalText);
        
        const content = contentParts.join(' ');
        
        if (!content || content.trim().length < 50) {
            console.log(`ℹ️ [removeSemanticTagsForHistoryItem] Content too short (${content.length} chars), skipping tag removal`);
            return;
        }
        
        // Извлекаем темы из контента
        const themes = await extractThemes(content);
        
        if (themes.length === 0) {
            console.log(`ℹ️ [removeSemanticTagsForHistoryItem] No themes extracted from content`);
            return;
        }
        
        console.log(`🗑️ [removeSemanticTagsForHistoryItem] Extracted ${themes.length} themes from history item ${historyItem.id}`);
        
        // Получаем все теги пользователя
        const userTags = await UserSemanticTag.findAll({
            where: { userId },
            attributes: ['id', 'tag', 'weight']
        });
        
        const WEIGHT_DECREMENT = 0.5; // Уменьшаем вес на 0.5 (как увеличивали при сохранении)
        let removedCount = 0;
        let decreasedCount = 0;
        
        // Для каждой извлеченной темы находим соответствующий тег пользователя
        for (const theme of themes) {
            const normalizedTheme = normalizeTheme(theme);
            
            // Ищем тег пользователя, который совпадает с нормализованной темой
            const matchingTag = userTags.find(tag => {
                const normalizedTag = normalizeTheme(tag.tag);
                return normalizedTag === normalizedTheme || 
                       normalizedTag.includes(normalizedTheme) || 
                       normalizedTheme.includes(normalizedTag);
            });
            
            if (matchingTag) {
                const currentWeight = parseFloat(matchingTag.weight.toString());
                const newWeight = currentWeight - WEIGHT_DECREMENT;
                
                if (newWeight <= 0.5) {
                    // Если вес стал слишком низким, удаляем тег полностью
                    await matchingTag.destroy();
                    removedCount++;
                    console.log(`🗑️ [removeSemanticTagsForHistoryItem] Removed tag "${matchingTag.tag}" (weight was ${currentWeight.toFixed(2)})`);
                } else {
                    // Уменьшаем вес тега
                    matchingTag.weight = newWeight;
                    await matchingTag.save();
                    decreasedCount++;
                    console.log(`📉 [removeSemanticTagsForHistoryItem] Decreased weight for tag "${matchingTag.tag}" from ${currentWeight.toFixed(2)} to ${newWeight.toFixed(2)}`);
                }
            }
        }
        
        // Очищаем кэш тегов пользователя
        clearUserTagsCache(userId);
        
        console.log(`✅ [removeSemanticTagsForHistoryItem] Processed tags: ${removedCount} removed, ${decreasedCount} decreased weight`);
    } catch (error: any) {
        console.error(`❌ [removeSemanticTagsForHistoryItem] Error removing semantic tags: ${error.message}`);
        // Не прерываем удаление записи из-за ошибки удаления тегов
    }
};

export const deleteHistoryItem = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const userId = req.user?.userId;
        const historyId = parseInt(req.params.id);

        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        // Находим запись истории
        const historyItem = await AnalysisHistory.findOne({
            where: { id: historyId, userId },
        });

        if (!historyItem) {
            return res.status(404).json({ message: 'History item not found or does not belong to the user' });
        }

        // Сохраняем данные для удаления тегов (до удаления записи)
        const itemData = {
            summary: historyItem.summary,
            reasoning: historyItem.reasoning,
            originalText: historyItem.originalText,
        };

        // Удаляем запись из истории
        await historyItem.destroy();

        // Удаляем связанные семантические теги
        await removeSemanticTagsForHistoryItem(userId, historyItem as any);

        console.log(`✅ [deleteHistoryItem] Deleted history item ${historyId} for user ${userId}`);

        return res.status(200).json({ 
            message: 'History item deleted successfully',
            deletedId: historyId 
        });
    } catch (error: any) {
        console.error('Error deleting history item:', error);
        return res.status(500).json({ 
            message: 'Failed to delete history item', 
            error: error instanceof Error ? error.message : 'Unknown error' 
        });
    }
};

