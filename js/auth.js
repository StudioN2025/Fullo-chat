// Auth Module
window.auth = (function() {
    // State
    let currentUser = null;
    let isAuthModeLogin = true;
    let userDisplayName = '';
    let banCheckInterval = null;
    let onlineHeartbeat = null;
    let isUserActive = false;

    // DOM Elements
    const authContainer = document.getElementById('authContainer');
    const profileContainer = document.getElementById('profileContainer');
    const roomContainer = document.getElementById('roomContainer');
    const activeRoomContainer = document.getElementById('activeRoomContainer');
    const authTitle = document.getElementById('authTitle');
    const authButton = document.getElementById('authButton');
    const switchAuthButton = document.getElementById('switchAuthButton');
    const switchAuthText = document.getElementById('switchAuthText');
    const errorMessage = document.getElementById('errorMessage');
    const successMessage = document.getElementById('successMessage');
    const displayNameSpan = document.getElementById('displayName');
    const activeDisplayNameSpan = document.getElementById('activeDisplayName');
    const emailInput = document.getElementById('emailInput');
    const passwordInput = document.getElementById('passwordInput');
    const profileNameInput = document.getElementById('profileNameInput');

    // Initialize auth state observer
    firebase.auth().onAuthStateChanged(async (user) => {
        if (user) {
            currentUser = user;
            
            // Проверяем, не забанен ли пользователь
            const isBanned = await checkIfBanned(user.uid);
            
            if (isBanned) {
                await handleBannedUser();
                return;
            }
            
            const userDoc = await db.collection('users').doc(user.uid).get();
            
            if (userDoc.exists && userDoc.data().profileCompleted) {
                userDisplayName = userDoc.data().displayName;
                
                // Обновляем статус онлайн при загрузке страницы
                await updateOnlineStatus(true);
                
                // Запускаем heartbeat для онлайн статуса
                startOnlineHeartbeat();
                
                showRoomContainer(userDisplayName);
                startBanCheck(user.uid);
            } else {
                showProfileContainer();
            }
        } else {
            showAuthContainer();
            stopOnlineHeartbeat();
            stopBanCheck();
        }
    });

    // Обновление онлайн статуса в Firestore
    async function updateOnlineStatus(online) {
        if (!currentUser) return;
        
        try {
            const userRef = db.collection('users').doc(currentUser.uid);
            
            if (online) {
                await userRef.update({
                    online: true,
                    lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
                    // Не очищаем currentRoom если он есть
                });
            } else {
                // При выходе офлайн, но сохраняем комнату если есть
                const userDoc = await userRef.get();
                const userData = userDoc.data();
                
                await userRef.update({
                    online: false,
                    lastSeen: firebase.firestore.FieldValue.serverTimestamp()
                    // currentRoom остается если пользователь в комнате
                });
            }
            
            console.log(`Online status updated: ${online}`);
        } catch (error) {
            console.error('Error updating online status:', error);
        }
    }

    // Heartbeat для онлайн статуса (каждые 10 секунд)
    function startOnlineHeartbeat() {
        if (onlineHeartbeat) clearInterval(onlineHeartbeat);
        
        // Сразу отмечаем как онлайн
        updateOnlineStatus(true);
        
        // Обновляем статус каждые 10 секунд
        onlineHeartbeat = setInterval(() => {
            if (currentUser && !document.hidden) {
                updateOnlineStatus(true);
            }
        }, 10000);
        
        // Слушаем видимость страницы
        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('beforeunload', handleBeforeUnload);
    }

    function stopOnlineHeartbeat() {
        if (onlineHeartbeat) {
            clearInterval(onlineHeartbeat);
            onlineHeartbeat = null;
        }
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('beforeunload', handleBeforeUnload);
    }

    function handleVisibilityChange() {
        if (currentUser) {
            if (document.hidden) {
                // Страница скрыта - помечаем как офлайн через 30 секунд
                setTimeout(() => {
                    if (document.hidden && currentUser) {
                        updateOnlineStatus(false);
                    }
                }, 30000);
            } else {
                // Страница снова видима - сразу онлайн
                updateOnlineStatus(true);
            }
        }
    }

    function handleBeforeUnload() {
        if (currentUser) {
            // Синхронно помечаем как офлайн при закрытии
            const url = `https://firestore.googleapis.com/v1/projects/${firebase.app().options.projectId}/databases/(default)/documents/users/${currentUser.uid}`;
            
            const offlineData = {
                fields: {
                    online: { booleanValue: false },
                    lastSeen: { timestampValue: new Date().toISOString() }
                }
            };
            
            try {
                navigator.sendBeacon(url, JSON.stringify(offlineData));
            } catch (e) {
                console.error('Error sending beacon:', e);
            }
        }
    }

    // Проверка, забанен ли пользователь
    async function checkIfBanned(uid) {
        try {
            const userDoc = await db.collection('users').doc(uid).get();
            if (!userDoc.exists) return false;
            
            const userData = userDoc.data();
            
            if (userData.banned) {
                if (userData.banExpiry) {
                    const expiryDate = userData.banExpiry.toDate();
                    if (expiryDate > new Date()) {
                        return true;
                    } else {
                        await db.collection('users').doc(uid).update({
                            banned: false,
                            banExpiry: null
                        });
                        return false;
                    }
                }
                return true;
            }
            return false;
        } catch (error) {
            console.error('Error checking ban status:', error);
            return false;
        }
    }

    // Обработка забаненного пользователя
    async function handleBannedUser() {
        showError('❌ Ваш аккаунт заблокирован');
        
        await firebase.auth().signOut();
        
        if (window.room && window.room.getCurrentRoom()) {
            await window.room.leaveRoom();
        }
        
        if (window.peer) {
            window.peer.cleanup();
        }
        
        showAuthContainer();
    }

    // Запуск проверки бана в реальном времени
    function startBanCheck(uid) {
        if (banCheckInterval) clearInterval(banCheckInterval);
        
        banCheckInterval = setInterval(async () => {
            if (currentUser) {
                const isBanned = await checkIfBanned(uid);
                if (isBanned) {
                    showError('❌ Ваш аккаунт был заблокирован');
                    
                    if (window.room && window.room.getCurrentRoom()) {
                        await window.room.leaveRoom();
                    }
                    
                    await firebase.auth().signOut();
                }
            }
        }, 30000);
        
        const unsubscribe = db.collection('users').doc(uid)
            .onSnapshot(async (doc) => {
                if (doc.exists) {
                    const userData = doc.data();
                    if (userData.banned) {
                        if (userData.banExpiry) {
                            const expiryDate = userData.banExpiry.toDate();
                            if (expiryDate > new Date()) {
                                showError('❌ Ваш аккаунт заблокирован');
                                await firebase.auth().signOut();
                            }
                        } else {
                            showError('❌ Ваш аккаунт заблокирован');
                            await firebase.auth().signOut();
                        }
                    }
                }
            }, (error) => {
                console.error('Ban listener error:', error);
            });
            
        window.__banUnsubscribe = unsubscribe;
    }

    function stopBanCheck() {
        if (banCheckInterval) {
            clearInterval(banCheckInterval);
            banCheckInterval = null;
        }
        if (window.__banUnsubscribe) {
            window.__banUnsubscribe();
            window.__banUnsubscribe = null;
        }
    }

    // Show functions
    function showAuthContainer() {
        authContainer.classList.remove('hidden');
        profileContainer.classList.add('hidden');
        roomContainer.classList.add('hidden');
        activeRoomContainer.classList.add('hidden');
        clearMessages();
        
        // При выходе на страницу входа - офлайн
        if (currentUser) {
            updateOnlineStatus(false);
        }
    }

    function showProfileContainer() {
        authContainer.classList.add('hidden');
        profileContainer.classList.remove('hidden');
        roomContainer.classList.add('hidden');
        activeRoomContainer.classList.add('hidden');
        clearMessages();
        
        if (currentUser && currentUser.email) {
            const defaultName = currentUser.email.split('@')[0];
            profileNameInput.value = defaultName;
        }
        
        // На странице профиля - онлайн
        updateOnlineStatus(true);
    }

    function showRoomContainer(displayName) {
        authContainer.classList.add('hidden');
        profileContainer.classList.add('hidden');
        roomContainer.classList.remove('hidden');
        activeRoomContainer.classList.add('hidden');
        
        displayNameSpan.textContent = `Привет, ${displayName}!`;
        activeDisplayNameSpan.textContent = displayName;
        userDisplayName = displayName;
        clearMessages();
        
        // На странице выбора комнаты - онлайн
        updateOnlineStatus(true);
    }

    function showActiveRoom() {
        authContainer.classList.add('hidden');
        profileContainer.classList.add('hidden');
        roomContainer.classList.add('hidden');
        activeRoomContainer.classList.remove('hidden');
        
        // В активной комнате - онлайн (уже обновляется через heartbeat)
    }

    function clearMessages() {
        errorMessage.textContent = '';
        successMessage.textContent = '';
    }

    function showError(text) {
        errorMessage.textContent = text;
        successMessage.textContent = '';
        if (window.showNotification) {
            window.showNotification(text, 'error');
        }
    }

    function showSuccess(text) {
        successMessage.textContent = text;
        errorMessage.textContent = '';
        if (window.showNotification) {
            window.showNotification(text, 'success');
        }
    }

    // Switch between login and signup
    function switchAuthMode() {
        isAuthModeLogin = !isAuthModeLogin;
        if (isAuthModeLogin) {
            authTitle.textContent = 'Вход в FulloChat';
            authButton.textContent = 'Войти';
            switchAuthButton.textContent = 'Создать аккаунт';
            switchAuthText.textContent = 'Нет аккаунта? Зарегистрируйтесь';
        } else {
            authTitle.textContent = 'Регистрация в FulloChat';
            authButton.textContent = 'Зарегистрироваться';
            switchAuthButton.textContent = 'Войти';
            switchAuthText.textContent = 'Уже есть аккаунт? Войдите';
        }
        clearMessages();
    }

    // Handle authentication
    async function handleAuth() {
        const email = emailInput.value.trim();
        const password = passwordInput.value;

        if (!email || !password) {
            showError('Пожалуйста, заполните все поля');
            return;
        }

        if (password.length < 6) {
            showError('Пароль должен содержать минимум 6 символов');
            return;
        }

        try {
            if (isAuthModeLogin) {
                await firebase.auth().signInWithEmailAndPassword(email, password);
                showSuccess('Вход выполнен успешно!');
            } else {
                await firebase.auth().createUserWithEmailAndPassword(email, password);
                showSuccess('Регистрация успешна! Заполните профиль.');
            }
        } catch (error) {
            handleAuthError(error);
        }
    }

    function handleAuthError(error) {
        switch (error.code) {
            case 'auth/invalid-email':
                showError('Неверный формат email');
                break;
            case 'auth/user-disabled':
                showError('Пользователь заблокирован');
                break;
            case 'auth/user-not-found':
                showError('Пользователь не найден');
                break;
            case 'auth/wrong-password':
                showError('Неверный пароль');
                break;
            case 'auth/email-already-in-use':
                showError('Email уже используется');
                break;
            case 'auth/weak-password':
                showError('Слишком простой пароль');
                break;
            default:
                showError('Ошибка: ' + error.message);
        }
    }

    // Save profile
    async function saveProfile() {
        const displayName = profileNameInput.value.trim();
        
        if (!displayName) {
            showError('Пожалуйста, введите ваше имя');
            return;
        }

        if (displayName.length > 30) {
            showError('Имя не должно превышать 30 символов');
            return;
        }

        try {
            await db.collection('users').doc(currentUser.uid).set({
                displayName: displayName,
                email: currentUser.email,
                profileCompleted: true,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                online: true,
                lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
                banned: false
            });

            userDisplayName = displayName;
            showRoomContainer(displayName);
            showSuccess('Профиль сохранен!');
            
            // Запускаем heartbeat после сохранения профиля
            startOnlineHeartbeat();
        } catch (error) {
            showError('Ошибка сохранения профиля: ' + error.message);
        }
    }

    // Logout
    async function logout() {
        try {
            stopOnlineHeartbeat();
            stopBanCheck();
            
            // Помечаем как офлайн перед выходом
            if (currentUser) {
                await updateOnlineStatus(false);
            }
            
            if (window.room && window.room.getCurrentRoom()) {
                await window.room.leaveRoom();
            }
            
            if (window.peer) {
                window.peer.cleanup();
            }
            
            await firebase.auth().signOut();
            showSuccess('Выход выполнен');
        } catch (error) {
            showError('Ошибка выхода: ' + error.message);
        }
    }

    // Public API
    return {
        handleAuth,
        switchAuthMode,
        saveProfile,
        logout,
        showError,
        showSuccess,
        showActiveRoom,
        getCurrentUser: () => currentUser,
        getUserDisplayName: () => userDisplayName,
        updateOnlineStatus  // Экспортируем для использования в других модулях
    };
})();
