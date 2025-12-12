import TelegramBot, { CallbackQuery, Message } from 'node-telegram-bot-api';
import botUserService from '../services/bot-user.service';
import { MAIN_MENU_MARKUP, isMenuButton, filterMenuButtons } from '../utils/menu';

export const REMOVE_INTEREST_PREFIX = 'remove_interest_';
export const TOGGLE_INTEREST_PREFIX = 'toggle_interest_';
export const CHANGE_LEVEL_PREFIX = 'change_level_';

export const showInterests = async (bot: TelegramBot, chatId: number, telegramId: string) => {
    const { interests, activeInterests, mode, levels } = await botUserService.getUserInterests(telegramId);

    // Фильтруем кнопки меню из интересов
    const filteredInterests = filterMenuButtons(interests);
    
    // Если были удалены кнопки меню, обновляем список интересов
    if (filteredInterests.length !== interests.length) {
        const removedButtons = interests.filter(i => isMenuButton(i));
        console.log(`[Interests] Removing menu buttons from interests: ${removedButtons.join(', ')}`);
        
        // Удаляем кнопки меню из базы данных
        for (const button of removedButtons) {
            await botUserService.removeInterestByText(telegramId, button);
        }
        
        // Также удаляем кнопки меню из активных интересов
        const filteredActiveInterests = filterMenuButtons(activeInterests);
        if (filteredActiveInterests.length !== activeInterests.length) {
            await botUserService.setActiveInterests(telegramId, filteredActiveInterests);
        }
    }
    
    const levelNames: Record<string, string> = {
        'novice': '🟢 Новичок',
        'amateur': '🟡 Любитель',
        'professional': '🔴 Профессионал'
    };

    if (filteredInterests.length === 0) {
        await bot.sendMessage(
            chatId,
            '📋 У вас пока нет добавленных интересов.\n\nНажмите «➕ Добавить интерес» и отправьте темы, которые вас интересуют.',
            { reply_markup: MAIN_MENU_MARKUP }
        );
        return;
    }
    
    const filteredActiveInterests = filterMenuButtons(activeInterests);
    const activeSet = new Set(filteredActiveInterests);
    const interestsList = filteredInterests.map((interest, idx) => {
        const isActive = activeSet.has(interest);
        const status = isActive ? '✅' : '○';
        const level = levels?.[interest.toLowerCase()];
        const levelText = level ? ` ${levelNames[level] || level}` : '';
        return `${status} ${idx + 1}. ${interest}${levelText}`;
    }).join('\n');

    const activeCount = filteredActiveInterests.length;
    const totalCount = filteredInterests.length;

    await bot.sendMessage(
        chatId,
        `📋 **Ваши интересы (${mode === 'linked' ? '🔗 синхронные' : '🙈 гостевые'}):**\n\n${interestsList}\n\n*Активных: ${activeCount} из ${totalCount}*\n\nНажмите на интерес, чтобы включить/выключить его, или на 📊 чтобы изменить уровень.`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: filteredInterests.map((interest, idx) => {
                    const level = levels?.[interest.toLowerCase()];
                    const levelEmoji = level === 'novice' ? '🟢' : level === 'amateur' ? '🟡' : level === 'professional' ? '🔴' : '⚪';
                    return [
                        {
                            text: `${activeSet.has(interest) ? '✅' : '○'} ${interest}`,
                            callback_data: `${TOGGLE_INTEREST_PREFIX}${idx}`
                        },
                        {
                            text: `📊 ${levelEmoji} Уровень`,
                            callback_data: `${CHANGE_LEVEL_PREFIX}${idx}`
                        }
                    ];
                }).concat([
                    [{ text: '🗑 Удалить интерес', callback_data: 'show_remove_interests' }]
                ])
            },
        }
    );
};

export const SET_LEVEL_PREFIX = 'set_level_';

export const handleAddInterestInput = async (bot: TelegramBot, chatId: number, telegramId: string, interestText: string) => {
    const interest = interestText.trim();
    if (!interest) {
        await bot.sendMessage(chatId, '❌ Пожалуйста, отправьте текст с интересами.', { reply_markup: MAIN_MENU_MARKUP });
        return;
    }

    const interestsToAdd = interest
        .split(',')
        .map((i) => i.trim())
        .filter((i) => i.length > 0)
        .filter((i) => !isMenuButton(i)); // Фильтруем кнопки меню

    if (!interestsToAdd.length) {
        await bot.sendMessage(chatId, '❌ Похоже, интересы не указаны. Попробуйте еще раз.', { reply_markup: MAIN_MENU_MARKUP });
        return;
    }

    // Если один интерес, запрашиваем уровень
    if (interestsToAdd.length === 1) {
        const interestName = interestsToAdd[0];
        const { setPendingAction } = await import('../utils/sessionStore');
        setPendingAction(telegramId, { type: 'set_interest_level', interest: interestName });
        
        const levelKeyboard = {
            inline_keyboard: [
                [
                    { text: '🟢 Новичок', callback_data: `${SET_LEVEL_PREFIX}${interestName}|novice` },
                    { text: '🟡 Любитель', callback_data: `${SET_LEVEL_PREFIX}${interestName}|amateur` }
                ],
                [
                    { text: '🔴 Профессионал', callback_data: `${SET_LEVEL_PREFIX}${interestName}|professional` }
                ],
                [
                    { text: '⏭️ Пропустить (новичок)', callback_data: `${SET_LEVEL_PREFIX}${interestName}|novice|skip` }
                ]
            ]
        };
        
        await bot.sendMessage(
            chatId,
            `📊 Выберите ваш уровень в "${interestName}":\n\n` +
            `🟢 Новичок - только начинаю\n` +
            `🟡 Любитель - есть базовые знания и опыт\n` +
            `🔴 Профессионал - глубокие знания и опыт`,
            { reply_markup: levelKeyboard }
        );
        return;
    }

    // Если несколько интересов, добавляем все с уровнем по умолчанию (novice)
    const { activeInterests } = await botUserService.getUserInterests(telegramId);
    
    for (const interestName of interestsToAdd) {
        await botUserService.addInterest(telegramId, interestName, 'novice');
    }

    // Добавляем новые интересы в активные
    const newActiveInterests = [...activeInterests, ...interestsToAdd];
    await botUserService.setActiveInterests(telegramId, newActiveInterests);

    await bot.sendMessage(
        chatId,
        `✅ Добавлено интересов: ${interestsToAdd.length}\n\n${interestsToAdd.map((i) => `• ${i}`).join('\n')}\n\n` +
        `Все новые интересы автоматически включены.\n` +
        `💡 Уровень установлен: "Новичок" (можно изменить позже через /interests)`,
        { reply_markup: MAIN_MENU_MARKUP }
    );

    await showInterests(bot, chatId, telegramId);
};

export const handleChangeInterestLevel = async (bot: TelegramBot, query: CallbackQuery, index: number) => {
    const chatId = query.message?.chat.id;
    const telegramId = query.from.id.toString();
    
    if (!chatId || Number.isNaN(index)) {
        await bot.answerCallbackQuery(query.id);
        return;
    }

    const { interests, levels } = await botUserService.getUserInterests(telegramId);
    const filteredInterests = filterMenuButtons(interests);
    
    if (index < 0 || index >= filteredInterests.length) {
        await bot.answerCallbackQuery(query.id, { text: 'Интерес не найден' });
        return;
    }

    const interest = filteredInterests[index];
    const currentLevel = levels?.[interest.toLowerCase()] || 'novice';
    
    const levelKeyboard = {
        inline_keyboard: [
            [
                { 
                    text: currentLevel === 'novice' ? '✅ 🟢 Новичок' : '🟢 Новичок', 
                    callback_data: `${SET_LEVEL_PREFIX}${interest}|novice|change` 
                },
                { 
                    text: currentLevel === 'amateur' ? '✅ 🟡 Любитель' : '🟡 Любитель', 
                    callback_data: `${SET_LEVEL_PREFIX}${interest}|amateur|change` 
                }
            ],
            [
                { 
                    text: currentLevel === 'professional' ? '✅ 🔴 Профессионал' : '🔴 Профессионал', 
                    callback_data: `${SET_LEVEL_PREFIX}${interest}|professional|change` 
                }
            ]
        ]
    };
    
    await bot.answerCallbackQuery(query.id);
    
    await bot.sendMessage(
        chatId,
        `📊 Выберите ваш уровень в "${interest}":\n\n` +
        `🟢 Новичок - только начинаю\n` +
        `🟡 Любитель - есть базовые знания и опыт\n` +
        `🔴 Профессионал - глубокие знания и опыт\n\n` +
        `Текущий уровень: ${currentLevel === 'novice' ? '🟢 Новичок' : currentLevel === 'amateur' ? '🟡 Любитель' : '🔴 Профессионал'}`,
        { reply_markup: levelKeyboard }
    );
};

export const handleSetInterestLevelCallback = async (bot: TelegramBot, query: CallbackQuery, interest: string, level: string, skip?: boolean) => {
    const chatId = query.message?.chat.id;
    const telegramId = query.from.id.toString();
    
    if (!chatId) return;

    try {
        await bot.answerCallbackQuery(query.id);
        
        // Добавляем интерес с указанным уровнем
        await botUserService.addInterest(telegramId, interest, level);
        
        // Получаем текущие активные интересы
        const { activeInterests } = await botUserService.getUserInterests(telegramId);
        
        // Добавляем новый интерес в активные
        if (!activeInterests.includes(interest)) {
            const newActiveInterests = [...activeInterests, interest];
            await botUserService.setActiveInterests(telegramId, newActiveInterests);
        }
        
        const { clearPendingAction } = await import('../utils/sessionStore');
        clearPendingAction(telegramId);
        
        const levelNames: Record<string, string> = {
            'novice': '🟢 Новичок',
            'amateur': '🟡 Любитель',
            'professional': '🔴 Профессионал'
        };
        
        // Проверяем, это добавление нового интереса или изменение уровня существующего
        // skip === true означает изменение уровня существующего интереса
        const isChange = skip === true;
        
        if (isChange) {
            // Обновляем уровень существующего интереса
            await botUserService.updateInterestLevel(telegramId, interest, level);
            
            await bot.editMessageText(
                `✅ Уровень для "${interest}" изменен!\n\n` +
                `📊 Новый уровень: ${levelNames[level] || level}`,
                {
                    chat_id: chatId,
                    message_id: query.message?.message_id,
                }
            ).catch(() => {
                bot.sendMessage(chatId, `✅ Уровень для "${interest}" изменен на ${levelNames[level] || level}!`, { reply_markup: MAIN_MENU_MARKUP });
            });
        } else {
            // Добавление нового интереса
            await bot.editMessageText(
                `✅ Интерес "${interest}" добавлен!\n\n` +
                `📊 Ваш уровень: ${levelNames[level] || level}\n` +
                `Интерес автоматически включен.`,
                {
                    chat_id: chatId,
                    message_id: query.message?.message_id,
                }
            ).catch(() => {
                bot.sendMessage(chatId, `✅ Интерес "${interest}" добавлен с уровнем ${levelNames[level] || level}!`, { reply_markup: MAIN_MENU_MARKUP });
            });
        }

        await showInterests(bot, chatId, telegramId);
    } catch (error: any) {
        console.error(`Error handling set level callback: ${error.message}`);
        await bot.sendMessage(chatId, '❌ Произошла ошибка при добавлении интереса.', { reply_markup: MAIN_MENU_MARKUP });
    }
};

export const handleToggleInterestCallback = async (bot: TelegramBot, query: CallbackQuery, index: number) => {
    const chatId = query.message?.chat.id;
    const telegramId = query.from.id.toString();

    if (!chatId || Number.isNaN(index)) {
        await bot.answerCallbackQuery(query.id);
        return;
    }

    const { interests, activeInterests } = await botUserService.getUserInterests(telegramId);
    
    if (index < 0 || index >= interests.length) {
        await bot.answerCallbackQuery(query.id, { text: 'Интерес не найден' });
        return;
    }

    const interest = interests[index];
    const activeSet = new Set(activeInterests);
    
    if (activeSet.has(interest)) {
        // Отключаем интерес
        const newActive = activeInterests.filter(i => i !== interest);
        // Если остался только один активный, не позволяем отключить его
        if (newActive.length === 0 && interests.length > 1) {
            await bot.answerCallbackQuery(query.id, { text: 'Должен быть хотя бы один активный интерес', show_alert: true });
            return;
        }
        await botUserService.setActiveInterests(telegramId, newActive);
        await bot.answerCallbackQuery(query.id, { text: `Интерес "${interest}" отключен` });
    } else {
        // Включаем интерес
        const newActive = [...activeInterests, interest];
        await botUserService.setActiveInterests(telegramId, newActive);
        await bot.answerCallbackQuery(query.id, { text: `Интерес "${interest}" включен` });
    }

    // Обновляем сообщение
    await showInterests(bot, chatId, telegramId);
    if (query.message) {
        await bot.deleteMessage(chatId, query.message.message_id);
    }
};

export const promptRemoveInterest = async (bot: TelegramBot, chatId: number, telegramId: string) => {
    const { interests } = await botUserService.getUserInterests(telegramId);

    if (interests.length === 0) {
        await bot.sendMessage(chatId, '📋 Список интересов пуст — удалять нечего.', { reply_markup: MAIN_MENU_MARKUP });
        return;
    }

    const keyboard = interests.map((interest, idx) => [
        { text: `${idx + 1}. ${interest}`, callback_data: `${REMOVE_INTEREST_PREFIX}${idx}` },
    ]);

    await bot.sendMessage(chatId, 'Выберите интерес для удаления:', {
        reply_markup: { inline_keyboard: keyboard },
    });
};

export const handleRemoveInterestCallback = async (bot: TelegramBot, query: CallbackQuery, index: number) => {
    const chatId = query.message?.chat.id;
    const telegramId = query.from.id.toString();

    if (!chatId || Number.isNaN(index)) {
        await bot.answerCallbackQuery(query.id);
        return;
    }

    // Получаем интересы перед удалением
    const { interests, activeInterests } = await botUserService.getUserInterests(telegramId);
    
    if (index < 0 || index >= interests.length) {
        await bot.answerCallbackQuery(query.id, { text: 'Интерес не найден' });
        return;
    }

    const interestToRemove = interests[index];
    
    // Удаляем интерес
    await botUserService.removeInterest(telegramId, index);
    
    // Удаляем из активных, если он там был
    const newActiveInterests = activeInterests.filter(i => i !== interestToRemove);
    if (newActiveInterests.length !== activeInterests.length) {
        await botUserService.setActiveInterests(telegramId, newActiveInterests);
    }
    
    await bot.answerCallbackQuery(query.id, { text: 'Интерес удален' });

    try {
        await bot.editMessageText('✅ Интерес удален.', {
            chat_id: chatId,
            message_id: query.message?.message_id,
        });
    } catch (error: any) {
        // Если не удалось отредактировать, отправляем новое сообщение
        await bot.sendMessage(chatId, '✅ Интерес удален.', {
            reply_markup: MAIN_MENU_MARKUP,
        });
    }

    await showInterests(bot, chatId, telegramId);
};

export const handleInterests = async (bot: TelegramBot, msg: Message) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id.toString() || '';
    const messageText = msg.text || '';

    if (!telegramId) {
        await bot.sendMessage(chatId, '❌ Не удалось определить ваш Telegram ID.');
        return;
    }

    if (messageText.startsWith('/add_interest')) {
        const interest = messageText.replace('/add_interest', '').trim();
        await handleAddInterestInput(bot, chatId, telegramId, interest);
        return;
    }

    if (messageText.startsWith('/remove_interest')) {
        const indexStr = messageText.replace('/remove_interest', '').trim();
        const index = parseInt(indexStr, 10) - 1;

        if (Number.isNaN(index)) {
            await bot.sendMessage(chatId, '❌ Укажите номер интереса. Пример: /remove_interest 1');
            return;
        }

        await botUserService.removeInterest(telegramId, index);
        await bot.sendMessage(chatId, '✅ Интерес удален.');
        await showInterests(bot, chatId, telegramId);
        return;
    }

    await showInterests(bot, chatId, telegramId);
};