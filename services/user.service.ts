import User from '../models/User';
import UserInterest from '../models/UserInterest';
import UserInterestLevel from '../models/UserInterestLevel';
import UserFeedback from '../models/UserFeedback'; // Import UserFeedback model
import BotProfile from '../models/BotProfile';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET as string;

class UserService {
    async createUser(userData: { name: string, email: string, password: string }): Promise<User> {
        const { name, email, password } = userData;
        
        // Нормализуем email (приводим к нижнему регистру и убираем пробелы)
        const normalizedEmail = email.trim().toLowerCase();
        
        // Проверяем, существует ли уже пользователь с таким email
        const existingUser = await User.findOne({ where: { email: normalizedEmail } });
        if (existingUser) {
            throw new Error('Пользователь с таким email уже существует. Используйте другой email или войдите в существующий аккаунт.');
        }
        
        const password_hash = await bcrypt.hash(password, 10);
        const newUser = await User.create({ name, email: normalizedEmail, password_hash });
        return newUser;
    }

    async loginUser(credentials: { email: string, password: string }): Promise<string | null> {
        const { email, password } = credentials;
        
        // Нормализуем email (приводим к нижнему регистру и убираем пробелы)
        const normalizedEmail = email.trim().toLowerCase();
        
        const user = await User.findOne({ where: { email: normalizedEmail } });

        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return null;
        }

        // Токен действителен 7 дней
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        return token;
    }

    async getUserById(userId: number): Promise<User | null> {
        const user = await User.findByPk(userId, {
            attributes: ['id', 'name', 'email', 'telegram_id', 'telegram_username', 'telegram_link_code', 'telegram_link_code_expires_at']
        });
        return user;
    }

    async getInterests(userId: number): Promise<UserInterest[]> {
        const interests = await UserInterest.findAll({ where: { userId } });
        return interests;
    }

    async updateInterests(userId: number, interests: string[] | Array<{interest: string, level?: string}>): Promise<UserInterest[]> {
        await UserInterest.destroy({ where: { userId } });
        await UserInterestLevel.destroy({ where: { userId } }); // Удаляем старые уровни
        
        const now = new Date();
        const validLevels = ['novice', 'amateur', 'professional'];
        
        const interestPromises = interests.map(async (item) => {
            // Поддержка двух форматов: строки или объекты
            const interestText = typeof item === 'string' ? item : item.interest;
            const level = typeof item === 'object' && item.level ? item.level : 'novice'; // По умолчанию novice
            
            // Создаем интерес
            const interest = await UserInterest.create({ userId, interest: interestText, lastUsedAt: now });
            
            // Создаем уровень, если указан валидный уровень
            if (validLevels.includes(level)) {
                await UserInterestLevel.findOrCreate({
                    where: {
                        userId,
                        interest: interestText.toLowerCase().trim(),
                    },
                    defaults: {
                        userId,
                        interest: interestText.toLowerCase().trim(),
                        level: level as 'novice' | 'amateur' | 'professional',
                    },
                }).then(([userLevel, created]) => {
                    if (!created) {
                        userLevel.level = level as 'novice' | 'amateur' | 'professional';
                        userLevel.save();
                    }
                });
            }
            
            return interest;
        });
        
        const newInterests = await Promise.all(interestPromises);
        return newInterests;
    }
    
    /**
     * Добавляет один интерес с опциональным уровнем
     */
    async addInterest(userId: number, interest: string, level?: string): Promise<{interest: UserInterest, level?: UserInterestLevel}> {
        const now = new Date();
        const validLevels = ['novice', 'amateur', 'professional'];
        
        // Проверяем, существует ли уже такой интерес
        const existingInterest = await UserInterest.findOne({
            where: {
                userId,
                interest: interest.trim(),
            },
        });
        
        let interestRecord: UserInterest;
        if (existingInterest) {
            // Обновляем lastUsedAt
            existingInterest.lastUsedAt = now;
            await existingInterest.save();
            interestRecord = existingInterest;
        } else {
            // Создаем новый интерес
            interestRecord = await UserInterest.create({
                userId,
                interest: interest.trim(),
                lastUsedAt: now,
            });
        }
        
        // Создаем или обновляем уровень
        let levelRecord: UserInterestLevel | undefined;
        if (level && validLevels.includes(level)) {
            const [userLevel] = await UserInterestLevel.findOrCreate({
                where: {
                    userId,
                    interest: interest.trim().toLowerCase(),
                },
                defaults: {
                    userId,
                    interest: interest.trim().toLowerCase(),
                    level: level as 'novice' | 'amateur' | 'professional',
                },
            });
            
            if (userLevel.level !== level) {
                userLevel.level = level as 'novice' | 'amateur' | 'professional';
                await userLevel.save();
            }
            
            levelRecord = userLevel;
        }
        
        return { interest: interestRecord, level: levelRecord };
    }

    async getUserFeedbackHistory(userId: number): Promise<any[]> {
        const feedbackHistory = await UserFeedback.findAll({
            where: { userId },
            order: [['createdAt', 'DESC']],
            limit: 20 // Limit to the last 20 feedback entries
        });
        return feedbackHistory.map(fb => fb.get({ plain: true }));
    }

    async getActiveInterests(userId: number): Promise<number[]> {
        // Получаем все интересы пользователя
        const interests = await UserInterest.findAll({ where: { userId } });
        
        // Ищем BotProfile для этого пользователя (если есть linked telegram)
        const botProfile = await BotProfile.findOne({ where: { user_id: userId } });
        
        if (botProfile && botProfile.guest_active_interests) {
            // Если есть сохраненные активные интересы в BotProfile
            const savedActive = JSON.parse(botProfile.guest_active_interests);
            // Фильтруем только те ID, которые существуют
            const interestIds = interests.map(i => i.id);
            return savedActive
                .map((interestName: string) => {
                    const interest = interests.find(i => i.interest === interestName);
                    return interest?.id;
                })
                .filter((id: number | undefined): id is number => typeof id === 'number');
        }
        
        // По умолчанию все интересы активны
        return interests.map(i => i.id);
    }

    async setActiveInterests(userId: number, interestIds: number[]): Promise<void> {
        // Получаем интересы пользователя
        const interests = await UserInterest.findAll({ where: { userId } });
        
        // Проверяем, что все ID существуют
        const validIds = interestIds.filter(id => interests.some(i => i.id === id));
        
        // Получаем названия активных интересов
        const activeInterestNames = interests
            .filter(i => validIds.includes(i.id))
            .map(i => i.interest);
        
        // Обновляем BotProfile для синхронизации с ботом
        const botProfile = await BotProfile.findOne({ where: { user_id: userId } });
        if (botProfile) {
            await botProfile.update({ guest_active_interests: JSON.stringify(activeInterestNames) });
        } else {
            // Если BotProfile не существует, создаем его (на случай, если пользователь еще не использовал бота)
            // Но для этого нужен telegram_id, поэтому просто пропускаем
        }
    }
}

export default new UserService();
