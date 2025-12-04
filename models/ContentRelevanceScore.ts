import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';
import User from './User';

interface ContentRelevanceScoreAttributes {
    id: number;
    userId: number;
    interest: string;
    url: string;
    contentLevel: 'novice' | 'amateur' | 'professional';
    relevanceScore: number;
    explanation: string | null;
}

interface ContentRelevanceScoreCreationAttributes extends Optional<ContentRelevanceScoreAttributes, 'id' | 'explanation'> {}

class ContentRelevanceScore extends Model<ContentRelevanceScoreAttributes, ContentRelevanceScoreCreationAttributes> implements ContentRelevanceScoreAttributes {
    public id!: number;
    public userId!: number;
    public interest!: string;
    public url!: string;
    public contentLevel!: 'novice' | 'amateur' | 'professional';
    public relevanceScore!: number;
    public explanation!: string | null;

    public readonly createdAt!: Date;
    public readonly updatedAt!: Date;
}

ContentRelevanceScore.init(
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
        url: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        contentLevel: {
            type: DataTypes.ENUM('novice', 'amateur', 'professional'),
            allowNull: false,
        },
        relevanceScore: {
            type: DataTypes.INTEGER,
            allowNull: false,
            validate: {
                min: 0,
                max: 100,
            },
        },
        explanation: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
    },
    {
        tableName: 'content_relevance_scores',
        sequelize,
        timestamps: true,
        indexes: [
            {
                unique: true,
                fields: ['userId', 'interest', 'url'],
            },
            {
                fields: ['userId', 'interest'],
            },
        ],
    }
);

User.hasMany(ContentRelevanceScore, { foreignKey: 'userId' });
ContentRelevanceScore.belongsTo(User, { foreignKey: 'userId' });

export default ContentRelevanceScore;

