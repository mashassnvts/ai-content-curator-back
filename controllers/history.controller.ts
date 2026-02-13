import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import AnalysisHistory from '../models/AnalysisHistory';
import { Op } from 'sequelize';

export const getHistory = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        // Получаем всю историю из единой таблицы AnalysisHistory
        // Включаем записи где userId совпадает ИЛИ где есть связанный telegramId
        const history = await AnalysisHistory.findAll({
            where: {
                userId: userId
            },
            order: [['createdAt', 'DESC']],
        });

        // Применяем лимит только если он указан в запросе
        const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
        let result = history.map(item => ({
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

        if (limit && limit > 0) {
            result = result.slice(0, limit);
        }

        return res.status(200).json(result);
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

