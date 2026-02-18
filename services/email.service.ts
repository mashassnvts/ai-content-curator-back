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

        // Диагностика: выводим что было найдено (без пароля)
        console.log('📧 Email configuration check:');
        console.log(`   EMAIL_HOST: ${emailHost ? '✓' : '✗'} ${emailHost || '(not set)'}`);
        console.log(`   EMAIL_PORT: ${emailPort ? '✓' : '✗'} ${emailPort || '(not set)'}`);
        console.log(`   EMAIL_USER: ${emailUser ? '✓' : '✗'} ${emailUser || '(not set)'}`);
        console.log(`   EMAIL_PASSWORD: ${emailPassword ? '✓ (set)' : '✗ (not set)'}`);
        console.log(`   EMAIL_FROM: ${emailFrom || '(not set)'}`);

        // Если нет конфигурации - используем тестовый режим (для разработки)
        if (!emailHost || !emailUser || !emailPassword) {
            console.warn('⚠️ Email configuration not found. Using test mode (emails will be logged, not sent).');
            console.warn('💡 Set EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASSWORD, EMAIL_FROM in .env to enable email sending.');
            
            // Создаем тестовый transporter (для разработки)
            this.transporter = nodemailer.createTransport({
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

        // Убираем кавычки и пробелы из значений, если они есть
        const cleanHost = emailHost.replace(/^["'\s]+|["'\s]+$/g, '');
        const cleanUser = emailUser.replace(/^["'\s]+|["'\s]+$/g, '');
        const cleanPassword = emailPassword.replace(/^["'\s]+|["'\s]+$/g, '');

        // Проверяем формат пароля (Gmail App Password должен быть без пробелов)
        if (cleanPassword.includes(' ') && cleanHost.includes('gmail')) {
            console.warn('⚠️ Warning: Gmail App Password contains spaces. App Passwords should not have spaces.');
            console.warn('   Make sure you copied the App Password correctly from Google Account settings.');
        }

        console.log(`📧 Initializing email transporter: ${cleanHost}:${port} (secure: ${secure})`);
        console.log(`   User: ${cleanUser}`);

        this.transporter = nodemailer.createTransport({
            host: cleanHost,
            port: port,
            secure: secure,
            auth: {
                user: cleanUser,
                pass: cleanPassword,
            },
            tls: {
                rejectUnauthorized: false, // Для самоподписанных сертификатов
            },
            // Дополнительные опции для Gmail
            ...(cleanHost.includes('gmail') && {
                service: 'gmail', // Используем service вместо host для Gmail
            }),
        });

        // Проверяем подключение при инициализации (асинхронно, не блокируем запуск)
        if (this.transporter) {
            this.transporter.verify((error: any, success: any) => {
                if (error) {
                    console.error('❌ Email service verification failed:', error.message);
                    if (error.code) {
                        console.error(`   Error code: ${error.code}`);
                    }
                    console.error('   Check your EMAIL_HOST, EMAIL_PORT, EMAIL_USER, and EMAIL_PASSWORD settings');
                    
                    // Специфичные подсказки для Gmail
                    if (cleanHost.includes('gmail')) {
                        console.error('💡 Gmail troubleshooting:');
                        console.error('   1. Make sure you are using an App Password (not your regular password)');
                        console.error('   2. Enable 2-Step Verification: https://myaccount.google.com/security');
                        console.error('   3. Generate App Password: https://myaccount.google.com/apppasswords');
                        console.error('   4. Check if "Less secure app access" is enabled (if using regular password)');
                        if (error.code === 'EAUTH') {
                            console.error('   5. Authentication failed - double-check your App Password');
                        }
                    }
                } else {
                    console.log(`✅ Email service initialized and verified (${cleanHost}:${port})`);
                }
            });
        }
    }

    /**
     * Отправляет email
     */
    async sendEmail(options: EmailOptions): Promise<boolean> {
        if (!this.transporter) {
            console.error('❌ Email transporter not initialized');
            console.error('   Attempting to reinitialize...');
            this.initializeTransporter();
            if (!this.transporter) {
                console.error('   Failed to initialize transporter');
                return false;
            }
        }

        let emailFrom = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'noreply@ai-content-curator.com';
        // Убираем кавычки и пробелы
        emailFrom = emailFrom.replace(/^["'\s]+|["'\s]+$/g, '');

        try {
            console.log(`📧 Attempting to send email to ${options.to}...`);
            console.log(`   From: ${emailFrom}`);
            console.log(`   Subject: ${options.subject}`);
            
            // Добавляем таймаут для отправки email (30 секунд)
            const sendPromise = this.transporter.sendMail({
                from: `"AI Content Curator" <${emailFrom}>`,
                to: options.to,
                subject: options.subject,
                text: options.text || options.html.replace(/<[^>]*>/g, ''), // Убираем HTML теги для текстовой версии
                html: options.html,
            });

            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Email send timeout after 30 seconds')), 30000);
            });

            const info = await Promise.race([sendPromise, timeoutPromise]) as any;

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
            console.error(`❌ Failed to send email to ${options.to}`);
            console.error(`   Error: ${error.message || 'Unknown error'}`);
            if (error.code) {
                console.error(`   Error code: ${error.code}`);
            }
            if (error.responseCode) {
                console.error(`   Response code: ${error.responseCode}`);
            }
            if (error.response) {
                console.error(`   Response: ${error.response}`);
            }
            if (error.command) {
                console.error(`   Command: ${error.command}`);
            }
            if (error.responseCode === 535 || error.message?.includes('535')) {
                console.error('   This is an authentication error (535)');
            }
            if (error.stack) {
                console.error('   Stack:', error.stack.substring(0, 500)); // Ограничиваем длину стека
            }
            
            // Дополнительные подсказки для Gmail
            if (error.code === 'EAUTH' || error.message?.includes('Invalid login') || error.responseCode === 535) {
                console.error('💡 Gmail authentication error. Make sure:');
                console.error('   1. You are using an App Password (not your regular Gmail password)');
                console.error('   2. Enable 2-Step Verification in your Google Account');
                console.error('   3. Generate App Password: https://myaccount.google.com/apppasswords');
                console.error('   4. Copy the App Password WITHOUT spaces (16 characters, no spaces)');
            }
            
            if (error.message?.includes('timeout')) {
                console.error('💡 Email send timed out. Check your network connection and SMTP server.');
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
