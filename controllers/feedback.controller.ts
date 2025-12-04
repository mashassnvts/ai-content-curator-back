import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import UserFeedback from '../models/UserFeedback';
import AnalysisHistory from '../models/AnalysisHistory';

export const addFeedback = async (req: AuthenticatedRequest, res: Response) => {
    const { analysisHistoryId, wasCorrect, comment } = req.body;
    const userId = req.user?.userId;

    if (!userId || !analysisHistoryId || wasCorrect === undefined) {
        return res.status(400).json({ message: 'User ID, Analysis History ID, and correctness status are required.' });
    }

    try {
        // Verify that the analysis history entry belongs to the user
        const historyEntry = await AnalysisHistory.findOne({ where: { id: analysisHistoryId, userId } });
        if (!historyEntry) {
            return res.status(404).json({ message: 'Analysis history not found or does not belong to the user.' });
        }

        // Create or update the feedback
        const [feedback, created] = await UserFeedback.upsert({
            userId,
            analysisHistoryId,
            aiVerdict: historyEntry.verdict,
            aiReasoning: historyEntry.reasoning,
            userInterests: historyEntry.interests,
            url: historyEntry.url,
            aiAssessmentWasCorrect: wasCorrect,
            userComment: comment,
        });

        res.status(201).json(feedback);
    } catch (error: any) {
        console.error('Error adding feedback:', error);
        res.status(500).json({ message: 'Failed to add feedback.', error: error.message });
    }
};
