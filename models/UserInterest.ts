import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../config/database';
import User from './User';

interface UserInterestAttributes {
    id: number;
    userId: number;
    interest: string;
    isActive: boolean;
    lastUsedAt?: Date | null;
}

interface UserInterestCreationAttributes extends Optional<UserInterestAttributes, 'id'> {}

class UserInterest extends Model<UserInterestAttributes, UserInterestCreationAttributes> implements UserInterestAttributes {
    public id!: number;
    public userId!: number;
    public interest!: string;
    public isActive!: boolean;
    public lastUsedAt?: Date | null;

    public readonly createdAt!: Date;
    public readonly updatedAt!: Date;
}

UserInterest.init({
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
    },
    interest: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        field: 'is_active',
    },
    lastUsedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
    },
}, {
    tableName: 'user_interests',
    sequelize,
    timestamps: true,
});

User.hasMany(UserInterest, { foreignKey: 'userId' });
UserInterest.belongsTo(User, { foreignKey: 'userId' });

export default UserInterest;
