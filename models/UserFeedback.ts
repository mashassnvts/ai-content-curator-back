import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../config/database';
import User from './User';
import AnalysisHistory from './AnalysisHistory';

interface UserFeedbackAttributes {
    id: number;
    userId: number;
    analysisHistoryId: number;
    url: string;
    userInterests: string;
    aiVerdict: string;
    aiReasoning: string;
    aiAssessmentWasCorrect: boolean;
    userComment?: string;
}

interface UserFeedbackCreationAttributes extends Optional<UserFeedbackAttributes, 'id'> {}

class UserFeedback extends Model<UserFeedbackAttributes, UserFeedbackCreationAttributes> implements UserFeedbackAttributes {
    public id!: number;
    public userId!: number;
    public analysisHistoryId!: number;
    public url!: string;
    public userInterests!: string;
    public aiVerdict!: string;
    public aiReasoning!: string;
    public aiAssessmentWasCorrect!: boolean;
    public userComment?: string;

    public readonly createdAt!: Date;
    public readonly updatedAt!: Date;
}

UserFeedback.init({
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
    analysisHistoryId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: AnalysisHistory,
            key: 'id',
        },
    },
    url: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    userInterests: {
        type: DataTypes.TEXT,
        allowNull: false,
    },
    aiVerdict: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    aiReasoning: {
        type: DataTypes.TEXT,
        allowNull: false,
    },
    aiAssessmentWasCorrect: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
    },
    userComment: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
}, {
    tableName: 'user_feedback',
    sequelize,
});

User.hasMany(UserFeedback, { foreignKey: 'userId' });
UserFeedback.belongsTo(User, { foreignKey: 'userId' });

AnalysisHistory.hasOne(UserFeedback, { foreignKey: 'analysisHistoryId' });
UserFeedback.belongsTo(AnalysisHistory, { foreignKey: 'analysisHistoryId' });

export default UserFeedback;
