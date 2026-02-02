import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../config/database';
import TelegramChannel from './TelegramChannel';
import AnalysisHistory from './AnalysisHistory';

interface TelegramChannelPostAttributes {
    id: number;
    channelId: number;
    messageId: number; // ID сообщения в Telegram
    postUrl?: string | null; // URL поста (если есть)
    postText?: string | null; // Текст поста
    analysisHistoryId?: number | null; // Связь с анализом
}

interface TelegramChannelPostCreationAttributes extends Optional<TelegramChannelPostAttributes, 'id' | 'postUrl' | 'postText' | 'analysisHistoryId'> {}

class TelegramChannelPost extends Model<TelegramChannelPostAttributes, TelegramChannelPostCreationAttributes> implements TelegramChannelPostAttributes {
    public id!: number;
    public channelId!: number;
    public messageId!: number;
    public postUrl?: string | null;
    public postText?: string | null;
    public analysisHistoryId?: number | null;

    public readonly createdAt!: Date;
    public readonly updatedAt!: Date;
}

TelegramChannelPost.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    channelId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: TelegramChannel,
            key: 'id',
        },
        field: 'channel_id',
    },
    messageId: {
        type: DataTypes.BIGINT,
        allowNull: false,
        field: 'message_id',
    },
    postUrl: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'post_url',
    },
    postText: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'post_text',
    },
    analysisHistoryId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: AnalysisHistory,
            key: 'id',
        },
        field: 'analysis_history_id',
    },
}, {
    tableName: 'telegram_channel_posts',
    sequelize,
    timestamps: true,
    underscored: true, // Использовать snake_case для имен столбцов (created_at, updated_at)
    indexes: [
        { fields: ['channel_id', 'message_id'], unique: true },
        { fields: ['channel_id'] },
    ],
});

// Импортируем модели после их определения для избежания циклических зависимостей
TelegramChannelPost.belongsTo(TelegramChannel, { foreignKey: 'channelId' });
TelegramChannelPost.belongsTo(AnalysisHistory, { foreignKey: 'analysisHistoryId' });

export default TelegramChannelPost;
