import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../config/database';
import User from './User';

interface TelegramChannelAttributes {
    id: number;
    userId: number;
    channelUsername: string; // Например, "ai_news" (без @)
    channelId?: number | null; // ID канала в Telegram (если доступен)
    isActive: boolean; // Активен ли мониторинг канала
    lastCheckedAt?: Date | null; // Когда последний раз проверяли канал
    lastPostMessageId?: number | null; // ID последнего обработанного поста
    checkFrequency: 'daily' | 'weekly'; // Частота проверки
}

interface TelegramChannelCreationAttributes extends Optional<TelegramChannelAttributes, 'id' | 'isActive' | 'checkFrequency'> {}

class TelegramChannel extends Model<TelegramChannelAttributes, TelegramChannelCreationAttributes> implements TelegramChannelAttributes {
    public id!: number;
    public userId!: number;
    public channelUsername!: string;
    public channelId?: number | null;
    public isActive!: boolean;
    public lastCheckedAt?: Date | null;
    public lastPostMessageId?: number | null;
    public checkFrequency!: 'daily' | 'weekly';

    public readonly createdAt!: Date;
    public readonly updatedAt!: Date;
}

TelegramChannel.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: User,
            key: 'id',
        },
        field: 'user_id',
    },
    channelUsername: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'channel_username',
        comment: 'Username канала без @, например "ai_news"',
    },
    channelId: {
        type: DataTypes.BIGINT,
        allowNull: true,
        field: 'channel_id',
        comment: 'ID канала в Telegram (если доступен)',
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        field: 'is_active',
    },
    lastCheckedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'last_checked_at',
    },
    lastPostMessageId: {
        type: DataTypes.BIGINT,
        allowNull: true,
        field: 'last_post_message_id',
    },
    checkFrequency: {
        type: DataTypes.ENUM('daily', 'weekly'),
        allowNull: false,
        defaultValue: 'daily',
        field: 'check_frequency',
    },
}, {
    tableName: 'telegram_channels',
    sequelize,
    timestamps: true,
    underscored: true, // Использовать snake_case для имен столбцов (created_at, updated_at)
    indexes: [
        { fields: ['user_id'] },
        { fields: ['is_active', 'last_checked_at'] },
        { fields: ['user_id', 'channel_username'], unique: true },
    ],
});

User.hasMany(TelegramChannel, { foreignKey: 'userId' });
TelegramChannel.belongsTo(User, { foreignKey: 'userId' });

export default TelegramChannel;
