import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';
import User from './User';

interface UserInterestLevelAttributes {
    id: number;
    userId: number;
    interest: string;
    level: 'beginner' | 'intermediate' | 'advanced' | 'expert';
}

interface UserInterestLevelCreationAttributes extends Optional<UserInterestLevelAttributes, 'id'> {}

class UserInterestLevel extends Model<UserInterestLevelAttributes, UserInterestLevelCreationAttributes> implements UserInterestLevelAttributes {
    public id!: number;
    public userId!: number;
    public interest!: string;
    public level!: 'beginner' | 'intermediate' | 'advanced' | 'expert';

    public readonly createdAt!: Date;
    public readonly updatedAt!: Date;
}

UserInterestLevel.init(
    {
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
        level: {
            type: DataTypes.ENUM('beginner', 'intermediate', 'advanced', 'expert'),
            allowNull: false,
            defaultValue: 'beginner',
        },
    },
    {
        tableName: 'user_interest_levels',
        sequelize,
        timestamps: true,
        indexes: [
            {
                unique: true,
                fields: ['userId', 'interest'],
            },
        ],
    }
);

User.hasMany(UserInterestLevel, { foreignKey: 'userId' });

export default UserInterestLevel;

