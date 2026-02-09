import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../config/database';
import User from './User';

interface TelegramChannelAttributes {
    id: number;
    userId: number;
    channelUsername: string;
    channelId?: number | null;
    isActive: boolean;
    lastCheckedAt?: Date | null;
    lastPostMessageId?: number | null;
    checkFrequency: 'daily' | 'weekly';
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
    },
    channelId: {
        type: DataTypes.BIGINT,
        allowNull: true,
        field: 'channel_id',
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
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'daily',
        field: 'check_frequency',
    },
}, {
    tableName: 'telegram_channels',
    sequelize,
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['user_id'] },
        { fields: ['is_active', 'last_checked_at'] },
        { fields: ['user_id', 'channel_username'], unique: true },
    ],
});

User.hasMany(TelegramChannel, { foreignKey: 'userId' });
TelegramChannel.belongsTo(User, { foreignKey: 'userId' });

export default TelegramChannel;
