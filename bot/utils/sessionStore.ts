type PendingAction =
    | { type: 'add_interest'; interests?: string[] }
    | { type: 'set_interest_level'; interest: string }
    | { type: 'analyze_url' };

const sessions = new Map<string, PendingAction>();

export const setPendingAction = (telegramId: string, action: PendingAction) => {
    sessions.set(telegramId, action);
};

export const getPendingAction = (telegramId: string): PendingAction | undefined => {
    return sessions.get(telegramId);
};

export const clearPendingAction = (telegramId: string) => {
    sessions.delete(telegramId);
};

