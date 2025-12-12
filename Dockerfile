# Dockerfile для бэкенда
FROM node:20-alpine

WORKDIR /app

RUN echo "https://dl-cdn.alpinelinux.org/alpine/v3.20/main" > /etc/apk/repositories && \
    echo "https://dl-cdn.alpinelinux.org/alpine/v3.20/community" >> /etc/apk/repositories && \
    apk update && apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-emoji \
    python3 \
    py3-pip \
    && rm -rf /var/cache/apk/* \
    && ln -sf python3 /usr/bin/python

# Устанавливаем переменные окружения для puppeteer
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV LD_LIBRARY_PATH=/usr/lib

# Копируем package.json и package-lock.json
COPY package*.json ./

# Устанавливаем все зависимости
RUN npm ci

# Копируем остальные файлы
COPY . .

# Компилируем TypeScript
RUN npm run build

# Открываем порт
EXPOSE 5000

# Запускаем сервер и бота вместе
# Railway автоматически установит PORT из переменных окружения
CMD ["npm", "run", "start:all"]