# Настройка Appwrite для работы с приложением

## Шаг 1: Установка Appwrite

Если у вас еще нет экземпляра Appwrite, установите его следующим образом:

```bash
docker network create appwrite-tier --driver bridge

docker run -it --rm \
    --network appwrite-tier \
    --volume /dev/null:/var/run/docker.sock \
    --volume $(pwd)/appwrite:/usr/src/code/appwrite/storage/uploads:rw \
    --volume $(pwd)/certs:/usr/src/code/appwrite/public/certs:rw \
    --volume $(pwd)/config:/usr/src/code/appwrite/config:ro \
    --volume $(pwd)/functions:/usr/src/code/appwrite/functions:rw \
    appwrite/install:0.23.1
```

## Шаг 2: Создание проекта

1. Перейдите в консоль управления Appwrite (обычно доступна по адресу `http://localhost:8080`)
2. Нажмите "Create Project"
3. Введите название проекта и ID (например, `fullochat`)
4. Скопируйте Project ID для дальнейшего использования

## Шаг 3: Настройка базы данных

Создайте базу данных и коллекции:

1. Перейдите в раздел "Database"
2. Нажмите "Add Database"
3. Назовите базу данных (например, `fullochat_db`)
4. Создайте следующие коллекции:

### Коллекция "users"
- Название: `users`
- ID: `users`
- Включите права доступа: 
  - Read: `user:$all`
  - Write: `user:$owner`
- Добавьте атрибуты:
  - `displayName` (string, 255, required)
  - `email` (string, 255, required)
  - `profileCompleted` (boolean, required, default: false)
  - `online` (boolean, required, default: false)
  - `lastSeen` (string, 255, optional)
  - `status` (string, 100, optional, default: "online")
  - `notifyMessages` (boolean, required, default: true)
  - `notifyJoin` (boolean, required, default: true)
  - `notifyLeave` (boolean, required, default: true)
  - `micVolume` (integer, optional, default: 80)
  - `speakerVolume` (integer, optional, default: 100)
  - `avatar` (string, 5000, optional)
  - `currentRoom` (string, 255, optional)
  - `banned` (boolean, optional, default: false)
  - `banExpiry` (string, 255, optional)

### Коллекция "rooms"
- Название: `rooms`
- ID: `rooms`
- Включите права доступа:
  - Read: `user:$all`
  - Write: `user:$members`
- Добавьте атрибуты:
  - `code` (string, 255, required)
  - `hostId` (string, 255, required)
  - `hostName` (string, 255, required)
  - `createdAt` (string, 255, required)
  - `participants` (string array, optional)
  - `active` (boolean, required, default: true)
  - `lastActive` (string, 255, required)
  - `createdBy` (string, 255, required)
  - `encrypted` (boolean, required, default: true)

### Подколлекция "participants" (внутри коллекции "rooms")
- Название: `participants`
- ID: `participants`
- Включите права доступа:
  - Read: `user:$all`
  - Write: `user:$owner`
- Добавьте атрибуты:
  - `userId` (string, 255, required)
  - `displayName` (string, 255, required)
  - `avatar` (string, 5000, optional)
  - `joinedAt` (string, 255, required)
  - `isHost` (boolean, required, default: false)
  - `online` (boolean, required, default: true)
  - `lastSeen` (string, 255, required)
  - `muted` (boolean, required, default: false)
  - `camera` (boolean, required, default: false)
  - `screen` (boolean, required, default: false)

### Подколлекция "signals" (внутри коллекции "rooms")
- Название: `signals`
- ID: `signals`
- Включите права доступа:
  - Read: `user:$all`
  - Write: `user:$all`
- Добавьте атрибуты:
  - `from` (string, 255, required)
  - `target` (string, 255, required)
  - `type` (string, 100, required)
  - `data` (string, 5000, optional)
  - `timestamp` (string, 255, required)
  - `encrypted` (boolean, required, default: true)

### Подколлекция "broadcasts" (внутри коллекции "rooms")
- Название: `broadcasts`
- ID: `broadcasts`
- Включите права доступа:
  - Read: `user:$all`
  - Write: `user:$all`
- Добавьте атрибуты:
  - `from` (string, 255, required)
  - `type` (string, 100, required)
  - `data` (string, 5000, optional)
  - `timestamp` (string, 255, required)
  - `encrypted` (boolean, required, default: true)

## Шаг 4: Настройка аутентификации

1. Перейдите в раздел "Authentication"
2. Включите нужные провайдеры аутентификации (Email, Google, GitHub и т.д.)
3. Убедитесь, что Email Password Authentication включен

## Шаг 5: Настройка CORS

1. Перейдите в раздел "API Console" или "Settings"
2. Добавьте домены, с которых будет происходить доступ к API (например, `http://localhost:3000`, `http://localhost:5173` или ваш домен)

## Шаг 6: Обновление конфигурации в приложении

Откройте файл `/js/appwrite-config.js` и обновите параметры:

```javascript
client
    .setEndpoint('https://your-appwrite-instance.com/v1') // Замените на ваш URL Appwrite
    .setProject('your-project-id'); // Замените на ваш Project ID

// Также обновите Database ID:
databaseId: 'your-database-id' // Замените на ваш Database ID
```

## Шаг 7: Обновление разрешений

Для корректной работы приложения убедитесь, что разрешения на чтение и запись в коллекциях настроены правильно:

1. **Users**: 
   - Чтение: Пользователи могут читать профили друг друга
   - Запись: Только владелец может редактировать свой профиль

2. **Rooms**:
   - Чтение: Все вошедшие пользователи могут читать информацию о комнате
   - Запись: Только администраторы комнаты могут редактировать

3. **Participants**:
   - Чтение: Все участники комнаты могут видеть друг друга
   - Запись: Пользователь может редактировать только свои данные

4. **Signals и Broadcasts**:
   - Чтение и запись: Все участники комнаты могут отправлять и получать сигналы

## Шаг 8: Тестирование

После настройки всех компонентов запустите приложение и проверьте:

1. Регистрацию и вход пользователей
2. Создание комнат
3. Присоединение к комнатам
4. Работу видеочата
5. Обновление статусов пользователей

## Возможные проблемы и решения

1. **Ошибка доступа к базе данных**: Проверьте правильность ID базы данных и коллекций
2. **Проблемы с аутентификацией**: Убедитесь, что включена соответствующая аутентификация
3. **Проблемы с WebRTC**: Проверьте настройки брандмауэра и STUN/TURN серверов
4. **CORS ошибки**: Убедитесь, что домен вашего приложения добавлен в список разрешенных

## Дополнительно: Настройка Storage (если требуется хранение медиафайлов)

Если ваше приложение работает с файлами (например, аватары пользователей), создайте:

1. Перейдите в раздел "Storage"
2. Создайте bucket для хранения аватаров
3. Настройте соответствующие права доступа

---

После выполнения всех этих шагов ваше приложение должно успешно работать с Appwrite вместо Firebase!