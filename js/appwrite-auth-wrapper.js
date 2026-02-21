// Appwrite Auth Wrapper - для обеспечения совместимости с существующим кодом
window.auth = (function() {
    let currentUser = null;
    
    // Инициализация текущего пользователя
    async function initializeCurrentUser() {
        try {
            const account = await AppwriteClient.account.get();
            currentUser = {
                uid: account.$id,
                email: account.email,
                name: account.name
            };
            return currentUser;
        } catch (error) {
            console.log('User not logged in:', error);
            currentUser = null;
            return null;
        }
    }

    // Функция для проверки состояния аутентификации (для совместимости)
    async function onAuthStateChanged(callback) {
        try {
            const user = await initializeCurrentUser();
            callback(user);
            
            // Установим прослушивание событий аутентификации через Appwrite
            AppwriteClient.realtime.subscribe(['account'], response => {
                if(response.events.includes('account.create')) {
                    initializeCurrentUser().then(user => callback(user));
                } else if(response.events.includes('account.delete')) {
                    currentUser = null;
                    callback(null);
                }
            });
        } catch (error) {
            callback(null);
        }
    }

    // Функции регистрации и входа
    async function createUserWithEmailAndPassword(email, password) {
        try {
            const account = await AppwriteClient.account.create(
                'unique()', 
                email, 
                password,
                email.split('@')[0] // Используем часть email как имя
            );
            
            await AppwriteClient.account.createEmailSession(email, password);
            return { user: { uid: account.$id, email: account.email } };
        } catch (error) {
            throw new Error(error.message);
        }
    }

    async function signInWithEmailAndPassword(email, password) {
        try {
            const session = await AppwriteClient.account.createEmailSession(email, password);
            await initializeCurrentUser();
            return { user: currentUser };
        } catch (error) {
            throw new Error(error.message);
        }
    }

    async function signOut() {
        try {
            await AppwriteClient.account.deleteSession('current');
            currentUser = null;
        } catch (error) {
            console.error('Error signing out:', error);
        }
    }

    // Функция для получения текущего пользователя
    function getCurrentUser() {
        return currentUser;
    }

    // Возвращаем API, совместимый с Firebase
    return {
        onAuthStateChanged: onAuthStateChanged,
        createUserWithEmailAndPassword: createUserWithEmailAndPassword,
        signInWithEmailAndPassword: signInWithEmailAndPassword,
        signOut: signOut,
        currentUser: getCurrentUser()
    };
})();