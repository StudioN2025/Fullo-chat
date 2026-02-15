// Room Module - Firebase integration
window.room = (function() {
    let currentRoom = null;
    let roomCode = null;
    let roomListener = null;
    let participantsListener = null;
    let messagesListener = null;
    let heartbeatInterval = null;
    let isHost = false;
    let roomCheckTimeout = null;
    let connectionCheckInterval = null;
    let leaveInProgress = false;

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

            // Add host as participant
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

            // Start connection checker
            startConnectionChecker();

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
                window.auth.showError('Комната не найдена или уже удалена');
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

            // Add participant
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

            // Start connection checker
            startConnectionChecker();

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

    // Heartbeat - обновляет статус online каждые 3 секунды
    function startHeartbeat() {
        const user = firebase.auth().currentUser;
        if (!user || !currentRoom) return;

        // Clear previous interval
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }

        // Send heartbeat every 3 seconds
        heartbeatInterval = setInterval(async () => {
            if (currentRoom && user && window.navigator.onLine && !leaveInProgress) {
                try {
                    await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).update({
                        online: true,
                        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
                    });
                    console.log('Heartbeat sent');
                } catch (error) {
                    console.error('Error sending heartbeat:', error);
                    if (error.code === 'permission-denied' || error.code === 'not-found') {
                        cleanup();
                        window.auth.showError('Соединение с комнатой потеряно');
                    }
                }
            } else {
                clearInterval(heartbeatInterval);
            }
        }, 3000);

        // Set up beforeunload handler
        window.addEventListener('beforeunload', handleBeforeUnload);
        window.addEventListener('pagehide', handlePageHide);
        window.addEventListener('visibilitychange', handleVisibilityChange);
    }

    function handleBeforeUnload() {
        immediateLeave();
    }

    function handlePageHide() {
        immediateLeave();
    }

    function handleVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            immediateLeave();
        }
    }

    function immediateLeave() {
        const user = firebase.auth().currentUser;
        if (currentRoom && user && !leaveInProgress) {
            leaveInProgress = true;
            
            // Синхронно удаляем пользователя
            const url = `https://firestore.googleapis.com/v1/projects/${firebase.app().options.projectId}/databases/(default)/documents/rooms/${currentRoom}/participants/${user.uid}`;
            
            // Помечаем как offline
            const offlineData = {
                fields: {
                    online: { booleanValue: false },
                    lastSeen: { timestampValue: new Date().toISOString() }
                }
            };
            
            // Пытаемся отправить синхронно
            try {
                navigator.sendBeacon(url, JSON.stringify(offlineData));
            } catch (e) {
                console.error('Error sending beacon:', e);
            }
            
            // Также пытаемся удалить из массива participants
            const roomUrl = `https://firestore.googleapis.com/v1/projects/${firebase.app().options.projectId}/databases/(default)/documents/rooms/${currentRoom}`;
            
            // В идеале нужно было бы отправить patch запрос, но sendBeacon ограничен
            // Поэтому полагаемся на heartbeat и проверку lastSeen
        }
    }

    // Check internet connection every 2 seconds
    function startConnectionChecker() {
        if (connectionCheckInterval) {
            clearInterval(connectionCheckInterval);
        }

        connectionCheckInterval = setInterval(() => {
            if (!window.navigator.onLine) {
                console.log('Internet connection lost');
                window.auth.showError('Потеряно соединение с интернетом');
            }
        }, 2000);
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
                    console.log('Room deleted');
                    window.auth.showError('Комната была удалена');
                    cleanup();
                }
            }, (error) => {
                console.error('Room listener error:', error);
                if (error.code === 'permission-denied' || error.code === 'not-found') {
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
                // Filter online participants (lastSeen not older than 5 seconds)
                const now = Date.now();
                const onlineParticipants = snapshot.docs.filter(doc => {
                    const data = doc.data();
                    if (!data.online) return false;
                    
                    if (data.lastSeen) {
                        const lastSeen = data.lastSeen.toDate ? data.lastSeen.toDate() : new Date(data.lastSeen);
                        const diff = now - lastSeen.getTime();
                        return diff < 5000; // 5 seconds max delay
                    }
                    return false;
                });

                if (participantsCount) participantsCount.textContent = onlineParticipants.length;

                // Check for empty room
                checkEmptyRoom(onlineParticipants);

                // Update UI
                const onlineIds = new Set(onlineParticipants.map(doc => doc.id));
                
                // Remove offline participants from UI immediately
                document.querySelectorAll('.participant-card').forEach(card => {
                    const cardId = card.id.replace('participant-', '');
                    if (!onlineIds.has(cardId)) {
                        removeParticipantFromUI(cardId);
                    }
                });

                // Add or update online participants
                onlineParticipants.forEach(doc => {
                    const data = doc.data();
                    if (document.getElementById(`participant-${doc.id}`)) {
                        updateParticipantInUI(doc.id, data);
                    } else {
                        addParticipantToUI(doc.id, data);
                    }
                });

                // Connect to new participants
                onlineParticipants.forEach(doc => {
                    if (doc.id !== firebase.auth().currentUser?.uid) {
                        // Don't reconnect to self
                        setTimeout(() => {
                            window.peer.connectToPeer(doc.id);
                        }, 1000);
                    }
                });
            }, (error) => {
                console.error('Participants listener error:', error);
            });
    }

    function checkEmptyRoom(onlineParticipants) {
        if (roomCheckTimeout) {
            clearTimeout(roomCheckTimeout);
        }

        // If no online participants, delete room after 5 seconds
        if (onlineParticipants.length === 0) {
            console.log('No online participants, scheduling room deletion in 5 seconds');
            roomCheckTimeout = setTimeout(async () => {
                if (currentRoom) {
                    try {
                        // Double-check before deleting
                        const checkSnapshot = await db.collection('rooms').doc(currentRoom)
                            .collection('participants')
                            .where('online', '==', true)
                            .get();
                        
                        if (checkSnapshot.empty) {
                            // Delete the room
                            await db.collection('rooms').doc(currentRoom).delete();
                            console.log('Room deleted due to no online participants');
                            
                            if (!leaveInProgress) {
                                window.auth.showError('Комната удалена из-за отсутствия участников');
                                cleanup();
                            }
                        }
                    } catch (error) {
                        console.error('Error deleting empty room:', error);
                    }
                }
            }, 5000);
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
            }, (error) => {
                console.error('Messages listener error:', error);
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
        if (leaveInProgress) return;
        leaveInProgress = true;
        
        const user = firebase.auth().currentUser;
        console.log('Leaving room:', currentRoom, 'user:', user?.uid);
        
        if (currentRoom && user) {
            try {
                // Mark user as offline
                await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).update({
                    online: false,
                    leftAt: firebase.firestore.FieldValue.serverTimestamp()
                });

                // Remove user from participants array
                await db.collection('rooms').doc(currentRoom).update({
                    participants: firebase.firestore.FieldValue.arrayRemove(user.uid)
                });

                // Check if any online participants remain
                const participantsSnapshot = await db.collection('rooms').doc(currentRoom)
                    .collection('participants')
                    .where('online', '==', true)
                    .get();

                // If no online participants, delete the room
                if (participantsSnapshot.empty) {
                    await db.collection('rooms').doc(currentRoom).delete();
                    console.log('Room deleted as last participant left');
                }
            } catch (error) {
                console.error('Error leaving room:', error);
            }
        }

        cleanup();
    }

    function cleanup() {
        console.log('Cleaning up room module');
        
        // Clear intervals
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        if (connectionCheckInterval) {
            clearInterval(connectionCheckInterval);
            connectionCheckInterval = null;
        }
        if (roomCheckTimeout) {
            clearTimeout(roomCheckTimeout);
            roomCheckTimeout = null;
        }

        // Remove event listeners
        window.removeEventListener('beforeunload', handleBeforeUnload);
        window.removeEventListener('pagehide', handlePageHide);
        window.removeEventListener('visibilitychange', handleVisibilityChange);

        // Remove Firestore listeners
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
        leaveInProgress = false;

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
