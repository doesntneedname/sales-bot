# Используйте официальный образ Node.js как базовый
FROM node:16

# Создайте рабочую директорию
WORKDIR /app

# Скопируйте package.json и package-lock.json (если есть)
COPY package*.json ./

# Установите зависимости
RUN npm install

# Скопируйте остальные файлы в рабочую директорию
COPY . .

# Откройте порт 3000 для приложения
EXPOSE 3000

# Команда для запуска приложения
CMD ["node", "server.js"]
