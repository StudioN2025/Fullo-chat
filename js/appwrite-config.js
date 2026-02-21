// Appwrite configuration
import { Client, Account, Databases, Realtime, Storage } from 'https://cdn.skypack.dev/appwrite';

const client = new Client();

client
    .setEndpoint('https://your-appwrite-instance.com/v1') // Замените на ваш URL Appwrite
    .setProject('your-project-id'); // Замените на ваш Project ID

const account = new Account(client);
const databases = new Databases(client);
const realtime = new Realtime(client);
const storage = new Storage(client);

// Глобальные переменные для использования в других модулях
window.AppwriteClient = {
    client,
    account,
    databases,
    realtime,
    storage,
    databaseId: 'your-database-id', // Замените на ваш Database ID
    usersCollectionId: 'users',
    roomsCollectionId: 'rooms',
    messagesCollectionId: 'messages'
};

console.log('Appwrite initialized successfully');