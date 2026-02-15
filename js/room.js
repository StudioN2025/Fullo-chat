// Room Module - Firebase integration
window.room = (function() {
    let currentRoom = null;
    let roomCode = null;
    let roomListener = null;
    let participantsListener = null;
    let messagesListener = null;
    let presenceInterval = null;
    let isHost = false;
    let roomCheckTimeout = null;
    let heartbeatInterval = null;

    // DOM Elements
    const roomCodeInput = document.getElementById('roomCodeInput');
    const currentRoomCode = document.getElementById('currentRoomCode');
    const participantsContainer = document.getElementById('participantsContainer');
    const chatMessages = document.getElementById('chatMessages');
    const roomCodeDisplay = document.getElementById('roomCodeDisplay');
    const activeDisplayName = document.getElementById('activeDisplayName');
    const participantsCount = document.getElementById('participantsCount');
    const roomContainer = document.getElementById('roomContainer');
    const activeRoomContainer = document.getElementById('activeRoomContainer');

    // Create new room
    async function createRoom() {
        const user = firebase.auth().currentUser;
        if (!user) {
            window.auth.showError('Пользователь не авторизован');
            return;
        }

        roomCode = generateRoomCode();
        
        try {
            const userDoc = await db.collection('users').doc(user.uid).get();
            
            if (!userDoc.exists) {
                window.auth.showError('Профиль пользователя не найден');
                return;
            }
            
            const displayName = userDoc.data().displayName;

            // Create room
            const roomRef = await db.collection('rooms').add({
                code: roomCode,
                hostId: user.uid,
                hostName: displayName,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                participants: [user.uid],
                active: true,
                lastActive: firebase.firestore.FieldValue.serverTimestamp()
            });

            currentRoom = roomRef.id;
            isHost = true;

            // Add host as participant с полем online
            await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).set({
                userId: user.uid,
                displayName: displayName,
                joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
                isHost: true,
                online: true,
                lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            });

            // Initialize WebRTC
            await window.peer.init(user.uid, displayName);
            window.peer.setCurrentRoom(currentRoom);

            // Start heartbeat
            startHeartbeat();

            // Update UI
            updateRoomCodeDisplay(roomCode);
            if (activeDisplayName) activeDisplayName.textContent = displayName;
            if (roomContainer) roomContainer.classList.add('hidden');
            if (activeRoomContainer) activeRoomContainer.classList.remove('hidden');
            
            // Start listening
            listenToRoom();
            listenToParticipants();
            listenToMessages();

            window.auth.showSuccess(`Комната создана! Код: ${roomCode}`);
        } catch (error) {
            console.error('Error creating room:', error);
            window.auth.showError('Ошибка создания комнаты: ' + error.message);
        }
    }

    // Generate 12-digit room code
    function generateRoomCode() {
        return Math.random().toString().substr(2, 12);
    }

    // Join existing room
    async function joinRoom() {
        const code = roomCodeInput.value.trim();
        if (!code || code.length !== 12 || !/^\d+$/.test(code)) {
            window.auth.showError('Введите корректный 12-значный код');
            return;
        }

        const user = firebase.auth().currentUser;
        if (!user) {
            window.auth.showError('Пользователь не авторизован');
            return;
        }

        try {
            // Find room
            const roomsSnapshot = await db.collection('rooms')
                .where('code', '==', code)
                .where('active', '==', true)
                .get();

            if (roomsSnapshot.empty) {
                window.auth.showError('Комната не найдена');
                return;
            }

            const roomDoc = roomsSnapshot.docs[0];
            currentRoom = roomDoc.id;
            roomCode = code;

            const userDoc = await db.collection('users').doc(user.uid).get();
            if (!userDoc.exists) {
                window.auth.showError('Профиль пользователя не найден');
                return;
            }
            
            const displayName = userDoc.data().displayName;

            // Add to room
            await db.collection('rooms').doc(currentRoom).update({
                participants: firebase.firestore.FieldValue.arrayUnion(user.uid),
                lastActive: firebase.firestore.FieldValue.serverTimestamp()
            });

            // Add participant с полем online
            await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).set({
                userId: user.uid,
                displayName: displayName,
                joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
                isHost: false,
                online: true,
                lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            });

            // Initialize WebRTC
            await window.peer.init(user.uid, displayName);
            window.peer.setCurrentRoom(currentRoom);

            // Start heartbeat
            startHeartbeat();

            // Update UI
            updateRoomCodeDisplay(roomCode);
            if (activeDisplayName) activeDisplayName.textContent = displayName;
            if (roomContainer) roomContainer.classList.add('hidden');
            if (activeRoomContainer) activeRoomContainer.classList.remove('hidden');

            // Start listening
            listenToRoom();
            listenToParticipants();
            listenToMessages();

            window.auth.showSuccess('Подключение к комнате выполнено');
        } catch (error) {
            console.error('Error joining room:', error);
            window.auth.showError('Ошибка подключения к комнате: ' + error.message);
        }
    }

    // Heartbeat - обновляет статус online каждые 10 секунд
    function startHeartbeat() {
        const user = firebase.auth().currentUser;
        if (!user || !currentRoom) return;

        // Очищаем предыдущий интервал
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }

        // Отправляем heartbeat каждые 10 секунд
        heartbeatInterval = setInterval(async () => {
            if (currentRoom && user) {
                try {
                    await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).update({
                        online: true,
                        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
                    });
                    console.log('Heartbeat sent');
                } catch (error) {
                    console.error('Error sending heartbeat:', error);
                }
            } else {
                clearInterval(heartbeatInterval);
            }
        }, 10000);

        // Устанавливаем обработчик для выхода
        window.addEventListener('beforeunload', handleBeforeUnload);
        window.addEventListener('unload', handleUnload);
    }

    function handleBeforeUnload() {
        // Помечаем пользователя как офлайн перед закрытием
        const user = firebase.auth().currentUser;
        if (currentRoom && user) {
            // Используем синхронный метод для отправки перед закрытием
            navigator.sendBeacon(
                `https://firestore.googleapis.com/v1/projects/${firebase.app().options.projectId}/databases/(default)/documents/rooms/${currentRoom}/participants/${user.uid}`,
                JSON.stringify({
                    fields: {
                        online: { booleanValue: false },
                        lastSeen: { timestampValue: new Date().toISOString() }
                    }
                })
            );
        }
    }

    function handleUnload() {
        // Дополнительная очистка
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }
    }

    function updateRoomCodeDisplay(code) {
        if (currentRoomCode) currentRoomCode.textContent = code;
        if (roomCodeDisplay) roomCodeDisplay.textContent = code;
    }

    function listenToRoom() {
        if (!currentRoom) return;
        if (roomListener) roomListener();

        roomListener = db.collection('rooms').doc(currentRoom)
            .onSnapshot((doc) => {
                if (!doc.exists) {
                    window.auth.showError('Комната не существует');
                    cleanup();
                }
            });
    }

    function listenToParticipants() {
        if (!currentRoom) return;
        if (participantsListener) participantsListener();

        participantsListener = db.collection('rooms').doc(currentRoom)
            .collection('participants')
            .onSnapshot((snapshot) => {
                // Фильтруем только онлайн участников для отображения
                const onlineParticipants = snapshot.docs.filter(doc => doc.data().online === true);
                
                if (participantsCount) participantsCount.textContent = onlineParticipants.length;

                // Проверяем на пустую комнату (нет онлайн участников)
                checkEmptyRoom(onlineParticipants);

                // Получаем текущие ID участников в UI
                const currentUIIds = new Set();
                document.querySelectorAll('.participant-card').forEach(card => {
                    currentUIIds.add(card.id.replace('participant-', ''));
                });

                // Получаем ID онлайн участников из Firebase
                const firebaseIds = new Set(onlineParticipants.map(doc => doc.id));

                // Удаляем из UI тех, кто не онлайн
                currentUIIds.forEach(id => {
                    if (!firebaseIds.has(id)) {
                        removeParticipantFromUI(id);
                    }
                });

                // Добавляем или обновляем онлайн участников
                onlineParticipants.forEach(doc => {
                    const data = doc.data();
                    if (document.getElementById(`participant-${doc.id}`)) {
                        updateParticipantInUI(doc.id, data);
                    } else {
                        addParticipantToUI(doc.id, data);
                    }
                });

                // Подключаемся к новым участникам
                onlineParticipants.forEach(doc => {
                    const data = doc.data();
                    if (doc.id !== firebase.auth().currentUser?.uid) {
                        // Проверяем, есть ли уже соединение
                        setTimeout(() => {
                            window.peer.connectToPeer(doc.id, data.displayName);
                        }, 1000);
                    }
                });
            });
    }

    function checkEmptyRoom(onlineParticipants) {
        if (roomCheckTimeout) {
            clearTimeout(roomCheckTimeout);
        }

        // Если нет онлайн участников, удаляем комнату через 10 секунд
        if (onlineParticipants.length === 0) {
            console.log('No online participants, scheduling room deletion in 10 seconds');
            roomCheckTimeout = setTimeout(async () => {
                if (currentRoom) {
                    try {
                        // Проверяем еще раз перед удалением
                        const checkSnapshot = await db.collection('rooms').doc(currentRoom)
                            .collection('participants')
                            .where('online', '==', true)
                            .get();
                        
                        if (checkSnapshot.empty) {
                            await db.collection('rooms').doc(currentRoom).delete();
                            console.log('Room deleted due to no online participants');
                            
                            if (currentRoom) {
                                cleanup();
                                window.auth.showError('Комната удалена из-за отсутствия участников');
                            }
                        }
                    } catch (error) {
                        console.error('Error deleting empty room:', error);
                    }
                }
            }, 10000);
        }
    }

    function listenToMessages() {
        if (!currentRoom) return;
        if (messagesListener) messagesListener();

        messagesListener = db.collection('rooms').doc(currentRoom)
            .collection('messages')
            .orderBy('timestamp', 'asc')
            .onSnapshot((snapshot) => {
                snapshot.docChanges().forEach((change) => {
                    if (change.type === 'added') {
                        const data = change.doc.data();
                        if (data.senderId !== firebase.auth().currentUser?.uid) {
                            window.peer.addMessage(data.senderName, data.message);
                        }
                    }
                });
            });
    }

    function addParticipantToUI(userId, data) {
        if (!participantsContainer) return;
        if (document.getElementById(`participant-${userId}`)) return;

        const card = document.createElement('div');
        card.className = 'participant-card';
        card.id = `participant-${userId}`;
        
        const isCurrentUser = userId === firebase.auth().currentUser?.uid;
        const hostBadge = data.isHost ? ' 👑' : '';
        const mutedIcon = data.muted ? ' 🔇' : '';
        
        card.innerHTML = `
            <div class="participant-name">
                ${data.displayName || 'Unknown'}${hostBadge}
                ${isCurrentUser ? '<span style="font-size: 12px;"> (Вы)</span>' : ''}
            </div>
            <div class="participant-status">
                🟢 В сети${mutedIcon}
            </div>
        `;

        participantsContainer.appendChild(card);
    }

    function updateParticipantInUI(userId, data) {
        const card = document.getElementById(`participant-${userId}`);
        if (card) {
            const statusDiv = card.querySelector('.participant-status');
            if (statusDiv) {
                statusDiv.innerHTML = `🟢 В сети${data.muted ? ' 🔇' : ''}`;
            }
        }
    }

    function removeParticipantFromUI(userId) {
        const card = document.getElementById(`participant-${userId}`);
        if (card) {
            console.log('Removing offline participant from UI:', userId);
            card.remove();
        }
    }

    function copyRoomCode() {
        if (!roomCode) return;
        navigator.clipboard.writeText(roomCode)
            .then(() => window.auth.showSuccess('Код скопирован!'))
            .catch(() => window.auth.showError('Ошибка копирования'));
    }

    async function leaveRoom() {
        const user = firebase.auth().currentUser;
        console.log('Leaving room:', currentRoom, 'user:', user?.uid);
        
        if (currentRoom && user) {
            try {
                // Помечаем пользователя как офлайн (не удаляем, чтобы другие знали что он вышел)
                await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).update({
                    online: false,
                    leftAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                console.log('User marked as offline');

                // Удаляем пользователя из массива participants в документе комнаты
                await db.collection('rooms').doc(currentRoom).update({
                    participants: firebase.firestore.FieldValue.arrayRemove(user.uid)
                });
                console.log('User removed from room participants array');
            } catch (error) {
                console.error('Error leaving room:', error);
            }
        }

        // Очищаем интервалы
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }

        // Убираем обработчики
        window.removeEventListener('beforeunload', handleBeforeUnload);
        window.removeEventListener('unload', handleUnload);
    }

    function cleanup() {
        console.log('Cleaning up room module');
        
        // Очищаем интервалы
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        if (presenceInterval) {
            clearInterval(presenceInterval);
            presenceInterval = null;
        }
        if (roomCheckTimeout) {
            clearTimeout(roomCheckTimeout);
            roomCheckTimeout = null;
        }

        // Убираем обработчики
        window.removeEventListener('beforeunload', handleBeforeUnload);
        window.removeEventListener('unload', handleUnload);

        // Remove listeners
        if (roomListener) {
            roomListener();
            roomListener = null;
        }
        if (participantsListener) {
            participantsListener();
            participantsListener = null;
        }
        if (messagesListener) {
            messagesListener();
            messagesListener = null;
        }
        
        // Cleanup WebRTC
        if (window.peer && typeof window.peer.cleanup === 'function') {
            window.peer.cleanup();
        }

        // Clear UI
        if (participantsContainer) participantsContainer.innerHTML = '';
        if (chatMessages) chatMessages.innerHTML = '';
        
        currentRoom = null;
        roomCode = null;

        // Show room container
        if (roomContainer) roomContainer.classList.remove('hidden');
        if (activeRoomContainer) activeRoomContainer.classList.add('hidden');
        
        window.auth.showSuccess('Вы покинули комнату');
        if (roomCodeInput) roomCodeInput.value = '';
    }

    return {
        createRoom,
        joinRoom,
        leaveRoom,
        copyRoomCode,
        getCurrentRoom: () => currentRoom,
        getRoomCode: () => roomCode,
        isCurrentUserHost: () => isHost
    };
})();
