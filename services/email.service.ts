import nodemailer from 'nodemailer';
import axios from 'axios';
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
        
        // Проверяем наличие Resend API ключа (рекомендуется для Railway)
        const resendApiKey = process.env.RESEND_API_KEY;

        // Диагностика: выводим что было найдено (без пароля)
        console.log('📧 Email configuration check:');
        console.log(`   RESEND_API_KEY: ${resendApiKey ? '✓ (set) - Using Resend API' : '✗ (not set)'}`);
        console.log(`   EMAIL_HOST: ${emailHost ? '✓' : '✗'} ${emailHost || '(not set)'}`);
        console.log(`   EMAIL_PORT: ${emailPort ? '✓' : '✗'} ${emailPort || '(not set)'}`);
        console.log(`   EMAIL_USER: ${emailUser ? '✓' : '✗'} ${emailUser || '(not set)'}`);
        console.log(`   EMAIL_PASSWORD: ${emailPassword ? '✓ (set)' : '✗ (not set)'}`);
        console.log(`   EMAIL_FROM: ${emailFrom || '(not set)'}`);
        
        // Если есть Resend API ключ - используем его (работает на любом плане Railway)
        if (resendApiKey) {
            console.log('📧 Using Resend API for email delivery (works on all Railway plans)');
            // Transporter будет null, отправка через Resend API
            this.transporter = null;
            return;
        }

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

        // Для Gmail используем специальную конфигурацию
        if (cleanHost.includes('gmail')) {
            console.log('   Using Gmail service configuration');
            this.transporter = nodemailer.createTransport({
                service: 'gmail', // Используем service для Gmail (автоматически настраивает host и port)
                auth: {
                    user: cleanUser,
                    pass: cleanPassword,
                },
                // Увеличиваем таймауты для подключения
                connectionTimeout: 60000, // 60 секунд на подключение
                greetingTimeout: 30000, // 30 секунд на приветствие
                socketTimeout: 60000, // 60 секунд на операции
            });
        } else if (cleanHost.includes('yandex')) {
            // Для Яндекс используем специальную конфигурацию
            console.log('   Using Yandex service configuration');
            // Яндекс требует полный email в качестве username
            const yandexUser = cleanUser.includes('@') ? cleanUser : `${cleanUser}@yandex.ru`;
            
            this.transporter = nodemailer.createTransport({
                host: 'smtp.yandex.ru',
                port: 465, // Яндекс рекомендует порт 465 для SSL
                secure: true, // SSL для порта 465
                auth: {
                    user: yandexUser,
                    pass: cleanPassword,
                },
                tls: {
                    rejectUnauthorized: false,
                },
                // Увеличиваем таймауты для подключения
                connectionTimeout: 60000,
                greetingTimeout: 30000,
                socketTimeout: 60000,
            });
        } else {
            // Для других SMTP серверов используем стандартную конфигурацию
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
                // Увеличиваем таймауты
                connectionTimeout: 60000,
                greetingTimeout: 30000,
                socketTimeout: 60000,
            });
        }

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
                    
                    // Специфичные подсказки для Яндекс
                    if (cleanHost.includes('yandex')) {
                        console.error('💡 Yandex troubleshooting:');
                        console.error('   1. Make sure you are using an App Password (not your regular password)');
                        console.error('   2. Create App Password: https://id.yandex.ru/security/app-passwords');
                        console.error('   3. Enable "Пароли приложений" in Yandex ID settings');
                        console.error('   4. Use full email address (user@yandex.ru) as EMAIL_USER');
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
     * Отправляет email через Resend API (если настроен) или SMTP
     */
    async sendEmail(options: EmailOptions): Promise<boolean> {
        const resendApiKey = process.env.RESEND_API_KEY;
        
        // Если настроен Resend API - используем его (работает на любом плане Railway)
        if (resendApiKey) {
            const resendResult = await this.sendEmailViaResend(options, resendApiKey);
            // Если Resend вернул true - успешно отправлено
            if (resendResult) {
                return true;
            }
            // Если Resend не сработал (например, домен не верифицирован), пробуем SMTP как fallback
            const emailHost = process.env.EMAIL_HOST;
            if (emailHost) {
                console.log('🔄 Resend API failed, attempting SMTP fallback...');
                return await this.sendEmailViaSMTP(options);
            }
            // Если нет SMTP конфигурации, возвращаем false
            console.error('❌ Resend API failed and no SMTP configuration found');
            return false;
        }

        return await this.sendEmailViaSMTP(options);
    }

    /**
     * Отправляет email через Resend API
     */
    private async sendEmailViaResend(options: EmailOptions, apiKey: string): Promise<boolean> {
        const cleanApiKey = apiKey.replace(/^["'\s]+|["'\s]+$/g, '');
        
        // Resend требует верифицированный домен для кастомных email адресов
        // Для тестирования всегда используем onboarding@resend.dev (работает без верификации)
        // Если нужен кастомный домен - верифицируйте его на https://resend.com/domains
        let emailFrom = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'onboarding@resend.dev';
        emailFrom = emailFrom.replace(/^["'\s]+|["'\s]+$/g, '');
        
        // Если используется кастомный домен (не resend.dev/resend.com), переключаемся на тестовый
        if (!emailFrom.includes('@resend.dev') && !emailFrom.includes('@resend.com')) {
            console.warn(`⚠️ Custom domain detected in EMAIL_FROM: ${emailFrom}`);
            console.warn(`   Resend requires domain verification. Using test domain: onboarding@resend.dev`);
            console.warn(`   To use custom domain, verify it at: https://resend.com/domains`);
            emailFrom = 'onboarding@resend.dev';
        }

        try {
            console.log(`📧 Attempting to send email via Resend API to ${options.to}...`);
            console.log(`   From: ${emailFrom}`);
            console.log(`   Subject: ${options.subject}`);

            const response = await axios.post(
                'https://api.resend.com/emails',
                {
                    from: `AI Content Curator <${emailFrom}>`,
                    to: options.to,
                    subject: options.subject,
                    html: options.html,
                    text: options.text || options.html.replace(/<[^>]*>/g, ''),
                },
                {
                    headers: {
                        'Authorization': `Bearer ${cleanApiKey}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 30000, // 30 секунд таймаут
                }
            );

            console.log(`✅ Email sent successfully via Resend API to ${options.to}`);
            console.log(`   Message ID: ${response.data.id}`);
            return true;
        } catch (error: any) {
            console.error(`❌ Failed to send email via Resend API to ${options.to}`);
            if (error.response) {
                console.error(`   Status: ${error.response.status}`);
                console.error(`   Error: ${JSON.stringify(error.response.data)}`);
                
                // Если домен не верифицирован - предлагаем варианты решения
                if (error.response.status === 403 && error.response.data?.message?.includes('domain is not verified')) {
                    console.error('💡 Domain verification error:');
                    console.error('   Option 1: Verify your domain at https://resend.com/domains');
                    console.error('   Option 2: Use SMTP instead (SMTP will be used as fallback automatically)');
                    console.error('   Option 3: Use test domain onboarding@resend.dev (will be used automatically)');
                    // Fallback на SMTP будет выполнен в методе sendEmail
                }
            } else {
                console.error(`   Error: ${error.message}`);
            }
            
            if (error.response?.status === 401 || error.response?.status === 403) {
                console.error('💡 Resend API authentication error. Check your RESEND_API_KEY.');
                console.error('   Get API key: https://resend.com/api-keys');
            }
            
            return false;
        }
    }

    /**
     * Отправляет email через SMTP
     */
    private async sendEmailViaSMTP(options: EmailOptions): Promise<boolean> {

        // Иначе используем SMTP
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
            console.log(`📧 Attempting to send email via SMTP to ${options.to}...`);
            console.log(`   From: ${emailFrom}`);
            console.log(`   Subject: ${options.subject}`);
            
            // Добавляем таймаут для отправки email (60 секунд для Gmail)
            const sendPromise = this.transporter.sendMail({
                from: `"AI Content Curator" <${emailFrom}>`,
                to: options.to,
                subject: options.subject,
                text: options.text || options.html.replace(/<[^>]*>/g, ''), // Убираем HTML теги для текстовой версии
                html: options.html,
            });

            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Email send timeout after 60 seconds')), 60000);
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
     * Отправляет письмо для восстановления пароля (Magic Link)
     */
    async sendPasswordResetEmail(email: string, resetToken: string, resetUrl: string): Promise<boolean> {
        const subject = 'Восстановление пароля - AI Content Curator';

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
                        <a href="${resetUrl}" 
                           style="display: inline-block; background: linear-gradient(135deg, #4ECDC4 0%, #95E1D3 100%); 
                                  color: white; padding: 15px 40px; text-decoration: none; 
                                  border-radius: 5px; font-weight: 600; font-size: 16px;">
                            Восстановить пароль
                        </a>
                    </div>
                    
                    <p style="color: #666; font-size: 14px;">
                        Или скопируйте и вставьте эту ссылку в браузер:<br>
                        <a href="${resetUrl}" style="color: #4ECDC4; word-break: break-all;">${resetUrl}</a>
                    </p>
                    
                    <div style="background: #fff3cd; padding: 15px; border-radius: 5px; border-left: 4px solid #ffc107; margin: 20px 0;">
                        <p style="color: #856404; font-size: 13px; margin: 0;">
                            <strong>⚠️ Важно:</strong> Эта ссылка действительна в течение 30 минут. Если вы не запрашивали восстановление пароля, просто проигнорируйте это письмо.
                        </p>
                    </div>
                    
                    <p style="color: #999; font-size: 12px; margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd;">
                        Если кнопка не работает, скопируйте ссылку выше и вставьте её в адресную строку браузера.
                    </p>
                </div>
            </body>
            </html>
        `;

        const text = `
Восстановление пароля - AI Content Curator

Вы запросили восстановление пароля для вашего аккаунта.

Для сброса пароля перейдите по ссылке:
${resetUrl}

Важно: Эта ссылка действительна в течение 30 минут. Если вы не запрашивали восстановление пароля, просто проигнорируйте это письмо.
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
