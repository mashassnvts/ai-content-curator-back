import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import AdblockerPlugin from 'puppeteer-extra-plugin-adblocker';
import { ExtractedContent } from '../models/content.model';
import play from 'play-dl';
// @ts-ignore - fs-extra types may not be available
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

// Initialize Puppeteer with plugins
puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

class ContentService {
    private _ytDlpCookiesPath: string | null = null;

    /**
     * Возвращает опции cookies для yt-dlp, если настроены.
     * Поддерживает YT_DLP_COOKIES_FILE (путь к файлу) или YT_DLP_COOKIES (base64-содержимое Netscape).
     */
    private getYtDlpCookiesOptions(): { cookies?: string } {
        const cookiesFile = process.env.YT_DLP_COOKIES_FILE;
        if (cookiesFile && fs.pathExistsSync(cookiesFile)) {
            return { cookies: cookiesFile };
        }
        const cookiesB64 = process.env.YT_DLP_COOKIES;
        if (cookiesB64) {
            if (!this._ytDlpCookiesPath) {
                try {
                    const cookiesContent = Buffer.from(cookiesB64, 'base64').toString('utf-8');
                    this._ytDlpCookiesPath = path.join(os.tmpdir(), 'yt-dlp-cookies.txt');
                    fs.writeFileSync(this._ytDlpCookiesPath, cookiesContent);
                } catch (e) {
                    console.warn('⚠️ Failed to init yt-dlp cookies from YT_DLP_COOKIES:', (e as Error).message);
                    return {};
                }
            }
            return { cookies: this._ytDlpCookiesPath };
        }
        return {};
    }

    async extractContentFromUrl(url: string): Promise<ExtractedContent> {
        // Определяем тип URL
        const videoPlatform = this.detectVideoPlatform(url);
        
        if (videoPlatform) {
            console.log(`Processing ${videoPlatform} video: ${url}`);
            
            // ============================================
            // ПРИОРИТЕТ 1: ПОЛУЧЕНИЕ ТРАНСКРИПТА ВИДЕО
            // ============================================
            // Для всех видео сначала пытаемся получить полную расшифровку (транскрипт)
            // Только если ВСЕ методы получения транскрипта провалились, используем метаданные
            
            if (videoPlatform === 'youtube') {
                console.log('🎬 [YouTube] Attempting to extract video transcript (full content)...');
                
                // Метод 1: yt-dlp для извлечения субтитров (с cookies, самый надежный)
                try {
                    const cookiesOpts = this.getYtDlpCookiesOptions();
                    const hasCookies = Object.keys(cookiesOpts).length > 0;
                    console.log(`   [1/3] Trying yt-dlp for transcript extraction${hasCookies ? ' (with cookies)' : ''}...`);
                    const transcriptText = await this.extractTranscriptWithYtDlp(url);
                    if (transcriptText && transcriptText.trim().length > 50) {
                        console.log(`✓✓✓ SUCCESS: Using yt-dlp transcript (${transcriptText.length} chars)`);
                        return { content: transcriptText, sourceType: 'transcript' };
                    }
                } catch (ytDlpError: any) {
                    const errorMsg = ytDlpError.message || 'Unknown error';
                    console.log(`   ⚠️ yt-dlp transcript extraction failed: ${errorMsg}`);
                }
                
                // Метод 2: Библиотека youtube-transcript (быстрый, не требует браузер)
                try {
                    console.log('   [2/3] Trying youtube-transcript library...');
                    const { YoutubeTranscript } = await import('youtube-transcript');
                    
                    // Пробуем сначала без указания языка (автоматический выбор)
                    try {
                        const transcriptItems = await YoutubeTranscript.fetchTranscript(url);
                        const transcriptText = transcriptItems.map(item => item.text).join(' ');
                        
                        if (transcriptText && transcriptText.trim().length > 50) {
                            console.log(`✓✓✓ SUCCESS: Using youtube-transcript library (${transcriptText.length} chars)`);
                            return { content: transcriptText, sourceType: 'transcript' };
                        }
                    } catch (autoError: any) {
                        // Если автоматический выбор не сработал, пробуем с конкретными языками
                        const languages = ['ru', 'en', 'uk'];
                        for (const lang of languages) {
                            try {
                                console.log(`   Trying youtube-transcript with language: ${lang}...`);
                                const transcriptItems = await YoutubeTranscript.fetchTranscript(url, { lang });
                                const transcriptText = transcriptItems.map(item => item.text).join(' ');
                                
                                if (transcriptText && transcriptText.trim().length > 50) {
                                    console.log(`✓✓✓ SUCCESS: Using youtube-transcript library (${lang}, ${transcriptText.length} chars)`);
                                    return { content: transcriptText, sourceType: 'transcript' };
                                }
                            } catch (langError: any) {
                                // Пробуем следующий язык
                                continue;
                            }
                        }
                        throw autoError; // Если все языки провалились, пробрасываем исходную ошибку
                    }
                } catch (youtubeTranscriptError: any) {
                    const errorMsg = youtubeTranscriptError.message || 'Unknown error';
                    if (errorMsg.includes('captcha') || errorMsg.includes('too many requests')) {
                        console.log(`   ⚠️ youtube-transcript failed: YouTube requires captcha or rate limited`);
                    } else {
                        console.log(`   ⚠️ youtube-transcript failed: ${errorMsg}`);
                    }
                }
                
                // Метод 3: Puppeteer (открывает браузер и извлекает транскрипт со страницы) - последний fallback
                try {
                    console.log('   [3/3] Trying Puppeteer (browser-based) for transcript...');
                    // Увеличиваем таймаут до 60 секунд для Puppeteer
                    const transcriptText = await Promise.race([
                        this.getYouTubeTranscript(url),
                        new Promise<string>((_, reject) => 
                            setTimeout(() => reject(new Error('Transcript extraction timeout')), 60000)
                        )
                    ]);
                    
                    if (transcriptText && transcriptText.trim().length > 50) {
                        console.log(`✓✓✓ SUCCESS: Using YouTube transcript (Puppeteer) (${transcriptText.length} chars)`);
                        return { content: transcriptText, sourceType: 'transcript' };
                    }
                } catch (puppeteerError: any) {
                    const errorMsg = puppeteerError.message || 'Unknown error';
                    console.log(`   ⚠️ Puppeteer failed: ${errorMsg}`);
                }
                
                // Все методы получения транскрипта провалились
                console.log('❌ All transcript extraction methods failed for YouTube. Proceeding to metadata fallback...');
            }

            // Для не-YouTube платформ: попытка автоматической транскрибации
            // Транскрипция включена по умолчанию, отключается только если DISABLE_VIDEO_TRANSCRIPTION=true
            const disableTranscription = process.env.DISABLE_VIDEO_TRANSCRIPTION === 'true';

            if (!disableTranscription && videoPlatform !== 'youtube') {
                console.log(`🎬 [${videoPlatform}] Attempting automatic transcription to get full video content...`);
                try {
                    const transcribedText = await this.transcribeVideo(url, videoPlatform);
                    if (transcribedText && transcribedText.trim().length > 50) {
                        console.log(`✓✓✓ SUCCESS: Using automatic transcription (${transcribedText.length} chars) - full video content extracted`);
                        return { content: transcribedText, sourceType: 'transcript' };
                    } else {
                        console.warn(`⚠️ Transcription returned empty or too short text (${transcribedText?.length || 0} chars)`);
                    }
                } catch (error: any) {
                    const errorMsg = error.message || 'Unknown error';
                    console.warn(`⚠️ Automatic transcription failed for ${videoPlatform}: ${errorMsg}`);
                    if (errorMsg.includes('download') || errorMsg.includes('Failed to download')) {
                        console.warn(`   → Video download failed. May be private or unsupported.`);
                    } else if (errorMsg.includes('extract') || errorMsg.includes('audio')) {
                        console.warn(`   → Audio extraction failed.`);
                    } else if (errorMsg.includes('Transcription failed') || errorMsg.includes('Whisper')) {
                        console.warn(`   → Transcription service failed.`);
                    }
                }
            } else if (disableTranscription && videoPlatform !== 'youtube') {
                console.log(`⏭️ Video transcription disabled. Using metadata only.`);
            }

            // ============================================
            // ПРИОРИТЕТ 2: МЕТАДАННЫЕ (только если транскрипт недоступен)
            // ============================================
            console.log(`📋 [${videoPlatform}] Transcript unavailable. Falling back to metadata extraction...`);


            // 3. ПРИОРИТЕТНЫЙ FALLBACK: Метаданные через yt-dlp (самый быстрый и надежный способ получить название/описание)
            try {
                const ytDlpMetadata = await this.fetchMetadataWithYtDlp(url);
                if (ytDlpMetadata && ytDlpMetadata.content && ytDlpMetadata.content.trim().length > 100) {
                    console.log(`✓ Using yt-dlp metadata for ${videoPlatform} (transcription unavailable)`);
                    return ytDlpMetadata;
                }
            } catch (error: any) {
                console.warn(`⚠️ yt-dlp metadata extraction failed for ${videoPlatform}: ${error.message}`);
                console.log(`Falling back to YouTube API...`);
            }

            // 4. FALLBACK: YouTube Data API v3 (для YouTube, не требует Puppeteer/cookies)
            if (videoPlatform === 'youtube') {
                try {
                    const youtubeApiMetadata = await this.fetchMetadataWithYouTubeAPI(url);
                    if (youtubeApiMetadata && youtubeApiMetadata.content && youtubeApiMetadata.content.trim().length > 100) {
                        console.log(`✓ Using YouTube Data API v3 metadata`);
                        return youtubeApiMetadata;
                    }
                } catch (error: any) {
                    console.warn(`⚠️ YouTube API metadata extraction failed: ${error.message}`);
                }
            }

            // 5. FALLBACK 2: Парсинг страницы через Puppeteer (более медленный, но позволяет собрать доп. текст и комментарии)
            try {
                const metadata = await this.extractVideoMetadata(url, videoPlatform);
                if (metadata && metadata.content && metadata.content.trim().length > 100) {
                    console.log(`✓ Using Puppeteer metadata for ${videoPlatform} (includes page content)`);
                    return metadata;
                }
            } catch (error: any) {
                const errorMsg = error.message || 'Unknown error';
                if (errorMsg.includes('Target crashed') || errorMsg.includes('Protocol error') || errorMsg.includes('Browser crashed')) {
                    console.warn(`⚠️ Puppeteer unavailable (browser crashed) for ${videoPlatform}`);
                } else {
                    console.warn(`⚠️ Metadata extraction (puppeteer) failed for ${videoPlatform}: ${errorMsg}`);
                }
            }

            // 6. ПОСЛЕДНИЙ FALLBACK: play-dl (только для YouTube, если все остальное провалилось)
            if (videoPlatform === 'youtube') {
                try {
                    const videoInfo = await play.video_info(url);
                    const { title, description } = videoInfo.video_details;
                    const content = `Название: ${title || 'Нет названия'}\n\nОписание: ${description || 'Нет описания'}\n\n⚠️ ВАЖНО: Это только метаданные видео. Полная расшифровка недоступна. Анализ проводится ТОЛЬКО на основе этих метаданных.`;
                    console.log('⚠️ Using play-dl metadata (transcript unavailable)');
                    return { content, sourceType: 'metadata' };
                } catch (error: any) {
                    console.error(`✗ play-dl metadata extraction failed: ${error.message}`);
                }
            }
            
            // 7. ФИНАЛЬНЫЙ FALLBACK: Извлечение базовых метаданных через простой HTTP-запрос
            // Это гарантирует, что мы всегда получим хотя бы название и описание из og:tags
            try {
                console.log(`🔄 Attempting final fallback: extracting basic metadata from page...`);
                const basicMetadata = await this.extractBasicMetadata(url);
                if (basicMetadata && basicMetadata.content && basicMetadata.content.trim().length > 50) {
                    console.log(`✓ Using basic metadata as last resort`);
                    return basicMetadata;
                }
            } catch (error: any) {
                console.warn(`⚠️ Basic metadata extraction failed: ${error.message}`);
            }
            
            // Если даже базовые метаданные не получены, возвращаем минимальную информацию вместо ошибки
            console.warn(`⚠️ All content extraction methods failed for ${videoPlatform}. Returning minimal metadata.`);
            return {
                content: `⚠️ ВАЖНО: Не удалось извлечь полный контент из видео. Браузер недоступен на этом сервере, или видео требует аутентификации. Анализ будет проведен только на основе URL и доступных метаданных.\n\nURL: ${url}\nПлатформа: ${videoPlatform}`,
                sourceType: 'metadata' as const
            };
        } else {
            // ... (Статья - пробуем Puppeteer)
            // Пробуем Puppeteer для извлечения статьи
            try {
                return await this.scrapeArticleWithPuppeteer(url);
            } catch (puppeteerError: any) {
                const errorMsg = puppeteerError.message || 'Unknown error';
                console.warn(`⚠️ Puppeteer scraping failed: ${errorMsg}`);
                
                // Проверяем, является ли ошибка связанной с отсутствием Chrome
                if (errorMsg.includes('Could not find Chrome') || 
                    errorMsg.includes('Chrome not found') || 
                    errorMsg.includes('Chrome/Chromium not available') ||
                    !process.env.PUPPETEER_EXECUTABLE_PATH) {
                    // Пробуем извлечь базовые метаданные через HTTP запрос (без браузера)
                    try {
                        console.log('Attempting to extract basic metadata without browser...');
                        const response = await fetch(url, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                            }
                        });
                        const html = await response.text();
                        
                        // Извлекаем og:tags и title из HTML
                        const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
                        const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
                        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
                        
                        const title = ogTitleMatch?.[1] || titleMatch?.[1] || '';
                        const description = ogDescMatch?.[1] || '';
                        
                        if (title || description) {
                            const contentParts: string[] = [];
                            if (title) contentParts.push(`Название: ${title}`);
                            if (description) contentParts.push(`\n\nОписание: ${description}`);
                            
                            const content = contentParts.join('') + 
                                '\n\n⚠️ ВАЖНО: Это только базовые метаданные страницы. Полный контент статьи недоступен без браузера.';
                            
                            console.log(`✓ Extracted basic metadata without browser (title: ${title ? 'yes' : 'no'}, desc: ${description ? 'yes' : 'no'})`);
                            return { content, sourceType: 'metadata' };
                        }
                    } catch (fetchError: any) {
                        console.warn(`⚠️ Basic metadata extraction failed: ${fetchError.message}`);
                    }
                }
                
                // ФИНАЛЬНЫЙ FALLBACK: Пытаемся извлечь хотя бы базовые метаданные
                try {
                    console.log(`🔄 Attempting final fallback: extracting basic metadata from article...`);
                    const basicMetadata = await this.extractBasicMetadata(url);
                    if (basicMetadata && basicMetadata.content && basicMetadata.content.trim().length > 20) {
                        console.log(`✓ Using basic metadata as last resort for article`);
                        return basicMetadata;
                    }
                } catch (metadataError: any) {
                    console.warn(`⚠️ Final metadata fallback failed: ${metadataError.message}`);
                }
                
                // Если даже базовые метаданные не получены, возвращаем минимальную информацию вместо ошибки
                console.warn(`⚠️ All content extraction methods failed. Returning minimal metadata.`);
                return {
                    content: `⚠️ ВАЖНО: Не удалось извлечь полный контент из статьи. Браузер недоступен на этом сервере. Анализ будет проведен только на основе URL и доступных метаданных.\n\nURL: ${url}`,
                    sourceType: 'metadata' as const
                };
            }
        }
    }

    /**
     * Вспомогательная функция для получения настроек запуска Puppeteer с автоматическим поиском Chrome
     */
    private async getPuppeteerLaunchOptions(additionalArgs: string[] = []): Promise<any> {
            const launchOptions: any = {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--lang=ru-RU,ru',
                    '--disable-features=TranslateUI',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--disable-extensions',
                    '--disable-background-networking',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-breakpad',
                    '--disable-client-side-phishing-detection',
                    '--disable-default-apps',
                    '--disable-domain-reliability',
                    '--disable-features=AudioServiceOutOfProcess',
                    '--disable-hang-monitor',
                    '--disable-ipc-flooding-protection',
                    '--disable-notifications',
                    '--disable-offer-store-unmasked-wallet-cards',
                    '--disable-popup-blocking',
                    '--disable-print-preview',
                    '--disable-prompt-on-repost',
                    '--disable-renderer-backgrounding',
                    '--disable-speech-api',
                    '--disable-sync',
                    '--disable-web-resources',
                    '--hide-scrollbars',
                    '--ignore-gpu-blacklist',
                    '--metrics-recording-only',
                    '--mute-audio',
                    '--no-first-run',
                    '--no-default-browser-check',
                    '--no-pings',
                    '--no-zygote',
                    '--single-process', // Важно для Railway - один процесс уменьшает потребление памяти
                    '--disable-ipc-flooding-protection',
                    ...additionalArgs
                ],
                protocolTimeout: 300000, // 5 минут — Railway требует больше времени для CDP
                ignoreHTTPSErrors: true,
                handleSIGINT: false,
                handleSIGTERM: false,
                handleSIGHUP: false
            };
        
            // Используем системный Chromium, если указан путь
            if (process.env.PUPPETEER_EXECUTABLE_PATH) {
                launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
            console.log('Using system Chrome/Chromium from PUPPETEER_EXECUTABLE_PATH');
            return launchOptions;
        }
        
        // Пытаемся найти Chrome в стандартных местах или использовать встроенный
        const possiblePaths = [
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
        ];
        
        let foundPath = null;
        const fsModule = await import('fs');
        
        // Сначала проверяем стандартные пути
        for (const path of possiblePaths) {
            try {
                if (fsModule.existsSync(path)) {
                    foundPath = path;
                    break;
                }
            } catch (e) {
                // Игнорируем ошибки проверки
            }
        }
        
        // Если не нашли, пытаемся использовать Chrome, установленный через Puppeteer
        if (!foundPath) {
            try {
                // Используем @puppeteer/browsers для поиска установленного Chrome
                const { detectBrowserPlatform, getInstalledBrowsers, computeExecutablePath, Browser } = await import('@puppeteer/browsers');
                const cacheDir = process.env.PUPPETEER_CACHE_DIR || 
                                (process.env.HOME ? `${process.env.HOME}/.cache/puppeteer` : null) ||
                                '/opt/render/.cache/puppeteer' ||
                                os.homedir() + '/.cache/puppeteer';
                
                try {
                    // Определяем платформу и ищем установленные браузеры
                    const platform = detectBrowserPlatform();
                    if (platform) {
                        const installedBrowsers = await getInstalledBrowsers({
                            cacheDir: cacheDir
                        });
                        
                        // Ищем Chrome среди установленных браузеров
                        const chromeBrowser = installedBrowsers.find((b: any) => b.browser === Browser.CHROME);
                        if (chromeBrowser) {
                            const chromePath = computeExecutablePath({
                                browser: Browser.CHROME,
                                cacheDir: cacheDir,
                                buildId: chromeBrowser.buildId,
                                platform: platform
                            });
                            
                            if (chromePath && fsModule.existsSync(chromePath)) {
                                foundPath = chromePath;
                                console.log(`✓ Found Puppeteer-installed Chrome via @puppeteer/browsers at: ${foundPath}`);
                            }
                        }
                    }
                } catch (computeError) {
                    // Если новый API не сработал, пробуем старый способ
                    const puppeteerModule = await import('puppeteer');
                    // @ts-ignore - executablePath может быть доступен через внутренний API
                    const puppeteerPath = (puppeteerModule as any).executablePath?.() || 
                                         (puppeteerModule as any).default?.executablePath?.();
                    if (puppeteerPath && fsModule.existsSync(puppeteerPath)) {
                        foundPath = puppeteerPath;
                        console.log(`✓ Found Puppeteer-installed Chrome at: ${foundPath}`);
                    }
                }
            } catch (e) {
                console.log(`⚠️ Could not get Chrome path from Puppeteer: ${e instanceof Error ? e.message : 'Unknown error'}`);
            }
        }
        
        // Проверяем путь к кэшу Puppeteer (для Render.com и других платформ)
        if (!foundPath) {
            const possibleCachePaths = [
                process.env.PUPPETEER_CACHE_DIR,
                process.env.HOME ? `${process.env.HOME}/.cache/puppeteer` : null,
                '/opt/render/.cache/puppeteer',
                '/root/.cache/puppeteer',
                os.homedir() + '/.cache/puppeteer'
            ].filter(Boolean) as string[];
            
            for (const cachePath of possibleCachePaths) {
                try {
                    if (fsModule.existsSync(cachePath)) {
                        console.log(`🔍 Checking Puppeteer cache at: ${cachePath}`);
                        const entries = fsModule.readdirSync(cachePath);
                        console.log(`   Found ${entries.length} entries in cache`);
                        
                        // Ищем директории с Chrome
                        const chromeDirs = entries.filter((dir: string) => 
                            dir.startsWith('chrome') || dir.startsWith('chromium')
                        );
                        
                        console.log(`   Found ${chromeDirs.length} Chrome directories: ${chromeDirs.join(', ')}`);
                        
                        for (const dir of chromeDirs) {
                            // Пробуем разные возможные структуры
                            const possibleChromePaths = [
                                `${cachePath}/${dir}/chrome-linux64/chrome`,
                                `${cachePath}/${dir}/chrome-linux64/chromium`,
                                `${cachePath}/${dir}/chrome-linux/chrome`,
                                `${cachePath}/${dir}/chrome-linux/chromium`,
                                `${cachePath}/${dir}/chrome/chrome`,
                                `${cachePath}/${dir}/chrome/chromium`,
                                `${cachePath}/${dir}/chrome`,
                                `${cachePath}/${dir}/chromium`,
                                `${cachePath}/${dir}/headless_shell`,
                            ];
                            
                            // Также пробуем использовать @puppeteer/browsers для вычисления пути
                            try {
                                const { detectBrowserPlatform, getInstalledBrowsers, computeExecutablePath, Browser } = await import('@puppeteer/browsers');
                                const platform = detectBrowserPlatform();
                                if (platform) {
                                    const installedBrowsers = await getInstalledBrowsers({
                                        cacheDir: cachePath
                                    });
                                    const chromeBrowser = installedBrowsers.find((b: any) => b.browser === Browser.CHROME);
                                    if (chromeBrowser) {
                                        const computedPath = computeExecutablePath({
                                            browser: Browser.CHROME,
                                            cacheDir: cachePath,
                                            buildId: chromeBrowser.buildId,
                                            platform: platform
                                        });
                                        if (computedPath && fsModule.existsSync(computedPath)) {
                                            foundPath = computedPath;
                                            console.log(`✓ Found Chrome via computeExecutablePath at: ${foundPath}`);
                                            break;
                                        }
                                    }
                                }
                            } catch (e) {
                                // Игнорируем ошибки computeExecutablePath
                            }
                            
                            for (const chromePath of possibleChromePaths) {
                                if (fsModule.existsSync(chromePath)) {
                                    // Проверяем, что это исполняемый файл
                                    const stats = fsModule.statSync(chromePath);
                                    if (stats.isFile()) {
                                        foundPath = chromePath;
                                        console.log(`✓ Found Chrome in Puppeteer cache at: ${foundPath}`);
                                        break;
                                    }
                                }
                            }
                            if (foundPath) break;
                        }
                    }
                } catch (e) {
                    console.log(`⚠️ Error checking cache path ${cachePath}: ${e instanceof Error ? e.message : 'Unknown error'}`);
                }
                if (foundPath) break;
            }
        }
        
        if (foundPath) {
            launchOptions.executablePath = foundPath;
            console.log(`Using Chrome/Chromium at: ${foundPath}`);
        } else {
            console.log('PUPPETEER_EXECUTABLE_PATH not set and Chrome not found in standard paths.');
            console.log('Puppeteer will try to use bundled Chrome (if available).');
        }
        
        return launchOptions;
    }

    /**
     * Извлекает HTML контент через ScrapingBee API (не требует браузеров)
     */
    private async extractWithScrapingBee(url: string): Promise<string | null> {
        // Поддержка нескольких API ключей через переменную окружения (разделенные запятыми)
        const apiKeysEnv = process.env.SCRAPINGBEE_API_KEY || process.env.SCRAPINGBEE_API_KEYS;
        if (!apiKeysEnv) {
            console.log('⚠️ SCRAPINGBEE_API_KEY or SCRAPINGBEE_API_KEYS not set, skipping ScrapingBee');
            return null;
        }

        // Разбиваем ключи по запятым и очищаем от пробелов
        const apiKeys = apiKeysEnv.split(',').map(key => key.trim()).filter(key => key.length > 0);
        
        if (apiKeys.length === 0) {
            console.log('⚠️ No valid ScrapingBee API keys found');
            return null;
        }

        const axios = await import('axios');
        const apiUrl = 'https://app.scrapingbee.com/api/v1/';

        // Пробуем каждый ключ по очереди
        for (let i = 0; i < apiKeys.length; i++) {
            const apiKey = apiKeys[i];
            const isLastKey = i === apiKeys.length - 1;
            
            try {
                if (apiKeys.length > 1) {
                    console.log(`Trying ScrapingBee API (key ${i + 1}/${apiKeys.length})...`);
                } else {
                    console.log('Trying ScrapingBee API...');
                }
                
                const params = new URLSearchParams({
                    'api_key': apiKey,
                    'url': url,
                    'render_js': 'true', // Выполняет JavaScript на странице
                    'premium_proxy': 'true', // Использует премиум прокси для обхода блокировок
                    'country_code': 'us', // Страна прокси
                });

                const response = await axios.default.get(apiUrl, {
                    params: params,
                    timeout: 30000, // 30 секунд таймаут
                });

                if (response.data) {
                    console.log('✓ ScrapingBee successfully fetched content');
                    return typeof response.data === 'string' ? response.data : response.data.toString();
                }
            } catch (error: any) {
                const status = error.response?.status;
                const statusText = error.response?.statusText;
                
                // Обрабатываем разные типы ошибок
                if (status === 401 || status === 403) {
                    console.log(`⚠️ ScrapingBee API authentication error (${status}) for key ${i + 1}: Invalid API key or access denied`);
                    if (!isLastKey) {
                        console.log(`   Trying next API key...`);
                        continue; // Пробуем следующий ключ
                    }
                } else if (status === 429) {
                    console.log(`⚠️ ScrapingBee API rate limit exceeded (429) for key ${i + 1}: Too many requests`);
                    if (!isLastKey) {
                        console.log(`   Trying next API key...`);
                        continue; // Пробуем следующий ключ
                    }
                } else if (status >= 500) {
                    console.log(`⚠️ ScrapingBee API server error (${status}) for key ${i + 1}: ${statusText || error.message}`);
                    if (!isLastKey) {
                        console.log(`   Trying next API key...`);
                        continue; // Пробуем следующий ключ
                    }
                } else {
                    console.log(`⚠️ ScrapingBee API error for key ${i + 1}: ${error.message || 'Unknown error'}`);
                    if (!isLastKey) {
                        console.log(`   Trying next API key...`);
                        continue; // Пробуем следующий ключ
                    }
                }
            }
        }
        
        console.log(`❌ All ScrapingBee API keys failed`);
        return null;
    }

    /**
     * Извлекает транскрипт из HTML страницы YouTube
     */
    private async extractTranscriptFromHTML(html: string, url: string): Promise<string | null> {
        try {
            // Извлекаем video ID из URL
            const videoIdMatch = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/);
            const videoId = videoIdMatch ? videoIdMatch[1] : null;
            
            if (!videoId) {
                console.log('⚠️ Could not extract video ID from URL');
                return null;
            }

            console.log(`🔍 Searching for transcript in HTML for video: ${videoId}`);

            // Метод 1: Ищем транскрипт в JSON данных страницы (ytInitialPlayerResponse)
            const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
            console.log(`   Found ${scripts.length} script tags to search`);
            
            for (const scriptTag of scripts) {
                const scriptContent = scriptTag.replace(/<\/?script[^>]*>/gi, '');
                
                // Ищем ytInitialPlayerResponse
                if (scriptContent.includes('ytInitialPlayerResponse')) {
                    console.log('   Found ytInitialPlayerResponse, parsing...');
                    try {
                        // Пробуем разные паттерны для извлечения JSON
                        const patterns = [
                            /var ytInitialPlayerResponse\s*=\s*({[\s\S]+?});/,
                            /"ytInitialPlayerResponse"\s*:\s*({[\s\S]+?})(?=;|$)/,
                            /ytInitialPlayerResponse\s*=\s*({[\s\S]+?});/,
                            /ytInitialPlayerResponse\s*=\s*({[\s\S]+?})(?=;|<\/script>|$)/m
                        ];
                        
                        for (const pattern of patterns) {
                            const match = scriptContent.match(pattern);
                            if (match && match[1]) {
                                try {
                                    // Очищаем JSON от возможных лишних символов
                                    let jsonStr = match[1].trim();
                                    // Убираем завершающие точки с запятой или другие символы
                                    jsonStr = jsonStr.replace(/;[\s]*$/, '');
                                    // Убираем возможные завершающие скобки после JSON
                                    if (jsonStr.endsWith('})')) {
                                        jsonStr = jsonStr.slice(0, -1);
                                    }
                                    
                                    const data = JSON.parse(jsonStr);
                                    
                                    // Ищем captionTracks в разных местах структуры
                                    let captionTracks = null;
                                    const searchPaths = [
                                        () => data?.captions?.playerCaptionsTracklistRenderer?.captionTracks,
                                        () => data?.captions?.playerCaptionsRenderer?.captionTracks,
                                        () => data?.videoDetails?.captionTracks,
                                        () => data?.captionTracks,
                                        () => data?.captions?.captionTracks,
                                        () => data?.playerCaptionsTracklistRenderer?.captionTracks
                                    ];
                                    
                                    for (const path of searchPaths) {
                                        captionTracks = path();
                                        if (captionTracks && Array.isArray(captionTracks) && captionTracks.length > 0) {
                                            break;
                                        }
                                    }
                                    
                                    if (captionTracks && Array.isArray(captionTracks) && captionTracks.length > 0) {
                                        console.log(`   Found ${captionTracks.length} caption tracks`);
                                        // Ищем русский или английский трек, или берем первый доступный
                                        let captionTrack = captionTracks.find((track: any) => 
                                            (track.languageCode === 'ru' || track.languageCode === 'en') && 
                                            (track.baseUrl || track.url)
                                        ) || captionTracks.find((track: any) => track.baseUrl || track.url);
                                        
                                        if (captionTrack) {
                                            let captionUrl = captionTrack.baseUrl || captionTrack.url;
                                            
                                            if (captionUrl) {
                                                // Декодируем Unicode escape sequences в URL
                                                try {
                                                    captionUrl = captionUrl.replace(/\\u([0-9a-fA-F]{4})/g, (match: string, hex: string) => {
                                                        return String.fromCharCode(parseInt(hex, 16));
                                                    });
                                                } catch (e) {
                                                    // Если декодирование не удалось, используем исходный URL
                                                }
                                                
                                                console.log(`✓ Found caption track: ${captionTrack.languageCode || 'unknown'}`);
                                                console.log(`   Attempting to download transcript from URL...`);
                                                const transcript = await this.downloadTranscriptFromUrl(captionUrl);
                                                if (transcript && transcript.trim().length > 50) {
                                                    console.log(`✓✓✓ SUCCESS: Downloaded transcript from caption track (${transcript.length} chars)`);
                                                    return transcript;
                                                } else {
                                                    console.log(`   ⚠️ Transcript download returned empty or too short (${transcript?.length || 0} chars)`);
                                                }
                                            }
                                        }
                                    }
                                } catch (parseError: any) {
                                    // Пробуем следующий паттерн или ищем другим способом
                                    if (!parseError.message.includes('Unexpected token') && !parseError.message.includes('JSON')) {
                                        console.log(`   JSON parse error: ${parseError.message.substring(0, 100)}`);
                                    }
                                    continue;
                                }
                            }
                        }
                        
                        // Альтернативный метод: ищем captionTracks напрямую в тексте через regex
                        if (scriptContent.includes('captionTracks')) {
                            console.log('   Trying alternative regex method for captionTracks...');
                            try {
                                // Более гибкий поиск baseUrl
                                const baseUrlPatterns = [
                                    /"baseUrl"\s*:\s*"([^"]+)"/,
                                    /baseUrl["\s]*:["\s]*"([^"]+)"/,
                                    /"url"\s*:\s*"([^"]+timedtext[^"]+)"/,
                                    /captionTracks[^[]*\[[^\]]*"baseUrl"[^"]*"([^"]+)"/,
                                ];
                                
                                    for (const pattern of baseUrlPatterns) {
                                        const matches = scriptContent.matchAll(new RegExp(pattern.source, 'g'));
                                        for (const match of matches) {
                                            if (match[1] && match[1].includes('timedtext')) {
                                                // Декодируем Unicode escape sequences в URL
                                                let decodedUrl = match[1];
                                                try {
                                                    decodedUrl = decodedUrl.replace(/\\u([0-9a-fA-F]{4})/g, (m: string, hex: string) => {
                                                        return String.fromCharCode(parseInt(hex, 16));
                                                    });
                                                } catch (e) {
                                                    // Если декодирование не удалось, используем исходный URL
                                                }
                                                
                            console.log(`✓ Found caption URL via regex: ${decodedUrl.substring(0, 100)}...`);
                            console.log(`   Attempting to download transcript from URL...`);
                            const transcript = await this.downloadTranscriptFromUrl(decodedUrl);
                            if (transcript && transcript.trim().length > 50) {
                                console.log(`✓✓✓ SUCCESS: Downloaded transcript via ScrapingBee (${transcript.length} chars)`);
                                return transcript;
                            } else {
                                console.log(`   ⚠️ Transcript download returned empty or too short (${transcript?.length || 0} chars)`);
                            }
                                            }
                                        }
                                    }
                            } catch (e) {
                                console.log(`   Regex method failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
                            }
                        }
                    } catch (e) {
                        console.log(`   Error processing script: ${e instanceof Error ? e.message : 'Unknown error'}`);
                        continue;
                    }
                }
            }
            
            // Метод 2: Прямой поиск URL транскрипта в HTML через regex
            console.log('   Trying direct URL search in HTML...');
            try {
                const directUrlPatterns = [
                    /"baseUrl"\s*:\s*"([^"]+timedtext[^"]+)"/g,
                    /baseUrl["\s]*:["\s]*"([^"]+timedtext[^"]+)"/g,
                    /captionTracks[^[]*\[[^\]]*"baseUrl"[^"]*"([^"]+timedtext[^"]+)"/g,
                ];
                
                for (const pattern of directUrlPatterns) {
                    const matches = html.matchAll(pattern);
                    for (const match of matches) {
                        if (match[1] && match[1].includes('timedtext')) {
                            // Декодируем Unicode escape sequences в URL
                            let decodedUrl = match[1];
                            try {
                                decodedUrl = decodedUrl.replace(/\\u([0-9a-fA-F]{4})/g, (m: string, hex: string) => {
                                    return String.fromCharCode(parseInt(hex, 16));
                                });
                            } catch (e) {
                                // Если декодирование не удалось, используем исходный URL
                            }
                            
                            console.log(`✓ Found transcript URL directly in HTML`);
                            console.log(`   Attempting to download transcript from URL...`);
                            const transcript = await this.downloadTranscriptFromUrl(decodedUrl);
                            if (transcript && transcript.trim().length > 50) {
                                console.log(`✓✓✓ SUCCESS: Downloaded transcript directly from HTML (${transcript.length} chars)`);
                                return transcript;
                            } else {
                                console.log(`   ⚠️ Transcript download returned empty or too short (${transcript?.length || 0} chars)`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.log(`   Direct URL search failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
            }
            
            // Метод 3: Прямой запрос к YouTube API для получения транскрипта
            console.log('   Trying YouTube API method...');
            try {
                const transcriptUrl = await this.getYouTubeTranscriptUrl(videoId);
                if (transcriptUrl) {
                    console.log(`✓ Got transcript URL from API`);
                    console.log(`   Attempting to download transcript from URL...`);
                    const transcript = await this.downloadTranscriptFromUrl(transcriptUrl);
                    if (transcript && transcript.trim().length > 50) {
                        console.log(`✓✓✓ SUCCESS: Downloaded transcript via YouTube API (${transcript.length} chars)`);
                        return transcript;
                    } else {
                        console.log(`   ⚠️ Transcript download returned empty or too short (${transcript?.length || 0} chars)`);
                    }
                }
            } catch (e) {
                console.log(`   YouTube API method failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
            }
            
            console.log('❌ No transcript found in HTML');
            return null;
        } catch (error: any) {
            console.log(`⚠️ Failed to extract transcript from HTML: ${error.message}`);
            return null;
        }
    }

    /**
     * Загружает транскрипт по URL
     */
    private async downloadTranscriptFromUrl(captionUrl: string): Promise<string | null> {
        try {
            // Декодируем Unicode escape sequences в URL (например, \u0026 -> &)
            let decodedUrl = captionUrl;
            try {
                // Заменяем Unicode escape sequences
                decodedUrl = decodedUrl.replace(/\\u([0-9a-fA-F]{4})/g, (match: string, hex: string) => {
                    return String.fromCharCode(parseInt(hex, 16));
                });
                // Также декодируем стандартные escape sequences
                decodedUrl = decodeURIComponent(decodedUrl);
            } catch (decodeError) {
                // Если декодирование не удалось, используем исходный URL
                console.log(`   Warning: Could not decode URL, using original`);
            }
            
            console.log(`   📥 Downloading transcript from: ${decodedUrl.substring(0, 150)}...`);
            
            const axios = await import('axios');
            const transcriptResponse = await axios.default.get(decodedUrl, {
                timeout: 15000, // Увеличено с 10 до 15 секунд
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/xml,application/xml,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
                    'Referer': 'https://www.youtube.com/' // Добавляем Referer для YouTube
                },
                maxRedirects: 5,
                validateStatus: (status) => status < 500 // Принимаем все статусы кроме 5xx
            });
            
            const status = transcriptResponse.status;
            if (status !== 200) {
                console.log(`   ⚠️ Transcript URL returned status ${status}: ${decodedUrl.substring(0, 100)}...`);
                return null;
            }
            
            const transcriptXml = transcriptResponse.data;
            
            // Проверяем, что получили XML
            if (typeof transcriptXml !== 'string' || !transcriptXml.includes('<text')) {
                console.log(`   ⚠️ Transcript response is not valid XML (length: ${transcriptXml?.length || 0})`);
                // Возможно это HTML страница с ошибкой, пробуем найти текст в HTML
                if (typeof transcriptXml === 'string' && transcriptXml.includes('<html')) {
                    console.log(`   → Got HTML instead of XML, transcript may be unavailable`);
                }
                return null;
            }
            
            const transcriptItems: string[] = [];
            
            // Парсим XML транскрипта (YouTube использует формат timedtext)
            const textMatches = transcriptXml.matchAll(/<text[^>]*>([^<]+)<\/text>/g);
            for (const match of textMatches) {
                const text = match[1]
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .trim();
                if (text) {
                    transcriptItems.push(text);
                }
            }
            
            if (transcriptItems.length > 0) {
                const fullTranscript = transcriptItems.join(' ');
                console.log(`✓ Successfully extracted ${transcriptItems.length} transcript items (${fullTranscript.length} chars)`);
                return fullTranscript;
            } else {
                console.log(`   ⚠️ No transcript items found in XML (XML length: ${transcriptXml.length})`);
                // Пробуем альтернативный формат парсинга
                const altMatches = transcriptXml.matchAll(/<text[^>]*start="[^"]*"[^>]*>([^<]+)<\/text>/g);
                for (const match of altMatches) {
                    const text = match[1]
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'")
                        .trim();
                    if (text) {
                        transcriptItems.push(text);
                    }
                }
                if (transcriptItems.length > 0) {
                    const fullTranscript = transcriptItems.join(' ');
                    console.log(`✓ Successfully extracted ${transcriptItems.length} transcript items using alternative parsing (${fullTranscript.length} chars)`);
                    return fullTranscript;
                }
            }
            
            return null;
        } catch (error: any) {
            const status = error.response?.status;
            const errorMessage = error.message || 'Unknown error';
            
            if (status === 404) {
                console.log(`   ⚠️ Transcript URL returned 404 (may be expired or invalid): ${captionUrl.substring(0, 100)}...`);
            } else if (status === 403) {
                console.log(`   ⚠️ Transcript URL returned 403 (access forbidden): ${captionUrl.substring(0, 100)}...`);
            } else if (errorMessage.includes('timeout') || errorMessage.includes('ECONNABORTED')) {
                console.log(`   ⚠️ Transcript download timeout: ${errorMessage}`);
            } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
                console.log(`   ⚠️ DNS error when downloading transcript: ${errorMessage}`);
            } else {
                console.log(`   ⚠️ Failed to download transcript from URL (status: ${status || 'N/A'}): ${errorMessage.substring(0, 200)}`);
            }
            return null;
        }
    }

    /**
     * Получает URL транскрипта напрямую через YouTube API
     */
    private async getYouTubeTranscriptUrl(videoId: string): Promise<string | null> {
        try {
            const axios = await import('axios');
            
            // Пробуем получить страницу видео
            const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
            const response = await axios.default.get(videoUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                timeout: 15000,
                maxRedirects: 5
            });
            
            const html = response.data;
            const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
            
            // Ищем в скриптах с ytInitialPlayerResponse
            for (const scriptTag of scripts) {
                const scriptContent = scriptTag.replace(/<\/?script[^>]*>/gi, '');
                
                if (scriptContent.includes('ytInitialPlayerResponse')) {
                    try {
                        // Пробуем извлечь JSON
                        const patterns = [
                            /var ytInitialPlayerResponse\s*=\s*({[\s\S]+?});/,
                            /ytInitialPlayerResponse\s*=\s*({[\s\S]+?})(?=;|<\/script>|$)/m
                        ];
                        
                        for (const pattern of patterns) {
                            const match = scriptContent.match(pattern);
                            if (match && match[1]) {
                                try {
                                    let jsonStr = match[1].trim().replace(/;[\s]*$/, '');
                                    const data = JSON.parse(jsonStr);
                                    
                                    // Ищем captionTracks
                                    const captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
                                                         data?.captions?.playerCaptionsRenderer?.captionTracks ||
                                                         data?.videoDetails?.captionTracks ||
                                                         data?.captionTracks;
                                    
                                    if (captionTracks && Array.isArray(captionTracks) && captionTracks.length > 0) {
                                        const track = captionTracks.find((t: any) => 
                                            (t.languageCode === 'ru' || t.languageCode === 'en') && (t.baseUrl || t.url)
                                        ) || captionTracks.find((t: any) => t.baseUrl || t.url);
                                        
                                        if (track?.baseUrl || track?.url) {
                                            let transcriptUrl = track.baseUrl || track.url;
                                            // Декодируем Unicode escape sequences
                                            try {
                                                transcriptUrl = transcriptUrl.replace(/\\u([0-9a-fA-F]{4})/g, (m: string, hex: string) => {
                                                    return String.fromCharCode(parseInt(hex, 16));
                                                });
                                            } catch (e) {
                                                // Если декодирование не удалось, используем исходный URL
                                            }
                                            return transcriptUrl;
                                        }
                                    }
                                } catch (e) {
                                    continue;
                                }
                            }
                        }
                    } catch (e) {
                        continue;
                    }
                }
                
                // Альтернативный поиск через regex
                if (scriptContent.includes('captionTracks')) {
                    const urlPatterns = [
                        /"baseUrl"\s*:\s*"([^"]+timedtext[^"]+)"/,
                        /baseUrl["\s]*:["\s]*"([^"]+timedtext[^"]+)"/,
                    ];
                    
                    for (const pattern of urlPatterns) {
                        const match = scriptContent.match(pattern);
                        if (match && match[1] && match[1].includes('timedtext')) {
                            let transcriptUrl = match[1];
                            // Декодируем Unicode escape sequences
                            try {
                                transcriptUrl = transcriptUrl.replace(/\\u([0-9a-fA-F]{4})/g, (m: string, hex: string) => {
                                    return String.fromCharCode(parseInt(hex, 16));
                                });
                            } catch (e) {
                                // Если декодирование не удалось, используем исходный URL
                            }
                            return transcriptUrl;
                        }
                    }
                }
            }
            
            return null;
        } catch (error: any) {
            console.log(`⚠️ Failed to get transcript URL: ${error.message}`);
            return null;
        }
    }

    private async getYouTubeTranscript(url: string): Promise<string> {
        let browser = null;
        try {
            console.log('Launching browser to extract YouTube transcript...');
            
            const launchOptions = await this.getPuppeteerLaunchOptions();
            
            // Добавляем таймаут на запуск браузера (30 секунд)
            try {
                browser = await Promise.race([
                    puppeteer.launch(launchOptions),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Browser launch timeout')), 30000)
                    )
                ]) as any;
            } catch (launchError: any) {
                const errorMsg = launchError.message || 'Unknown error';
                if (errorMsg.includes('Target crashed') || errorMsg.includes('Protocol error')) {
                    console.warn(`⚠️ Browser crashed during launch: ${errorMsg}. Puppeteer unavailable on this server.`);
                    throw new Error('Browser crashed - Puppeteer unavailable');
                }
                throw launchError;
            }
    
            const page = await browser.newPage();
            
            // Устанавливаем пользовательский агент и язык
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
            });
    
            console.log(`Navigating to YouTube video: ${url}`);
            await page.goto(url, { 
                waitUntil: 'domcontentloaded', // Изменено с networkidle2 на domcontentloaded для быстрой загрузки
                timeout: 90000 // Увеличено до 90 секунд
            });

            // Ждем полной загрузки страницы
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Прокручиваем немного вниз чтобы загрузить все элементы
            await page.evaluate(() => {
                window.scrollBy(0, 300);
            });
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Стратегия 1: Прямой поиск кнопки "Расшифровка" или "Show transcript" в правой панели
            try {
                // Ищем кнопку транскрипта в правой панели (под видео)
                const transcriptButtonSelectors = [
                    'button[aria-label*="Show transcript"]',
                    'button[aria-label*="Показать расшифровку"]',
                    'button[aria-label*="Show transcript"]',
                    'ytd-menu-renderer button[aria-label*="transcript"]',
                    '#actions button[aria-label*="transcript"]',
                    'ytd-menu-renderer button[aria-label*="расшифровка"]'
                ];

                for (const selector of transcriptButtonSelectors) {
                    try {
                        const button = await page.$(selector);
                        if (button) {
                            await button.click();
                            console.log(`✓ Clicked transcript button: ${selector}`);
                            await new Promise(resolve => setTimeout(resolve, 3000));
                            
                            const transcript = await this.extractTranscriptContent(page);
                            if (transcript) return transcript;
                        }
                    } catch (e) {
                        continue;
                    }
                }

                // Также ищем по тексту
                const transcriptButtonTexts = [
                    'расшифровка',
                    'транскрипт', 
                    'transcript',
                    'show transcript',
                    'показать расшифровку',
                    'показать транскрипт'
                ];

                const transcriptText = await page.evaluate((texts: string[]) => {
                    // Ищем все кнопки и ссылки на странице
                    const allButtons = Array.from(document.querySelectorAll('button, a, yt-formatted-string, [role="button"]'));
                    
                    for (const button of allButtons) {
                        const buttonText = button.textContent?.toLowerCase().trim();
                        if (buttonText) {
                            for (const targetText of texts) {
                                if (buttonText.includes(targetText)) {
                                    (button as HTMLElement).click();
                                    return 'clicked';
                                }
                            }
                        }
                    }
                    return 'not_found';
                }, transcriptButtonTexts);

                if (transcriptText === 'clicked') {
                    console.log('✓ Clicked transcript button by text');
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    
                    const transcript = await this.extractTranscriptContent(page);
                    if (transcript) return transcript;
                }
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                console.log('Strategy 1 failed:', errorMessage);
            }

            // Стратегия 2: Ищем кнопку "..." (More actions) и затем транскрипт
            try {
                const moreActionsSelectors = [
                    'button[aria-label*="More actions"]',
                    'button[aria-label*="Еще"]',
                    '#button[aria-haspopup="menu"]',
                    'ytd-menu-renderer button',
                    '#actions button'
                ];

                let moreActionsClicked = false;
                for (const selector of moreActionsSelectors) {
                    try {
                        await page.waitForSelector(selector, { timeout: 3000 });
                        await page.click(selector);
                        console.log(`✓ Clicked more actions button: ${selector}`);
                        moreActionsClicked = true;
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        break;
                    } catch (e) {
                        continue;
                    }
                }

                if (moreActionsClicked) {
                    // Ищем пункт меню с транскриптом
                    const transcriptFound = await page.evaluate(() => {
                        const menuItems = Array.from(document.querySelectorAll('ytd-menu-service-item-renderer, yt-formatted-string'));
                        for (const item of menuItems) {
                            const text = item.textContent?.toLowerCase();
                            if (text && (text.includes('transcript') || text.includes('транскрипт') || text.includes('расшифровка'))) {
                                (item as HTMLElement).click();
                                return true;
                            }
                        }
                        return false;
                    });

                    if (transcriptFound) {
                        console.log('✓ Found and clicked transcript menu item');
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        const transcript = await this.extractTranscriptContent(page);
                        if (transcript) return transcript;
                    }
                }
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                console.log('Strategy 2 failed:', errorMessage);
            }

            // Стратегия 3: Пробуем найти уже открытую панель транскрипта
            try {
                const transcript = await this.extractTranscriptContent(page);
                if (transcript) {
                    console.log('✓ Found existing transcript panel');
                    return transcript;
                }
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                console.log('Strategy 3 failed:', errorMessage);
            }

            console.log('All transcript extraction strategies failed');
            return '';

        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            if (errorMessage.includes('Target crashed') || errorMessage.includes('Protocol error') || errorMessage.includes('Browser crashed')) {
                console.warn(`⚠️ Browser crashed - Puppeteer unavailable. Error: ${errorMessage}`);
            } else {
                console.error(`✗ Failed to extract YouTube transcript: ${errorMessage}`);
            }
            return '';
        } finally {
            if (browser) {
                try {
                    await browser.close();
                } catch (closeError: any) {
                    // Игнорируем ошибки закрытия браузера
                    console.warn(`⚠️ Error closing browser: ${closeError.message}`);
                }
            }
        }
    }

    private async extractTranscriptContent(page: any): Promise<string> {
        try {
            // Ждем появления панели транскрипта (увеличено время ожидания)
            const panelSelectors = [
                'ytd-engagement-panel-section-list-renderer',
                '.ytd-transcript-body-renderer',
                '#segments-container',
                'ytd-transcript-segment-renderer',
                '[role="document"]',
                '#content-text',
                'ytd-transcript-renderer'
            ];

            for (const selector of panelSelectors) {
                try {
                    await page.waitForSelector(selector, { timeout: 10000 }); // Увеличено с 5 до 10 секунд
                    
                    const transcriptText = await page.evaluate((sel: string) => {
                        const panel = document.querySelector(sel);
                        if (!panel) return '';
                        
                        // Собираем текст из всех возможных элементов транскрипта
                        const textElements = panel.querySelectorAll(
                            'yt-formatted-string, .segment-text, [role="text"], .ytd-transcript-segment-renderer, #content-text, ytd-transcript-segment-renderer yt-formatted-string'
                        );
                        
                        const texts: string[] = [];
                        textElements.forEach((el: Element) => {
                            const text = el.textContent?.trim();
                            if (text && 
                                text.length > 10 && 
                                !text.match(/^\d+:\d+$/) && // исключаем временные метки
                                !text.match(/^\d+:\d+:\d+$/) && // исключаем временные метки с секундами
                                !text.includes('›') &&
                                !text.includes('0:00') &&
                                !text.match(/^Show transcript$/i) &&
                                !text.match(/^Показать расшифровку$/i)) {
                                texts.push(text);
                            }
                        });
                        
                        return texts.join(' ').trim();
                    }, selector);

                    if (transcriptText && transcriptText.length > 50) {
                        console.log(`✓ Extracted transcript: ${transcriptText.length} chars`);
                        return transcriptText;
                    }
                } catch (e) {
                    continue;
                }
            }
            
            // Дополнительная попытка: ищем текст напрямую на странице
            try {
                const allText = await page.evaluate(() => {
                    const segments = Array.from(document.querySelectorAll('ytd-transcript-segment-renderer'));
                    const texts: string[] = [];
                    segments.forEach((segment: Element) => {
                        const textEl = segment.querySelector('yt-formatted-string');
                        if (textEl) {
                            const text = textEl.textContent?.trim();
                            if (text && text.length > 10) {
                                texts.push(text);
                            }
                        }
                    });
                    return texts.join(' ').trim();
                });
                
                if (allText && allText.length > 50) {
                    console.log(`✓ Extracted transcript from segments: ${allText.length} chars`);
                    return allText;
                }
            } catch (e) {
                // Игнорируем ошибки
            }
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.log('Transcript content extraction failed:', errorMessage);
        }
        return '';
    }

    /**
     * Извлекает транскрипт YouTube видео через yt-dlp
     */
    private async extractTranscriptWithYtDlp(url: string): Promise<string | null> {
        try {
            // @ts-ignore - yt-dlp-exec types may not быть доступны
            const ytdlp = (await import('yt-dlp-exec')).default;
            
            const cookiesOpts = this.getYtDlpCookiesOptions();
            const hasCookies = Object.keys(cookiesOpts).length > 0;
            
            // player_client=web_embedded иногда работает без cookies (обход bot detection)
            const extractorArgs = 'youtube:player_client=web_embedded,web,android';
            
            const baseOpts = {
                ...cookiesOpts,
                extractorArgs,
                listSubs: true,
                skipDownload: true,
                quiet: true,
                noWarnings: true,
            } as any;
            
            // Сначала получаем информацию о доступных субтитрах
            const infoResult = await ytdlp(url, baseOpts);
            
            // Пробуем скачать автоматически сгенерированные субтитры или обычные
            // Используем временный файл для субтитров
            const tempDir = os.tmpdir();
            const tempSubsFile = path.join(tempDir, `subs_${Date.now()}.vtt`);
            
            try {
                // Пробуем скачать автоматические субтитры (если доступны)
                await ytdlp(url, {
                    ...cookiesOpts,
                    extractorArgs,
                    writeAutoSub: true,
                    subLang: 'ru,en,uk', // Приоритет языков
                    skipDownload: true,
                    output: tempSubsFile.replace('.vtt', ''),
                    quiet: true,
                    noWarnings: true,
                } as any);
                
                // Ищем скачанный файл субтитров
                const glob = await import('glob');
                
                // yt-dlp создает файлы с расширениями .vtt, .srt и т.д.
                const possibleFiles = glob.sync(`${tempSubsFile.replace('.vtt', '')}.*`);
                const subFile = possibleFiles.find(f => 
                    f.endsWith('.vtt') || f.endsWith('.srt') || f.endsWith('.ttml')
                );
                
                if (subFile && await fs.pathExists(subFile)) {
                    let subContent = await fs.readFile(subFile, 'utf-8');
                    
                    // Очищаем VTT формат (убираем временные метки и теги)
                    subContent = subContent
                        .replace(/<[^>]+>/g, '') // Убираем HTML теги
                        .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/g, '') // Убираем временные метки
                        .replace(/^\d+$/gm, '') // Убираем номера строк
                        .replace(/WEBVTT|Kind:|Language:/gi, '')
                        .replace(/\n{3,}/g, '\n\n') // Убираем множественные переносы строк
                        .split('\n')
                        .map(line => line.trim())
                        .filter(line => line.length > 0 && !line.match(/^\d+$/))
                        .join(' ')
                        .trim();
                    
                    // Удаляем временный файл
                    await fs.remove(subFile);
                    
                    if (subContent && subContent.length > 50) {
                        console.log(`✓ Extracted transcript via yt-dlp${hasCookies ? ' (with cookies)' : ''}: ${subContent.length} chars - FULL VIDEO TRANSCRIPT`);
                        return subContent;
                    }
                }
            } catch (downloadError: any) {
                // Если автоматические субтитры недоступны, пробуем обычные
                try {
                    await ytdlp(url, {
                        ...cookiesOpts,
                        extractorArgs,
                        writeSub: true,
                        subLang: 'ru,en,uk',
                        skipDownload: true,
                        output: tempSubsFile.replace('.vtt', ''),
                        quiet: true,
                        noWarnings: true,
                    } as any);
                    
                    const glob = await import('glob');
                    const possibleFiles = glob.sync(`${tempSubsFile.replace('.vtt', '')}.*`);
                    const subFile = possibleFiles.find(f => 
                        f.endsWith('.vtt') || f.endsWith('.srt') || f.endsWith('.ttml')
                    );
                    
                    if (subFile && await fs.pathExists(subFile)) {
                        let subContent = await fs.readFile(subFile, 'utf-8');
                        subContent = subContent
                            .replace(/<[^>]+>/g, '')
                            .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/g, '')
                            .replace(/^\d+$/gm, '')
                            .replace(/WEBVTT|Kind:|Language:/gi, '')
                            .replace(/\n{3,}/g, '\n\n')
                            .split('\n')
                            .map(line => line.trim())
                            .filter(line => line.length > 0 && !line.match(/^\d+$/))
                            .join(' ')
                            .trim();
                        
                        await fs.remove(subFile);
                        
                        if (subContent && subContent.length > 50) {
                            console.log(`✓ Extracted transcript via yt-dlp${hasCookies ? ' (with cookies)' : ''} (manual subs): ${subContent.length} chars - FULL VIDEO TRANSCRIPT`);
                            return subContent;
                        }
                    }
                } catch (manualSubError: any) {
                    // Оба метода провалились
                    console.log(`   ⚠️ Both auto and manual subtitles unavailable via yt-dlp`);
                }
            }
            
            return null;
        } catch (error: any) {
            console.warn(`yt-dlp transcript extraction failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Получает метаданные YouTube видео через YouTube Data API v3 (не требует cookies/Puppeteer)
     */
    private async fetchMetadataWithYouTubeAPI(url: string): Promise<ExtractedContent | null> {
        const apiKey = process.env.YOUTUBE_API_KEY;
        if (!apiKey || apiKey === 'your_youtube_api_key_here') {
            return null;
        }

        try {
            // Извлекаем video ID из URL
            const videoIdMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/);
            if (!videoIdMatch || !videoIdMatch[1]) {
                return null;
            }
            const videoId = videoIdMatch[1];

            const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${apiKey}`;
            const response = await fetch(apiUrl, {
                signal: AbortSignal.timeout(10000) // 10 секунд таймаут
            });

            if (!response.ok) {
                if (response.status === 403) {
                    console.warn('⚠️ YouTube API quota exceeded or invalid API key');
                }
                return null;
            }

            const data = await response.json();
            if (!data.items || data.items.length === 0) {
                return null;
            }

            const snippet = data.items[0].snippet;
            const title = snippet?.title || '';
            const description = snippet?.description || '';

            if (!title && !description) {
                return null;
            }

            const contentParts: string[] = [];
            if (title) contentParts.push(`Название: ${title}`);
            if (description) contentParts.push(`\n\nОписание: ${description}`);

            const content = contentParts.join('') + 
                '\n\n⚠️ ВАЖНО: Это только метаданные видео (название и описание) через YouTube API. Полная расшифровка видео недоступна. Анализ проводится ТОЛЬКО на основе этих метаданных.';

            console.log('✓ Extracted metadata via YouTube Data API v3');
            return { content, sourceType: 'metadata' };
        } catch (error: any) {
            if (error.name === 'AbortError') {
                console.warn('⚠️ YouTube API request timed out');
            } else {
                console.warn(`⚠️ YouTube API metadata extraction failed: ${error.message}`);
            }
            return null;
        }
    }

    /**
     * Быстро получает метаданные видео через yt-dlp (без Puppeteer)
     */
    private async fetchMetadataWithYtDlp(url: string): Promise<ExtractedContent | null> {
        try {
            // @ts-ignore - yt-dlp-exec types may not быть доступны
            const ytdlp = (await import('yt-dlp-exec')).default;
            const rawResult = await ytdlp(url, {
                ...this.getYtDlpCookiesOptions(),
                extractorArgs: 'youtube:player_client=web_embedded,web,android',
                dumpSingleJson: true,
                noWarnings: true,
                simulate: true,
                skipDownload: true,
                quiet: true,
            } as any);

            const parsed = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
            const title = parsed?.title || parsed?.fulltitle;
            const description = parsed?.description || parsed?.shortDescription;

            if (!title && !description) {
                return null;
            }

            const contentParts: string[] = [];
            if (title) contentParts.push(`Название: ${title}`);
            if (description) contentParts.push(`\n\nОписание: ${description}`);

            const content =
                contentParts.join('') +
                '\n\n⚠️ ВАЖНО: Это только метаданные видео (название и описание). Полная расшифровка видео недоступна. Анализ проводится ТОЛЬКО на основе этих метаданных, без доступа к полному содержанию видео.';

            console.log('✓ Extracted metadata via yt-dlp');
            return { content, sourceType: 'metadata' };
        } catch (error: any) {
            console.warn(`yt-dlp metadata extraction failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Определяет видеоплатформу по URL
     */
    private detectVideoPlatform(url: string): string | null {
        const patterns: { [key: string]: RegExp[] } = {
            youtube: [
                /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=|embed\/|v\/|shorts\/|.+\?v=)?([^"&?\/\s]{11})/,
            ],
            vk: [
                /(?:https?:\/\/)?(?:www\.)?(?:vk\.com|vkontakte\.ru)\/video(-?\d+_\d+)/,
                /(?:https?:\/\/)?(?:www\.)?vk\.com\/.*video/,
                /(?:https?:\/\/)?(?:www\.)?vkvideo\.ru\/video(-?\d+_\d+)/,
            ],
            tiktok: [
                /(?:https?:\/\/)?(?:www\.)?(?:tiktok\.com|vm\.tiktok\.com)\/.+/,
            ],
            rutube: [
                /(?:https?:\/\/)?(?:www\.)?rutube\.ru\/video\/([a-zA-Z0-9]+)/,
            ],
            dzen: [
                /(?:https?:\/\/)?(?:www\.)?dzen\.ru\/video\/watch\/([a-zA-Z0-9]+)/,
                /(?:https?:\/\/)?(?:www\.)?dzen\.ru\/video\/([a-zA-Z0-9]+)/,
            ],
            yandex: [
                /(?:https?:\/\/)?(?:www\.)?yandex\.ru\/video\/(?:search|preview)\?.*/,
            ],
            instagram: [
                /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|p)\/([a-zA-Z0-9_-]+)/,
            ],
            facebook: [
                /(?:https?:\/\/)?(?:www\.)?(?:facebook\.com|fb\.com)\/watch\/?.*/,
            ],
            twitter: [
                /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/.+\/status\/\d+/,
            ],
        };

        for (const [platform, platformPatterns] of Object.entries(patterns)) {
            if (platformPatterns.some(pattern => pattern.test(url))) {
                return platform;
            }
        }

        return null;
    }

    private isYoutubeUrl(url: string): boolean {
        return this.detectVideoPlatform(url) === 'youtube';
    }

    private async scrapeArticleWithPuppeteer(url: string): Promise<ExtractedContent> {
        console.log(`Attempting to scrape article with Puppeteer from: ${url}`);
        let browser = null;
        try {
            console.log('Initializing headless browser...');
            const launchOptions = await this.getPuppeteerLaunchOptions();
            browser = await puppeteer.launch(launchOptions);
            console.log('✓ Headless browser initialized.');

            const page = await browser.newPage();
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            
            // A more generic approach to get main content
            const content = await page.evaluate(() => {
                const mainContentSelectors = ['article', 'main', '.post-content', '.article-body', 'body'];
                let mainEl = null;
                for (const selector of mainContentSelectors) {
                    mainEl = document.querySelector(selector);
                    if (mainEl) break;
                }
                
                if (!mainEl) return 'Could not find main content.';

                // Remove non-essential elements
                mainEl.querySelectorAll('script, style, nav, header, footer, aside, form, button, .comments, #comments').forEach((el: Element) => el.remove());

                // Get text, preferring longer paragraphs
                const paragraphs = Array.from(mainEl.querySelectorAll('p, h1, h2, h3, li, pre, code'));
                return paragraphs
                    .map(p => p.textContent)
                    .filter((text): text is string => text !== null && text.trim().length > 20)
                    .join('\n\n');
            });
            
            if (content.trim().length < 100) {
                throw new Error('Scraped content is too short. The article might be behind a paywall or protected.');
            }

            console.log(`✓ Successfully scraped article with Puppeteer (${content.length} chars)`);
            return { content, sourceType: 'article' };

        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error(`✗ Puppeteer scraping failed: ${errorMessage}`);
            // Выбрасываем ошибку вместо возврата сообщения об ошибке как контента
            throw new Error(`Не удалось извлечь контент из статьи. ${errorMessage}`);
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }

    /**
     * Универсальный метод извлечения метаданных видео через Puppeteer
     */
    private async extractVideoMetadata(url: string, platform: string): Promise<ExtractedContent | null> {
        let browser = null;
        try {
            console.log(`Extracting metadata from ${platform} video: ${url}`);
            const launchOptions = await this.getPuppeteerLaunchOptions();
            try {
                browser = await puppeteer.launch(launchOptions);
            } catch (launchError: any) {
                const errorMsg = launchError.message || 'Unknown error';
                if (errorMsg.includes('Target crashed') || errorMsg.includes('Protocol error')) {
                    console.warn(`⚠️ Browser crashed during launch for ${platform}: ${errorMsg}. Puppeteer unavailable.`);
                    return null;
                }
                throw launchError;
            }
            const page = await browser.newPage();
            
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
            });

            // Для VK увеличиваем время ожидания и используем networkidle для полной загрузки
            const waitUntil = platform === 'vk' ? 'networkidle2' : 'domcontentloaded';
            const timeout = platform === 'vk' ? 90000 : 60000;
            
            await page.goto(url, { 
                waitUntil,
                timeout
            });

            // Ждем загрузки контента (для VK нужно больше времени)
            const waitTime = platform === 'vk' ? 5000 : 3000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            
            // Для VK дополнительно ждем загрузки видео-плеера
            if (platform === 'vk') {
                try {
                    await page.waitForSelector('video, [class*="video"], [class*="Video"]', { timeout: 5000 });
                } catch (e) {
                    // Игнорируем, если видео-плеер не найден
                }
            }

            // Извлекаем метаданные в зависимости от платформы
            const metadata = await page.evaluate((platform: string) => {
                let title = '';
                let description = '';
                let additionalText = '';

                // Общие селекторы для названия
                const titleSelectors = [
                    'h1',
                    'meta[property="og:title"]',
                    'meta[name="twitter:title"]',
                    '[class*="title"]',
                    '[class*="Title"]',
                    'title'
                ];

                // Общие селекторы для описания
                const descriptionSelectors = [
                    'meta[property="og:description"]',
                    'meta[name="twitter:description"]',
                    'meta[name="description"]',
                    '[class*="description"]',
                    '[class*="Description"]',
                ];

                // Платформо-специфичные селекторы (ОБНОВЛЕНО с универсальными вариантами)
                const platformSelectors: { [key: string]: { title: string[], description: string[], text?: string[], comments?: string[] } } = {
                    vk: {
                        // Актуальные селекторы для нового дизайна VK + fallback на старые
                        title: [
                            // Новый дизайн VK
                            '[class*="VideoPageTitleContainer"] [class*="title"]',
                            '.VideoPageTitleContainer_title__*',
                            '[class*="VideoPage"] [class*="title"]',
                            '[class*="VideoInfo"] [class*="title"]',
                            // Старый дизайн
                            'h1.wall_post_text',
                            '.video_page_title',
                            '.video_info_title',
                            '.mv_title',
                            // Универсальные
                            'h1[class*="title"]',
                            'h1[class*="Title"]',
                            '[data-testid="video-title"]',
                            '[data-l="video-title"]',
                            '[data-l="t,video-title"]',
                            'h1',
                            // Meta теги (самые надежные)
                            'meta[property="og:title"]',
                            'meta[name="twitter:title"]',
                            'title'
                        ],
                        description: [
                            // Новый дизайн VK
                            '[class*="VideoPageTitleContainer"] [class*="description"]',
                            '.VideoPageTitleContainer_description__*',
                            '[class*="VideoPage"] [class*="description"]',
                            '[class*="VideoInfo"] [class*="description"]',
                            // Старый дизайн
                            '.video_info_desc',
                            '.mv_description',
                            'h1.wall_post_text',
                            // Универсальные
                            '[class*="description"]',
                            '[class*="Description"]',
                            '[data-testid="video-description"]',
                            '[data-l="video-description"]',
                            '[data-l="t,video-description"]',
                            // Meta теги (самые надежные)
                            'meta[property="og:description"]',
                            'meta[name="twitter:description"]',
                            'meta[name="description"]'
                        ],
                        text: [
                            '.wall_post_text', 
                            '.video_info_desc', 
                            '.video_info_text',
                            '[class*="video"] [class*="text"]',
                            '[class*="post"] [class*="text"]',
                            '[class*="VideoPage"] [class*="text"]'
                        ],
                        comments: [
                            '[class*="comment"] [class*="text"]',
                            '[class*="reply"] [class*="text"]',
                            '.reply_text', 
                            '.comment_text', 
                            '.wall_item_text',
                            '[data-testid="comment-text"]'
                        ]
                    },
                    tiktok: {
                        title: ['h1[data-e2e="browse-video-desc"]', '.video-meta-title'],
                        description: ['[data-e2e="browse-video-desc"]', '.video-meta-desc'],
                        text: ['[data-e2e="browse-video-desc"]']
                    },
                    rutube: {
                        // Актуальные селекторы для нового дизайна RuTube + fallback
                        title: [
                            '.video-info__title',
                            '[class*="video"] [class*="title"]',
                            '[class*="Video"] [class*="Title"]',
                            '.video-title', 
                            'h1.video-title',
                            'h1[class*="title"]',
                            'h1',
                            'meta[property="og:title"]',
                            'meta[name="twitter:title"]'
                        ],
                        description: [
                            '.video-info__description-text',
                            '[class*="video"] [class*="description"]',
                            '[class*="description"]',
                            '.video-description', 
                            '.description',
                            '.video-info__description',
                            'meta[property="og:description"]',
                            'meta[name="twitter:description"]'
                        ],
                        text: [
                            '.video-info__description-text',
                            '[class*="video"] [class*="text"]',
                            '.video-description', 
                            '.video-info__description',
                            '[class*="description"]'
                        ],
                        comments: [
                            '[class*="comment"] [class*="text"]',
                            '.comment-text', 
                            '.comment__text',
                            '[class*="comment"]',
                            '[data-testid="comment-text"]'
                        ]
                    },
                    dzen: {
                        title: ['.video-card-title', 'h1'],
                        description: ['.video-card-description', '.description'],
                        text: ['.video-card-description']
                    },
                    instagram: {
                        title: ['h1', 'article h1'],
                        description: ['meta[property="og:description"]'],
                        text: ['article span']
                    },
                    facebook: {
                        title: ['h1', '[data-testid="post_message"]'],
                        description: ['[data-testid="post_message"]'],
                        text: ['[data-testid="post_message"]']
                    },
                    twitter: {
                        title: ['h1', '[data-testid="tweetText"]'],
                        description: ['[data-testid="tweetText"]'],
                        text: ['[data-testid="tweetText"]']
                    }
                };

                // Пробуем платформо-специфичные селекторы
                const selectors = platformSelectors[platform] || {};
                const allTitleSelectors = [...(selectors.title || []), ...titleSelectors];
                const allDescSelectors = [...(selectors.description || []), ...descriptionSelectors];
                const textSelectors = selectors.text || [];

                // Извлекаем название
                for (const selector of allTitleSelectors) {
                    try {
                        if (selector.startsWith('meta')) {
                            const meta = document.querySelector(selector);
                            if (meta) {
                                title = meta.getAttribute('content') || '';
                                if (title) break;
                            }
                        } else {
                            // Пробуем querySelector, если не работает - пробуем querySelectorAll с фильтрацией
                            const el = document.querySelector(selector);
                            if (el) {
                                title = el.textContent?.trim() || '';
                                if (title && title.length > 5) break;
                            } else if (selector.includes('*')) {
                                // Для селекторов с * пробуем найти через querySelectorAll
                                const allElements = Array.from(document.querySelectorAll(selector.replace(/\*/g, '')));
                                for (const elem of allElements) {
                                    const text = elem.textContent?.trim();
                                    if (text && text.length > 5) {
                                        title = text;
                                        break;
                                    }
                                }
                                if (title) break;
                            }
                        }
                    } catch (e) {
                        // Игнорируем ошибки невалидных селекторов
                        continue;
                    }
                }

                // Извлекаем описание
                for (const selector of allDescSelectors) {
                    try {
                        if (selector.startsWith('meta')) {
                            const meta = document.querySelector(selector);
                            if (meta) {
                                description = meta.getAttribute('content') || '';
                                if (description) break;
                            }
                        } else {
                            const el = document.querySelector(selector);
                            if (el) {
                                description = el.textContent?.trim() || '';
                                if (description && description.length > 10) break;
                            } else if (selector.includes('*')) {
                                // Для селекторов с * пробуем найти через querySelectorAll
                                const allElements = Array.from(document.querySelectorAll(selector.replace(/\*/g, '')));
                                for (const elem of allElements) {
                                    const text = elem.textContent?.trim();
                                    if (text && text.length > 10) {
                                        description = text;
                                        break;
                                    }
                                }
                                if (description) break;
                            }
                        }
                    } catch (e) {
                        // Игнорируем ошибки невалидных селекторов
                        continue;
                    }
                }

                // Извлекаем дополнительный текст (комментарии, подписи и т.д.)
                if (textSelectors.length > 0) {
                    const texts: string[] = [];
                    textSelectors.forEach(selector => {
                        const elements = Array.from(document.querySelectorAll(selector));
                        elements.forEach(el => {
                            const text = el.textContent?.trim();
                            if (text && text.length > 20 && text !== title && text !== description) {
                                texts.push(text);
                            }
                        });
                    });
                    additionalText = texts.slice(0, 3).join(' '); // Берем первые 3 элемента
                }
                
                // Извлекаем комментарии для дополнительного контекста (если доступны)
                const commentSelectors = selectors.comments || [];
                if (commentSelectors.length > 0) {
                    const comments: string[] = [];
                    commentSelectors.forEach(selector => {
                        const elements = Array.from(document.querySelectorAll(selector));
                        elements.forEach(el => {
                            const text = el.textContent?.trim();
                            if (text && text.length > 10) {
                                comments.push(text);
                            }
                        });
                    });
                    // Берем первые 5 комментариев для контекста
                    if (comments.length > 0) {
                        const commentsText = comments.slice(0, 5).join(' | ');
                        if (additionalText) {
                            additionalText += `\n\nКомментарии: ${commentsText}`;
                        } else {
                            additionalText = `Комментарии: ${commentsText}`;
                        }
                    }
                }

                return { title, description, additionalText };
            }, platform);

            if (metadata.title || metadata.description || metadata.additionalText) {
                const contentParts: string[] = [];
                if (metadata.title) contentParts.push(`Название: ${metadata.title}`);
                if (metadata.description) contentParts.push(`\n\nОписание: ${metadata.description}`);
                if (metadata.additionalText) contentParts.push(`\n\nДополнительная информация: ${metadata.additionalText}`);

                const content = contentParts.join('') + 
                    '\n\n⚠️ ВАЖНО: Это только метаданные видео (название, описание' + 
                    (metadata.additionalText ? ', дополнительная информация со страницы' : '') + 
                    '). Полная расшифровка видео недоступна. Анализ проводится ТОЛЬКО на основе этих метаданных, без доступа к полному содержанию видео.';

                console.log(`✓ Extracted metadata from ${platform} (title: ${metadata.title ? 'yes' : 'no'}, desc: ${metadata.description ? 'yes' : 'no'})`);
                return { content, sourceType: 'metadata' };
            }

            return null;
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            if (errorMessage.includes('Target crashed') || errorMessage.includes('Protocol error') || errorMessage.includes('Browser crashed')) {
                console.warn(`⚠️ Browser crashed - Puppeteer unavailable for ${platform}`);
            } else {
                console.error(`✗ Failed to extract metadata from ${platform}: ${errorMessage}`);
            }
            return null;
        } finally {
            if (browser) {
                try {
                    await browser.close();
                } catch (closeError: any) {
                    console.warn(`⚠️ Error closing browser: ${closeError.message}`);
                }
            }
        }
    }

    /**
     * Финальный fallback: извлекает базовые метаданные (og:title, og:description) 
     * Сначала пробует простой HTTP-запрос (без браузера), потом Puppeteer
     */
    private async extractBasicMetadata(url: string): Promise<ExtractedContent | null> {
        // Сначала пробуем простой HTTP-запрос (не требует браузера)
        try {
            console.log(`Extracting basic metadata via HTTP fetch from: ${url}`);
            
            // Используем AbortController для таймаута
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
                },
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const html = await response.text();
            
            // Извлекаем og:tags и title из HTML через regex
            const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
            const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
            const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
            
            const title = ogTitleMatch?.[1] || titleMatch?.[1] || '';
            const description = ogDescMatch?.[1] || '';
            
            if (title || description) {
                const contentParts: string[] = [];
                if (title) contentParts.push(`Название: ${title}`);
                if (description) contentParts.push(`\n\nОписание: ${description}`);
                
                const content = contentParts.join('') + 
                    '\n\n⚠️ ВАЖНО: Это только базовые метаданные (og:tags). Полный контент недоступен без браузера.';
                
                console.log(`✓ Extracted basic metadata via HTTP (title: ${title ? 'yes' : 'no'}, desc: ${description ? 'yes' : 'no'})`);
                return { content, sourceType: 'metadata' };
            }
        } catch (httpError: any) {
            if (httpError.name === 'AbortError') {
                console.warn(`⚠️ HTTP metadata extraction timed out after 10 seconds`);
            } else {
                console.warn(`⚠️ HTTP metadata extraction failed: ${httpError.message}`);
            }
            console.log(`   Trying Puppeteer fallback...`);
        }
        
        // Fallback на Puppeteer (если HTTP не сработал)
        let browser = null;
        try {
            console.log(`Extracting basic metadata via Puppeteer from: ${url}`);
            const launchOptions = await this.getPuppeteerLaunchOptions();
            try {
                browser = await puppeteer.launch(launchOptions);
            } catch (launchError: any) {
                const errorMsg = launchError.message || 'Unknown error';
                if (errorMsg.includes('Target crashed') || errorMsg.includes('Protocol error')) {
                    console.warn(`⚠️ Browser crashed during launch: ${errorMsg}. Puppeteer unavailable.`);
                    return null;
                }
                throw launchError;
            }
            const page = await browser.newPage();
            
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
            });

            // Загружаем только до domcontentloaded для скорости
            await page.goto(url, { 
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            // Извлекаем только og:tags (самые надежные метаданные)
            const metadata = await page.evaluate(() => {
                const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
                const ogDescription = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
                const title = document.querySelector('title')?.textContent || '';
                
                return {
                    title: ogTitle || title,
                    description: ogDescription
                };
            });

            if (metadata.title || metadata.description) {
                const contentParts: string[] = [];
                if (metadata.title) contentParts.push(`Название: ${metadata.title}`);
                if (metadata.description) contentParts.push(`\n\nОписание: ${metadata.description}`);

                const content = contentParts.join('') + 
                    '\n\n⚠️ ВАЖНО: Это только базовые метаданные (og:tags). Полная расшифровка видео недоступна. Анализ проводится ТОЛЬКО на основе этих метаданных, без доступа к полному содержанию видео.';

                console.log(`✓ Extracted basic metadata via Puppeteer (title: ${metadata.title ? 'yes' : 'no'}, desc: ${metadata.description ? 'yes' : 'no'})`);
                return { content, sourceType: 'metadata' };
            }

            return null;
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            if (errorMessage.includes('Target crashed') || errorMessage.includes('Protocol error') || errorMessage.includes('Browser crashed')) {
                console.warn(`⚠️ Browser crashed - Puppeteer unavailable for basic metadata`);
            } else {
                console.warn(`⚠️ Puppeteer metadata extraction failed: ${errorMessage}`);
            }
            return null;
        } finally {
            if (browser) {
                try {
                    await browser.close();
                } catch (closeError: any) {
                    console.warn(`⚠️ Error closing browser: ${closeError.message}`);
                }
            }
        }
    }

    isYoutubePlaylistUrl(url: string): boolean {
        const playlistPattern = /^https?:\/\/(www\.)?youtube\.com\/(playlist|watch).*list=([^&\n?#]+)/;
        return playlistPattern.test(url);
    }

    async extractVideoUrlsFromPlaylist(playlistUrl: string): Promise<string[]> {
        try {
            const playlist = await play.playlist_info(playlistUrl, { incomplete: true });
            const videos = await playlist.all_videos();
            return videos.map(video => video.url).filter(Boolean);
        } catch (error: any) {
            console.error(`Failed to extract videos from playlist: ${playlistUrl}`, error);
            throw new Error(`Failed to extract videos from playlist: ${error.message}`);
        }
    }

    /**
     * Основной метод для транскрибации видео
     * Поддерживает внешние API (Teamlogs, Audio-Transcription.ru и др.) и локальную транскрибацию как fallback
     */
    private async transcribeVideo(url: string, platform: string): Promise<string> {
        // Приоритет 1: Внешние API для транскрибации (быстро и надежно)
        
        // Teamlogs API (Российский сервис)
        if (process.env.TEAMLOGS_API_KEY) {
            try {
                console.log(`🌐 Using Teamlogs API for transcription...`);
                const response = await fetch(`https://api.teamlogs.ru/v1/transcribe`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.TEAMLOGS_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ url, language: 'ru' })
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.text && data.text.trim().length > 50) {
                        console.log(`✓ Got transcript from Teamlogs API (${data.text.length} chars)`);
                        return data.text;
                    }
                }
            } catch (error: any) {
                console.warn(`⚠️ Teamlogs API failed: ${error.message}. Falling back...`);
            }
        }
        
        // Audio-Transcription.ru API (Российский сервис)
        if (process.env.AUDIO_TRANSCRIPTION_API_KEY) {
            try {
                console.log(`🌐 Using Audio-Transcription.ru API for transcription...`);
                const response = await fetch(`https://api.audio-transcription.ru/v1/transcribe`, {
                    method: 'POST',
                    headers: {
                        'X-API-Key': process.env.AUDIO_TRANSCRIPTION_API_KEY,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ url, language: 'ru' })
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.text && data.text.trim().length > 50) {
                        console.log(`✓ Got transcript from Audio-Transcription.ru API (${data.text.length} chars)`);
                        return data.text;
                    }
                }
            } catch (error: any) {
                console.warn(`⚠️ Audio-Transcription.ru API failed: ${error.message}. Falling back...`);
            }
        }
        
        // Универсальный API ключ (если используется другой сервис)
        if (process.env.TRANSCRIPTION_API_KEY && process.env.TRANSCRIPTION_API_URL) {
            try {
                console.log(`🌐 Using custom transcription API...`);
                const response = await fetch(process.env.TRANSCRIPTION_API_URL, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.TRANSCRIPTION_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ url, platform, language: 'ru' })
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.text && data.text.trim().length > 50) {
                        console.log(`✓ Got transcript from custom API (${data.text.length} chars)`);
                        return data.text;
                    }
                }
            } catch (error: any) {
                console.warn(`⚠️ Custom transcription API failed: ${error.message}. Falling back...`);
            }
        }
        
        // Приоритет 2: Локальная транскрибация (скачивание + Whisper)
        const tempDir = path.join(os.tmpdir(), 'video-transcription');
        await fs.ensureDir(tempDir);
        
        const videoId = this.extractVideoId(url, platform);
        const videoPath = path.join(tempDir, `${videoId}.mp4`);
        const audioPath = path.join(tempDir, `${videoId}.wav`);

        try {
            // Шаг 1: Скачиваем видео
            console.log(`📥 Downloading video from ${platform}...`);
            await this.downloadVideo(url, videoPath, platform);
            
            // Шаг 2: Извлекаем аудио
            console.log(`🎵 Extracting audio from video...`);
            await this.extractAudioFromVideo(videoPath, audioPath);
            
            // Шаг 3: Транскрибируем аудио
            console.log(`🎤 Transcribing audio...`);
            const transcript = await this.transcribeAudio(audioPath);
            
            return transcript;
        } catch (error: any) {
            const errorMsg = error.message || 'Unknown error';
            console.error(`✗ Transcription failed for ${platform}: ${errorMsg}`);
            console.error(`   Full error:`, error);
            // Пробрасываем ошибку дальше, чтобы система могла использовать метаданные
            throw error;
        } finally {
            // Очищаем временные файлы
            try {
                if (await fs.pathExists(videoPath)) await fs.remove(videoPath);
                if (await fs.pathExists(audioPath)) await fs.remove(audioPath);
            } catch (cleanupError) {
                console.warn('Failed to cleanup temp files:', cleanupError);
            }
        }
    }

    /**
     * Извлекает ID видео из URL
     */
    private extractVideoId(url: string, platform: string): string {
        const patterns: { [key: string]: RegExp | RegExp[] } = {
            youtube: /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([^&\n?#]+)/,
            vk: [
                /vk\.com\/video(-?\d+_\d+)/,
                /vkvideo\.ru\/video(-?\d+_\d+)/,
                /vkontakte\.ru\/video(-?\d+_\d+)/,
            ],
            rutube: /rutube\.ru\/video\/([a-zA-Z0-9]+)/,
            tiktok: /tiktok\.com\/.+\/video\/(\d+)/,
            dzen: [
                /dzen\.ru\/video\/watch\/([a-zA-Z0-9]+)/,
                /dzen\.ru\/video\/([a-zA-Z0-9]+)/,
            ],
            instagram: /instagram\.com\/(?:reel|p)\/([a-zA-Z0-9_-]+)/,
            twitter: /(?:twitter\.com|x\.com)\/.+\/status\/(\d+)/,
        };

        const pattern = patterns[platform];
        if (pattern) {
            if (Array.isArray(pattern)) {
                // Для VK пробуем все паттерны
                for (const p of pattern) {
                    const match = url.match(p);
                    if (match && match[1]) {
                        return match[1].replace(/[^a-zA-Z0-9]/g, '_');
                    }
                }
            } else {
                const match = url.match(pattern);
                if (match && match[1]) {
                    return match[1].replace(/[^a-zA-Z0-9]/g, '_');
                }
            }
        }

        // Fallback: используем хеш URL
        return Buffer.from(url).toString('base64').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);
    }

    /**
     * Скачивает видео с платформы
     */
    private async downloadVideo(url: string, outputPath: string, platform: string): Promise<void> {
        try {
            console.log(`📥 Downloading video from ${platform}...`);
            
            // 1. Быстрая попытка через play-dl
            try {
                const stream = await play.stream(url, { quality: 2 });
                const writeStream = fs.createWriteStream(outputPath);
                
                await new Promise<void>((resolve, reject) => {
                    stream.stream.pipe(writeStream);
                    writeStream.on('finish', () => {
                        console.log('✓ Video downloaded via play-dl');
                        resolve();
                    });
                    writeStream.on('error', (err: Error) => {
                        console.error('✗ Video download failed (play-dl stream error):', err);
                        reject(err);
                    });
                });
                return;
            } catch (playDlError: any) {
                console.warn(`play-dl failed for ${platform}: ${playDlError?.message || playDlError}. Falling back to yt-dlp...`);
            }
            
            // 2. Надёжный fallback — yt-dlp (поддерживает RuTube, YouTube и др.)
            await this.downloadWithYtDlp(url, outputPath);
        } catch (error: any) {
            throw new Error(`Failed to download video from ${platform}: ${error.message}`);
        }
    }

    private async downloadWithYtDlp(url: string, outputPath: string): Promise<void> {
        console.log('🎞️ Using yt-dlp fallback to download video...');
        try {
            // @ts-ignore - yt-dlp-exec types may not be available
            const ytdlp = (await import('yt-dlp-exec')).default;
            const normalizedOutput = outputPath.endsWith('.mp4') ? outputPath : `${outputPath}.mp4`;

            // Специальные опции для VK и других платформ, которые могут требовать авторизацию
            const options: any = {
                ...this.getYtDlpCookiesOptions(),
                output: normalizedOutput,
                format: 'bestvideo*+bestaudio/best',
                mergeOutputFormat: 'mp4',
                quiet: true,
                restrictFilenames: true,
                noWarnings: true,
            };

            // Для VK добавляем дополнительные опции
            if (url.includes('vk.com') || url.includes('vkvideo.ru') || url.includes('vkontakte.ru')) {
                // Пробуем скачать без авторизации, если не получится - будет ошибка
                options.extractorArgs = {
                    vk: ['--no-check-certificate']
                };
            }

            await ytdlp(url, options);

            // Проверяем, что файл действительно скачался
            if (!(await fs.pathExists(normalizedOutput))) {
                throw new Error('Video file was not created after download');
            }

            const stats = await fs.stat(normalizedOutput);
            if (stats.size === 0) {
                throw new Error('Downloaded video file is empty');
            }

            console.log(`✓ Video downloaded via yt-dlp (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
        } catch (error: any) {
            const errorMsg = error.message || 'Unknown error';
            console.error(`✗ yt-dlp download failed: ${errorMsg}`);
            
            // Более информативное сообщение об ошибке
            if (errorMsg.includes('Private video') || errorMsg.includes('Sign in')) {
                throw new Error('Video is private or requires authentication. Cannot download.');
            } else if (errorMsg.includes('Unsupported URL') || errorMsg.includes('No video formats')) {
                throw new Error('Video format not supported or video is unavailable.');
            } else {
                throw new Error(`yt-dlp failed: ${errorMsg}`);
            }
        }
    }

    /**
     * Извлекает аудио из видео файла
     */
    private async extractAudioFromVideo(videoPath: string, audioPath: string): Promise<void> {
        return new Promise(async (resolve, reject) => {
            try {
                // @ts-ignore - fluent-ffmpeg types may not be available
                const ffmpeg = await import('fluent-ffmpeg');
                // @ts-ignore - @ffmpeg-installer/ffmpeg types may not be available
                const ffmpegInstaller = await import('@ffmpeg-installer/ffmpeg');
                
                // Set ffmpeg path if available
                if (ffmpegInstaller.default?.path) {
                    ffmpeg.default.setFfmpegPath(ffmpegInstaller.default.path);
                }
                
                ffmpeg.default(videoPath)
                    .outputOptions([
                        '-vn', // No video
                        '-acodec', 'pcm_s16le', // PCM 16-bit
                        '-ar', '16000', // Sample rate 16kHz (оптимально для Whisper)
                        '-ac', '1' // Mono
                    ])
                    .output(audioPath)
                    .on('end', () => {
                        console.log('✓ Audio extracted successfully');
                        resolve();
                    })
                    .on('error', (err: any) => {
                        console.error('✗ Audio extraction failed:', err);
                        reject(err);
                    })
                    .run();
            } catch (error: any) {
                reject(new Error(`Failed to extract audio: ${error.message}`));
            }
        });
    }

    /**
     * Транскрибирует аудио файл в текст
     */
    private async transcribeAudio(audioPath: string): Promise<string> {
        // Приоритет: OpenAI Whisper API (если доступен), затем локальный Whisper
        if (process.env.OPENAI_API_KEY) {
            try {
                console.log('Using OpenAI Whisper API for transcription...');
                const OpenAI = (await import('openai')).default;
                const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                const fileStream = fs.createReadStream(audioPath);
                const transcription = await openai.audio.transcriptions.create({
                    file: fileStream as any,
                    model: 'whisper-1',
                    language: 'ru',
                });
                return transcription.text;
            } catch (error: any) {
                console.warn(`OpenAI Whisper API failed: ${error.message}, falling back to local Whisper...`);
            }
        }

        // Fallback: локальный Whisper через @xenova/transformers
        try {
            console.log('Using local Whisper model for transcription (this may take a while)...');
            // @ts-ignore - @xenova/transformers types may not be available
            const { pipeline } = await import('@xenova/transformers');
            // @ts-ignore - wav-decoder types may not be available
            const wavDecoder = await import('wav-decoder');

            // Загружаем wav-файл и преобразуем в Float32Array,
            // поскольку в Node.js нет AudioContext
            const audioBuffer = await fs.readFile(audioPath);
            const arrayBuffer = audioBuffer.buffer.slice(
                audioBuffer.byteOffset,
                audioBuffer.byteOffset + audioBuffer.byteLength
            );
            const decodedWav = await wavDecoder.decode(arrayBuffer);
            const channelData = decodedWav.channelData?.[0];

            if (!channelData) {
                throw new Error('Decoded audio has no channel data');
            }

            const transcriber = await pipeline(
                'automatic-speech-recognition',
                'Xenova/whisper-small',
                // @ts-ignore - device option is supported at runtime
                { device: 'cpu' }
            );

            const result = await transcriber(channelData, {
                language: 'russian',
                task: 'transcribe',
                // @ts-ignore - sampling_rate is supported at runtime
                sampling_rate: decodedWav.sampleRate,
            } as any);

            return (result as any).text || '';
        } catch (error: any) {
            throw new Error(`Transcription failed: ${error.message}`);
        }
    }
}

export default new ContentService();
