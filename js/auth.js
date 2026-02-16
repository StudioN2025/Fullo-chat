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
        
        // Загружаем аватар из Base64
        if (userSettings.avatar) {
            avatarPreview.textContent = '';
            avatarPreview.style.backgroundImage = `url('${userSettings.avatar}')`;
            avatarPreview.style.backgroundSize = 'cover';
            avatarPreview.style.backgroundPosition = 'center';
        } else {
            avatarPreview.textContent = '👤';
            avatarPreview.style.backgroundImage = '';
        }
        
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

    // Конвертировать изображение в Base64
    function imageToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => resolve(reader.result);
            reader.onerror = error => reject(error);
        });
    }

    // Оптимизация Base64 изображения (сжатие)
    async function optimizeBase64Image(base64, maxWidth = 200, maxHeight = 200, quality = 0.7) {
        return new Promise((resolve) => {
            const img = new Image();
            img.src = base64;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                
                // Уменьшаем если нужно
                if (width > height) {
                    if (width > maxWidth) {
                        height *= maxWidth / width;
                        width = maxWidth;
                    }
                } else {
                    if (height > maxHeight) {
                        width *= maxHeight / height;
                        height = maxHeight;
                    }
                }
                
                canvas.width = width;
                canvas.height = height;
                
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                
                // Конвертируем в JPEG с качеством 0.7
                const optimizedBase64 = canvas.toDataURL('image/jpeg', quality);
                resolve(optimizedBase64);
            };
        });
    }

    // Проверка размера Base64 строки (примерно)
    function getBase64Size(base64) {
        let stringLength = base64.length - 'data:image/jpeg;base64,'.length;
        let sizeInBytes = 4 * Math.ceil(stringLength / 3) * 0.5624896334383812;
        return sizeInBytes;
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

        // Показываем индикатор загрузки
        const saveButton = document.querySelector('.save-btn');
        const originalText = saveButton.textContent;
        saveButton.textContent = '⏳ Сохранение...';
        saveButton.disabled = true;

        try {
            let avatarBase64 = userSettings.avatar;
            
            // Проверяем, загружен ли новый аватар
            if (avatarInput.files.length > 0) {
                const file = avatarInput.files[0];
                
                // Проверяем тип файла
                if (!file.type.startsWith('image/')) {
                    showError('Пожалуйста, выберите изображение');
                    saveButton.textContent = originalText;
                    saveButton.disabled = false;
                    return;
                }
                
                // Конвертируем в Base64
                let base64 = await imageToBase64(file);
                
                // Оптимизируем изображение
                avatarPreview.textContent = '⏳';
                base64 = await optimizeBase64Image(base64, 150, 150, 0.6);
                
                // Проверяем размер (максимум 100KB после оптимизации)
                const sizeInKB = getBase64Size(base64) / 1024;
                if (sizeInKB > 100) {
                    showError(`Изображение слишком большое (${Math.round(sizeInKB)}KB). Максимум 100KB`);
                    saveButton.textContent = originalText;
                    saveButton.disabled = false;
                    return;
                }
                
                avatarBase64 = base64;
                console.log(`Avatar size: ${Math.round(sizeInKB)}KB`);
            }

            const newSettings = {
                displayName: newName,
                status: settingsStatusSelect.value,
                notifyMessages: notifyMessages.checked,
                notifyJoin: notifyJoin.checked,
                notifyLeave: notifyLeave.checked,
                micVolume: parseInt(micVolume.value),
                speakerVolume: parseInt(speakerVolume.value),
                avatar: avatarBase64,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            };

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

            // Если в комнате, обновляем имя и аватар в participants
            if (window.room && window.room.getCurrentRoom()) {
                const roomId = window.room.getCurrentRoom();
                await db.collection('rooms').doc(roomId).collection('participants').doc(currentUser.uid).update({
                    displayName: newName,
                    avatar: avatarBase64
                });
            }

            // Очищаем input файла
            avatarInput.value = '';

            hideSettings();
            showSuccess('Настройки сохранены');
        } catch (error) {
            console.error('Error saving settings:', error);
            showError('Ошибка сохранения настроек: ' + error.message);
        } finally {
            // Восстанавливаем кнопку
            saveButton.textContent = originalText;
            saveButton.disabled = false;
        }
    }

    // Обработка загрузки аватара
    function handleAvatarUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            showError('Пожалуйста, выберите изображение');
            avatarInput.value = '';
            return;
        }

        // Показываем предпросмотр
        const reader = new FileReader();
        reader.onload = function(e) {
            avatarPreview.textContent = '';
            avatarPreview.style.backgroundImage = `url('${e.target.result}')`;
            avatarPreview.style.backgroundSize = 'cover';
            avatarPreview.style.backgroundPosition = 'center';
        };
        reader.readAsDataURL(file);
        
        showSuccess('Аватар выбран, нажмите "Сохранить" для загрузки');
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
        profileContainer.classList.add('
