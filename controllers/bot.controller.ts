import { Request, Response } from 'express';
import crypto from 'crypto';
import User from '../models/User';
import BotProfile from '../models/BotProfile';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

const LINK_CODE_TTL_MS = 10 * 60 * 1000; // 10 минут
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;

class BotController {
    async generateLinkCode(req: AuthenticatedRequest, res: Response) {
        const userId = req.user?.userId;

        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const user = await User.findByPk(userId);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const code = crypto.randomBytes(3).toString('hex').toUpperCase();
        const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);

        await user.update({
            telegram_link_code: code,
            telegram_link_code_expires_at: expiresAt,
        });

        return res.json({
            code,
            expiresAt,
            startLink: TELEGRAM_BOT_USERNAME
                ? `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${code}`
                : null,
        });
    }

    async linkTelegram(req: Request, res: Response) {
        const { code, telegramId, telegramUsername, telegramChatId } = req.body || {};

        if (!code || !telegramId) {
            return res.status(400).json({ message: 'Code and telegramId are required.' });
        }

        const user = await User.findOne({ where: { telegram_link_code: code } });

        if (!user) {
            return res.status(400).json({ message: 'Invalid or expired code.' });
        }

        if (user.telegram_link_code_expires_at && user.telegram_link_code_expires_at < new Date()) {
            return res.status(400).json({ message: 'Link code has expired. Please generate a new one.' });
        }

        const existingTelegramUser = await User.findOne({
            where: { telegram_id: telegramId },
        });

        if (existingTelegramUser && existingTelegramUser.id !== user.id) {
            return res.status(400).json({
                message: 'Этот Telegram уже привязан к другому аккаунту. Сначала отвяжите его.',
            });
        }

        await user.update({
            telegram_id: telegramId.toString(),
            telegram_username: telegramUsername || null,
            telegram_chat_id: telegramChatId?.toString() || null,
            telegram_link_code: null,
            telegram_link_code_expires_at: null,
        });

        await BotProfile.upsert({
            telegram_id: telegramId.toString(),
            telegram_username: telegramUsername || null,
            telegram_chat_id: telegramChatId?.toString() || null,
            mode: 'linked',
            user_id: user.id,
        });

        return res.json({
            message: 'Telegram успешно привязан к аккаунту.',
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
            },
        });
    }

    async unlinkTelegram(req: AuthenticatedRequest, res: Response) {
        const userId = req.user?.userId;

        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const user = await User.findByPk(userId);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const previousTelegramId = user.telegram_id;

        await user.update({
            telegram_id: null,
            telegram_username: null,
            telegram_chat_id: null,
            telegram_link_code: null,
            telegram_link_code_expires_at: null,
        });

        if (previousTelegramId) {
            await BotProfile.update(
                {
                    mode: 'guest',
                    user_id: null,
                },
                { where: { telegram_id: previousTelegramId } }
            );
        }

        return res.json({ message: 'Telegram успешно отвязан.' });
    }

    async getLinkCode(req: AuthenticatedRequest, res: Response) {
        const userId = req.user?.userId;

        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const user = await User.findByPk(userId);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Проверяем, есть ли активный код
        if (user.telegram_link_code && user.telegram_link_code_expires_at) {
            const now = new Date();
            if (user.telegram_link_code_expires_at > now) {
                return res.json({
                    code: user.telegram_link_code,
                    expiresAt: user.telegram_link_code_expires_at,
                    startLink: TELEGRAM_BOT_USERNAME
                        ? `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${user.telegram_link_code}`
                        : null,
                });
            }
        }

        return res.json({ code: null, expiresAt: null, startLink: null });
    }
}

export default new BotController();

