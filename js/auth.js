// Auth Module
window.auth = (function() {
    // State
    let currentUser = null;
    let isAuthModeLogin = true;
    let userDisplayName = '';
    let banCheckInterval = null;
    let onlineHeartbeat = null;
    let userSettings = {};

    // DOM Elements
    const authContainer = document.getElementById('authContainer');
    const profileContainer = document.getElementById('profileContainer');
    const roomContainer = document.getElementById('roomContainer');
    const activeRoomContainer = document.getElementById('activeRoomContainer');
    const settingsModal = document.getElementById('settingsModal');
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

    // Settings Elements
    const settingsNameInput = document.getElementById('settingsNameInput');
    const settingsEmailInput = document.getElementById('settingsEmailInput');
    const settingsStatusSelect = document.getElementById('settingsStatusSelect');
    const notifyMessages = document.getElementById('notifyMessages');
    const notifyJoin = document.getElementById('notifyJoin');
    const notifyLeave = document.getElementById('notifyLeave');
    const micVolume = document.getElementById('micVolume');
    const micVolumeValue = document.getElementById('micVolumeValue');
    const speakerVolume = document.getElementById('speakerVolume');
    const speakerVolumeValue = document.getElementById('speakerVolumeValue');
    const avatarInput = document.getElementById('avatarInput');
    const avatarPreview = document.getElementById('avatarPreview');

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
                
                // Загружаем настройки пользователя
                await loadUserSettings(userDoc.data());
                
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

    // Загрузка настроек пользователя
    async function loadUserSettings(userData) {
        userSettings = {
            displayName: userData.displayName || '',
            email: currentUser?.email || '',
            status: userData.status || 'online',
            notifyMessages: userData.notifyMessages !== false,
            notifyJoin: userData.notifyJoin !== false,
            notifyLeave: userData.notifyLeave !== false,
            micVolume: userData.micVolume || 80,
            speakerVolume: userData.speakerVolume || 100,
            avatar: userData.avatar || null
        };

        // Применяем настройки к интерфейсу
        applySettingsToUI();
    }

    // Применение настроек к UI
    function applySettingsToUI() {
        if (settingsNameInput) settingsNameInput.value = userSettings.displayName;
        if (settingsEmailInput) settingsEmailInput.value = userSettings.email;
        if (settingsStatusSelect) settingsStatusSelect.value = userSettings.status;
        if (notifyMessages) notifyMessages.checked = userSettings.notifyMessages;
        if (notifyJoin) notifyJoin.checked = userSettings.notifyJoin;
        if (notifyLeave) notifyLeave.checked = userSettings.notifyLeave;
        if (micVolume) micVolume.value = userSettings.micVolume;
        if (micVolumeValue) micVolumeValue.textContent = userSettings.micVolume + '%';
        if (speakerVolume) speakerVolume.value = userSettings.speakerVolume;
        if (speakerVolumeValue) speakerVolumeValue.textContent = userSettings.speakerVolume + '%';
        
        // Применяем громкость к аудио
        if (window.peer) {
            window.peer.setVolume(userSettings.micVolume / 100, userSettings.speakerVolume / 100);
        }
    }

    // Показать настройки
    function showSettings() {
        if (!currentUser) return;
        
        // Загружаем актуальные данные
        db.collection('users').doc(currentUser.uid).get().then(doc => {
            if (doc.exists) {
                loadUserSettings(doc.data());
            }
        });
        
        settingsModal.classList.remove('hidden');
    }

    // Скрыть настройки
    function hideSettings() {
        settingsModal.classList.add('hidden');
    }

    // Сохранить настройки
    async function saveSettings() {
        if (!currentUser) return;

        const newName = settingsNameInput.value.trim();
        if (!newName) {
            showError('Имя не может быть пустым');
            return;
        }

        if (newName.length > 30) {
            showError('Имя не должно превышать 30 символов');
            return;
        }

        const newSettings = {
            displayName: newName,
            status: settingsStatusSelect.value,
            notifyMessages: notifyMessages.checked,
            notifyJoin: notifyJoin.checked,
            notifyLeave: notifyLeave.checked,
            micVolume: parseInt(micVolume.value),
            speakerVolume: parseInt(speakerVolume.value),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        try {
            // Обновляем в Firestore
            await db.collection('users').doc(currentUser.uid).update(newSettings);

            // Обновляем локально
            userSettings = { ...userSettings, ...newSettings };
            
            // Обновляем отображаемое имя
            userDisplayName = newName;
            if (displayNameSpan) displayNameSpan.textContent = `Привет, ${newName}!`;
            if (activeDisplayNameSpan) activeDisplayNameSpan.textContent = newName;

            // Применяем настройки аудио
            if (window.peer) {
                window.peer.setVolume(newSettings.micVolume / 100, newSettings.speakerVolume / 100);
            }

            // Если в комнате, обновляем имя в participants
            if (window.room && window.room.getCurrentRoom()) {
                const roomId = window.room.getCurrentRoom();
                await db.collection('rooms').doc(roomId).collection('participants').doc(currentUser.uid).update({
                    displayName: newName
                });
            }

            hideSettings();
            showSuccess('Настройки сохранены');
        } catch (error) {
            console.error('Error saving settings:', error);
            showError('Ошибка сохранения настроек');
        }
    }

    // Обновление онлайн статуса
    async function updateOnlineStatus(online) {
        if (!currentUser) return;
        
        try {
            const userRef = db.collection('users').doc(currentUser.uid);
            
            if (online) {
                await userRef.update({
                    online: true,
                    lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
                    status: userSettings.status || 'online'
                });
            } else {
                await userRef.update({
                    online: false,
                    lastSeen: firebase.firestore.FieldValue.serverTimestamp()
                });
            }
            
            console.log(`Online status updated: ${online}`);
        } catch (error) {
            console.error('Error updating online status:', error);
        }
    }

    // Heartbeat для онлайн статуса
    function startOnlineHeartbeat() {
        if (onlineHeartbeat) clearInterval(onlineHeartbeat);
        
        updateOnlineStatus(true);
        
        onlineHeartbeat = setInterval(() => {
            if (currentUser && !document.hidden) {
                updateOnlineStatus(true);
            }
        }, 10000);
        
        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('beforeunload', handleBeforeUnload);

        // Добавляем слушатели для ползунков громкости
        if (micVolume) {
            micVolume.addEventListener('input', function() {
                micVolumeValue.textContent = this.value + '%';
            });
        }
        if (speakerVolume) {
            speakerVolume.addEventListener('input', function() {
                speakerVolumeValue.textContent = this.value + '%';
            });
        }

        // Добавляем слушатель для загрузки аватара
        if (avatarInput) {
            avatarInput.addEventListener('change', handleAvatarUpload);
        }
    }

    // Обработка загрузки аватара
    async function handleAvatarUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            showError('Пожалуйста, выберите изображение');
            return;
        }

        if (file.size > 5 * 1024 * 1024) {
            showError('Размер файла не должен превышать 5MB');
            return;
        }

        const reader = new FileReader();
        reader.onload = function(e) {
            avatarPreview.textContent = '';
            avatarPreview.style.backgroundImage = `url('${e.target.result}')`;
            avatarPreview.style.backgroundSize = 'cover';
            avatarPreview.style.backgroundPosition = 'center';
            
            // Сохраняем аватар в localStorage (временно)
            localStorage.setItem('avatar_' + currentUser.uid, e.target.result);
            
            // Здесь можно добавить загрузку в Firebase Storage
            showSuccess('Аватар загружен');
        };
        reader.readAsDataURL(file);
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
                setTimeout(() => {
                    if (document.hidden && currentUser) {
                        updateOnlineStatus(false);
                    }
                }, 30000);
            } else {
                updateOnlineStatus(true);
            }
        }
    }

    function handleBeforeUnload() {
        if (currentUser) {
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

    // Проверка бана
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
        settingsModal.classList.add('hidden');
        clearMessages();
        
        if (currentUser) {
            updateOnlineStatus(false);
        }
    }

    function showProfileContainer() {
        authContainer.classList.add('hidden');
        profileContainer.classList.remove('hidden');
        roomContainer.classList.add('hidden');
        activeRoomContainer.classList.add('hidden');
        settingsModal.classList.add('hidden');
        clearMessages();
        
        if (currentUser && currentUser.email) {
            const defaultName = currentUser.email.split('@')[0];
            profileNameInput.value = defaultName;
        }
        
        updateOnlineStatus(true);
    }

    function showRoomContainer(displayName) {
        authContainer.classList.add('hidden');
        profileContainer.classList.add('hidden');
        roomContainer.classList.remove('hidden');
        activeRoomContainer.classList.add('hidden');
        settingsModal.classList.add('hidden');
        
        displayNameSpan.textContent = `Привет, ${displayName}!`;
        activeDisplayNameSpan.textContent = displayName;
        userDisplayName = displayName;
        clearMessages();
        
        updateOnlineStatus(true);
    }

    function showActiveRoom() {
        authContainer.classList.add('hidden');
        profileContainer.classList.add('hidden');
        roomContainer.classList.add('hidden');
        activeRoomContainer.classList.remove('hidden');
        settingsModal.classList.add('hidden');
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
            case 'auth/wrong-
