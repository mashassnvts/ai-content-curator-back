import User from '../models/User';
import UserInterest from '../models/UserInterest';
import UserInterestLevel from '../models/UserInterestLevel';
import UserFeedback from '../models/UserFeedback'; // Import UserFeedback model
import UserSemanticTag from '../models/UserSemanticTag';
import BotProfile from '../models/BotProfile';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import dotenv from 'dotenv';
import emailService from './email.service';

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
        // НЕ удаляем все интересы! Сохраняем isActive для существующих
        const now = new Date();
        const validLevels = ['novice', 'amateur', 'professional'];
        
        // Получаем существующие интересы с их isActive
        const existingInterests = await UserInterest.findAll({ where: { userId } });
        const existingInterestsMap = new Map<string, UserInterest>();
        existingInterests.forEach(interest => {
            existingInterestsMap.set(interest.interest.toLowerCase().trim(), interest);
        });
        
        // Определяем какие интересы нужно удалить (те что не в новом списке)
        const newInterestNames = interests.map(item => {
            const interestText = typeof item === 'string' ? item : item.interest;
            return interestText.toLowerCase().trim();
        });
        const toDelete = existingInterests.filter(interest => 
            !newInterestNames.includes(interest.interest.toLowerCase().trim())
        );
        
        // Удаляем только те интересы, которых нет в новом списке
        if (toDelete.length > 0) {
            await UserInterest.destroy({ 
                where: { 
                    userId,
                    id: toDelete.map(i => i.id)
                } 
            });
            // Удаляем уровни для удаленных интересов
            await UserInterestLevel.destroy({
                where: {
                    userId,
                    interest: toDelete.map(i => i.interest.toLowerCase().trim())
                }
            });
        }
        
        // Обновляем или создаем интересы, сохраняя isActive для существующих
        const interestPromises = interests.map(async (item) => {
            const interestText = typeof item === 'string' ? item : item.interest;
            const level = typeof item === 'object' && item.level ? item.level : 'novice';
            const interestKey = interestText.toLowerCase().trim();
            
            // Проверяем существует ли интерес
            const existing = existingInterestsMap.get(interestKey);
            let interestRecord: UserInterest;
            
            if (existing) {
                // Обновляем существующий - СОХРАНЯЕМ isActive!
                existing.lastUsedAt = now;
                await existing.save();
                interestRecord = existing;
            } else {
                // Создаем новый с isActive=true
                interestRecord = await UserInterest.create({ 
                    userId, 
                    interest: interestText, 
                    isActive: true, 
                    lastUsedAt: now 
                });
            }
            
            // Обновляем или создаем уровень
            if (validLevels.includes(level)) {
                await UserInterestLevel.findOrCreate({
                    where: {
                        userId,
                        interest: interestKey,
                    },
                    defaults: {
                        userId,
                        interest: interestKey,
                        level: level as 'novice' | 'amateur' | 'professional',
                    },
                }).then(([userLevel, created]) => {
                    if (!created) {
                        userLevel.level = level as 'novice' | 'amateur' | 'professional';
                        userLevel.save();
                    }
                });
            }
            
            return interestRecord;
        });
        
        const updatedInterests = await Promise.all(interestPromises);
        return updatedInterests;
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
            // Обновляем lastUsedAt, сохраняем isActive (если не установлен - ставим true)
            existingInterest.lastUsedAt = now;
            if (existingInterest.isActive === undefined || existingInterest.isActive === null) {
                existingInterest.isActive = true;
            }
            await existingInterest.save();
            interestRecord = existingInterest;
        } else {
            // Создаем новый интерес
            interestRecord = await UserInterest.create({
                userId,
                interest: interest.trim(),
                isActive: true,
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
        // Получаем только активные интересы пользователя из БД
        const activeInterests = await UserInterest.findAll({ 
            where: { 
                userId,
                isActive: true 
            } 
        });
        
        return activeInterests.map(i => i.id);
    }

    async setActiveInterests(userId: number, interestIds: number[]): Promise<void> {
        // Получаем все интересы пользователя
        const allInterests = await UserInterest.findAll({ where: { userId } });
        
        // Обновляем статус is_active для каждого интереса
        await Promise.all(
            allInterests.map(interest => 
                interest.update({ 
                    isActive: interestIds.includes(interest.id) 
                })
            )
        );
    }

    /**
     * Получает семантические теги пользователя (для "облака смыслов")
     * @param userId - ID пользователя
     * @param options - Опции для фильтрации и сортировки
     * @param options.limit - Максимальное количество тегов (по умолчанию без ограничений)
     * @param options.sortBy - Способ сортировки: 'weight' (по весу) или 'date' (по дате использования)
     * @returns Массив семантических тегов пользователя
     */
    async getSemanticTags(
        userId: number, 
        options?: { limit?: number; sortBy?: 'weight' | 'date' }
    ): Promise<UserSemanticTag[]> {
        const orderBy = options?.sortBy === 'date' 
            ? [['lastUsedAt', 'DESC'], ['weight', 'DESC']]
            : [['weight', 'DESC'], ['lastUsedAt', 'DESC']];
        
        const queryOptions: any = {
            where: { userId },
            order: orderBy,
        };
        
        if (options?.limit && options.limit > 0) {
            queryOptions.limit = options.limit;
        }
        
        const tags = await UserSemanticTag.findAll(queryOptions);
        return tags;
    }

    /**
     * Удаляет семантический тег пользователя
     * @param userId - ID пользователя
     * @param tagId - ID тега для удаления
     * @returns true если тег был удален, false если не найден
     */
    async deleteSemanticTag(userId: number, tagId: number): Promise<boolean> {
        const tag = await UserSemanticTag.findOne({
            where: {
                id: tagId,
                userId: userId // Проверяем, что тег принадлежит пользователю
            }
        });

        if (!tag) {
            return false;
        }

        await tag.destroy();
        return true;
    }

    /**
     * Запрашивает восстановление пароля для пользователя
     * Генерирует токен восстановления и отправляет email
     */
    async requestPasswordReset(email: string): Promise<boolean> {
        // Нормализуем email
        const normalizedEmail = email.trim().toLowerCase();
        
        // Находим пользователя
        const user = await User.findOne({ where: { email: normalizedEmail } });
        
        // Для безопасности всегда возвращаем true, даже если пользователь не найден
        // Это предотвращает перебор email'ов
        if (!user) {
            console.log(`⚠️ Password reset requested for non-existent email: ${normalizedEmail}`);
            return true;
        }

        // Генерируем криптографически безопасный токен
        const resetToken = crypto.randomBytes(32).toString('hex');
        
        // Устанавливаем время истечения токена (1 час)
        const resetExpires = new Date();
        resetExpires.setHours(resetExpires.getHours() + 1);

        // Сохраняем токен и время истечения в БД
        await user.update({
            password_reset_token: resetToken,
            password_reset_expires_at: resetExpires,
        });

        console.log(`✅ Password reset token generated for user: ${normalizedEmail}`);

        // Отправляем email с токеном восстановления
        const emailSent = await emailService.sendPasswordResetEmail(
            normalizedEmail,
            resetToken,
            '' // URL будет сформирован в email.service
        );

        if (!emailSent) {
            console.error(`❌ Failed to send password reset email to ${normalizedEmail}`);
            // Не удаляем токен, если email не отправлен - пользователь может попробовать еще раз
        }

        return true; // Всегда возвращаем true для безопасности
    }

    /**
     * Сбрасывает пароль пользователя по токену восстановления
     */
    async resetPassword(token: string, newPassword: string): Promise<{ success: boolean; message: string }> {
        // Находим пользователя по токену восстановления
        const user = await User.findOne({
            where: {
                password_reset_token: token,
            },
        });

        if (!user) {
            return {
                success: false,
                message: 'Неверный или истекший токен восстановления пароля.',
            };
        }

        // Проверяем, не истек ли токен
        if (!user.password_reset_expires_at || user.password_reset_expires_at < new Date()) {
            // Очищаем токен
            await user.update({
                password_reset_token: null,
                password_reset_expires_at: null,
            });
            return {
                success: false,
                message: 'Токен восстановления пароля истек. Запросите новый.',
            };
        }

        // Валидация нового пароля
        if (!newPassword || newPassword.length < 6) {
            return {
                success: false,
                message: 'Пароль должен содержать минимум 6 символов.',
            };
        }

        // Хешируем новый пароль
        const password_hash = await bcrypt.hash(newPassword, 10);

        // Обновляем пароль и очищаем токен восстановления
        await user.update({
            password_hash: password_hash,
            password_reset_token: null,
            password_reset_expires_at: null,
        });

        console.log(`✅ Password reset successful for user: ${user.email}`);

        return {
            success: true,
            message: 'Пароль успешно изменен.',
        };
    }
}

export default new UserService();
