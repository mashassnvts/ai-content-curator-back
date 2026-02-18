import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

interface EmailOptions {
    to: string;
    subject: string;
    html: string;
    text?: string;
}

class EmailService {
    private transporter: nodemailer.Transporter | null = null;

    constructor() {
        this.initializeTransporter();
    }

    private initializeTransporter(): void {
        // Проверяем наличие конфигурации email
        const emailHost = process.env.EMAIL_HOST;
        const emailPort = process.env.EMAIL_PORT;
        const emailUser = process.env.EMAIL_USER;
        const emailPassword = process.env.EMAIL_PASSWORD;
        const emailFrom = process.env.EMAIL_FROM || emailUser || 'noreply@ai-content-curator.com';

        // Если нет конфигурации - используем тестовый режим (для разработки)
        if (!emailHost || !emailUser || !emailPassword) {
            console.warn('⚠️ Email configuration not found. Using test mode (emails will be logged, not sent).');
            console.warn('💡 Set EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASSWORD, EMAIL_FROM in .env to enable email sending.');
            
            // Создаем тестовый transporter (для разработки)
            this.transporter = nodemailer.createTransporter({
                host: 'smtp.ethereal.email',
                port: 587,
                secure: false,
                auth: {
                    user: 'test@ethereal.email',
                    pass: 'test'
                }
            });
            return;
        }

        // Создаем реальный transporter
        const port = emailPort ? parseInt(emailPort, 10) : 587;
        const secure = port === 465;

        this.transporter = nodemailer.createTransporter({
            host: emailHost,
            port: port,
            secure: secure,
            auth: {
                user: emailUser,
                pass: emailPassword,
            },
            tls: {
                rejectUnauthorized: false, // Для самоподписанных сертификатов
            },
        });

        console.log(`✅ Email service initialized (${emailHost}:${port})`);
    }

    /**
     * Отправляет email
     */
    async sendEmail(options: EmailOptions): Promise<boolean> {
        if (!this.transporter) {
            console.error('❌ Email transporter not initialized');
            return false;
        }

        const emailFrom = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'noreply@ai-content-curator.com';

        try {
            const info = await this.transporter.sendMail({
                from: `"AI Content Curator" <${emailFrom}>`,
                to: options.to,
                subject: options.subject,
                text: options.text || options.html.replace(/<[^>]*>/g, ''), // Убираем HTML теги для текстовой версии
                html: options.html,
            });

            console.log(`✅ Email sent successfully to ${options.to}`);
            console.log(`   Message ID: ${info.messageId}`);
            
            // Если используется тестовый режим (ethereal.email), выводим preview URL
            if (info.messageId && nodemailer.getTestMessageUrl) {
                const previewUrl = nodemailer.getTestMessageUrl(info);
                if (previewUrl) {
                    console.log(`   Preview URL: ${previewUrl}`);
                }
            }

            return true;
        } catch (error: any) {
            console.error(`❌ Failed to send email to ${options.to}:`, error.message);
            if (error.stack) {
                console.error('   Stack:', error.stack);
            }
            return false;
        }
    }

    /**
     * Отправляет письмо для восстановления пароля
     */
    async sendPasswordResetEmail(email: string, resetToken: string, resetUrl: string): Promise<boolean> {
        const subject = 'Восстановление пароля - AI Content Curator';
        
        // Определяем базовый URL для ссылки восстановления
        const baseUrl = process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:3000';
        const fullResetUrl = `${baseUrl}/reset-password?token=${resetToken}`;

        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Восстановление пароля</title>
            </head>
            <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="background: linear-gradient(135deg, #4ECDC4 0%, #95E1D3 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                    <h1 style="color: white; margin: 0;">AI Content Curator</h1>
                </div>
                <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
                    <h2 style="color: #1E293B; margin-top: 0;">Восстановление пароля</h2>
                    <p>Вы запросили восстановление пароля для вашего аккаунта.</p>
                    <p>Для сброса пароля нажмите на кнопку ниже:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${fullResetUrl}" 
                           style="display: inline-block; background: linear-gradient(135deg, #4ECDC4 0%, #95E1D3 100%); 
                                  color: white; padding: 12px 30px; text-decoration: none; 
                                  border-radius: 5px; font-weight: 600;">
                            Восстановить пароль
                        </a>
                    </div>
                    <p style="color: #666; font-size: 14px;">
                        Или скопируйте и вставьте эту ссылку в браузер:<br>
                        <a href="${fullResetUrl}" style="color: #4ECDC4; word-break: break-all;">${fullResetUrl}</a>
                    </p>
                    <p style="color: #999; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd;">
                        <strong>Важно:</strong> Эта ссылка действительна в течение 1 часа. Если вы не запрашивали восстановление пароля, просто проигнорируйте это письмо.
                    </p>
                </div>
            </body>
            </html>
        `;

        const text = `
Восстановление пароля - AI Content Curator

Вы запросили восстановление пароля для вашего аккаунта.

Для сброса пароля перейдите по ссылке:
${fullResetUrl}

Важно: Эта ссылка действительна в течение 1 часа. Если вы не запрашивали восстановление пароля, просто проигнорируйте это письмо.
        `;

        return await this.sendEmail({
            to: email,
            subject: subject,
            html: html,
            text: text,
        });
    }
}

export default new EmailService();
