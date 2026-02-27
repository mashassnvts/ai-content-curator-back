import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../config/database';
import User from './User';

interface AppNotificationAttributes {
    id: number;
    userId: number;
    message: string;
    channelUsername: string;
    analyzedCount: number;
    read: boolean;
}

interface AppNotificationCreationAttributes extends Optional<AppNotificationAttributes, 'id' | 'read'> {}

class AppNotification extends Model<AppNotificationAttributes, AppNotificationCreationAttributes> implements AppNotificationAttributes {
    public id!: number;
    public userId!: number;
    public message!: string;
    public channelUsername!: string;
    public analyzedCount!: number;
    public read!: boolean;

    public readonly createdAt!: Date;
    public readonly updatedAt!: Date;
}

AppNotification.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: User, key: 'id' },
        field: 'user_id',
    },
    message: {
        type: DataTypes.TEXT,
        allowNull: false,
    },
    channelUsername: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'channel_username',
    },
    analyzedCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'analyzed_count',
    },
    read: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
}, {
    tableName: 'app_notifications',
    sequelize,
    timestamps: true,
    underscored: true,
    indexes: [{ fields: ['user_id'] }, { fields: ['read'] }],
});

User.hasMany(AppNotification, { foreignKey: 'userId' });
AppNotification.belongsTo(User, { foreignKey: 'userId' });

export default AppNotification;
