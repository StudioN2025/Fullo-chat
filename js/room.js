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
                isHost: true
            });

            // Initialize WebRTC
            await window.peer.init(user.uid, displayName);
            window.peer.setCurrentRoom(currentRoom);

            // Set up presence
            setupPresence();

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

            // Add participant
            await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).set({
                userId: user.uid,
                displayName: displayName,
                joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
                isHost: false
            });

            // Initialize WebRTC
            await window.peer.init(user.uid, displayName);
            window.peer.setCurrentRoom(currentRoom);

            // Set up presence
            setupPresence();

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

    // Setup presence monitoring
    function setupPresence() {
        const user = firebase.auth().currentUser;
        if (!user || !currentRoom) return;

        // Update lastSeen every 30 seconds
        presenceInterval = setInterval(() => {
            if (currentRoom && user) {
                db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid)
                    .update({
                        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
                    })
                    .catch(err => console.error('Error updating presence:', err));
            }
        }, 30000);

        // Set up beforeunload handler
        window.addEventListener('beforeunload', function() {
            if (currentRoom && user) {
                // Синхронно вызываем leaveRoom перед закрытием
                leaveRoom();
            }
        });
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
                if (participantsCount) participantsCount.textContent = snapshot.size;

                // Check for empty room
                checkEmptyRoom(snapshot);

                // Получаем текущие ID участников в UI
                const currentUIIds = new Set();
                document.querySelectorAll('.participant-card').forEach(card => {
                    currentUIIds.add(card.id.replace('participant-', ''));
                });

                // Получаем ID участников из Firebase
                const firebaseIds = new Set();
                snapshot.docs.forEach(doc => {
                    firebaseIds.add(doc.id);
                });

                // Удаляем из UI тех, кого нет в Firebase
                currentUIIds.forEach(id => {
                    if (!firebaseIds.has(id)) {
                        removeParticipantFromUI(id);
                    }
                });

                // Обрабатываем изменения
                snapshot.docChanges().forEach((change) => {
                    const data = change.doc.data();
                    
                    if (change.type === 'added') {
                        addParticipantToUI(change.doc.id, data);
                        if (change.doc.id !== firebase.auth().currentUser?.uid) {
                            setTimeout(() => {
                                window.peer.connectToPeer(change.doc.id, data.displayName);
                            }, 1000);
                        }
                    }
                    
                    if (change.type === 'modified') {
                        updateParticipantInUI(change.doc.id, data);
                    }
                    
                    // change.type === 'removed' уже обработано выше через сравнение множеств
                });
            });
    }

    function checkEmptyRoom(snapshot) {
        if (roomCheckTimeout) {
            clearTimeout(roomCheckTimeout);
        }

        if (snapshot.size === 0) {
            console.log('Room empty, scheduling deletion in 5 seconds');
            roomCheckTimeout = setTimeout(async () => {
                if (currentRoom) {
                    try {
                        await db.collection('rooms').doc(currentRoom).delete();
                        console.log('Room deleted due to being empty');
                        
                        if (currentRoom) {
                            cleanup();
                            window.auth.showError('Комната удалена из-за отсутствия участников');
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
                🟢 В комнате${mutedIcon}
            </div>
        `;

        participantsContainer.appendChild(card);
    }

    function updateParticipantInUI(userId, data) {
        const card = document.getElementById(`participant-${userId}`);
        if (card) {
            const statusDiv = card.querySelector('.participant-status');
            if (statusDiv) {
                statusDiv.innerHTML = `🟢 В комнате${data.muted ? ' 🔇' : ''}`;
            }
            
            // Обновляем имя если нужно
            const nameDiv = card.querySelector('.participant-name');
            if (nameDiv) {
                const isCurrentUser = userId === firebase.auth().currentUser?.uid;
                const hostBadge = data.isHost ? ' 👑' : '';
                nameDiv.innerHTML = `${data.displayName || 'Unknown'}${hostBadge}${isCurrentUser ? '<span style="font-size: 12px;"> (Вы)</span>' : ''}`;
            }
        }
    }

    function removeParticipantFromUI(userId) {
        const card = document.getElementById(`participant-${userId}`);
        if (card) {
            console.log('Removing participant from UI:', userId);
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
                // Удаляем участника из подколлекции participants
                await db.collection('rooms').doc(currentRoom)
                    .collection('participants').doc(user.uid)
                    .delete();
                console.log('Participant deleted from subcollection');

                // Удаляем пользователя из массива participants в документе комнаты
                await db.collection('rooms').doc(currentRoom).update({
                    participants: firebase.firestore.FieldValue.arrayRemove(user.uid)
                });
                console.log('User removed from room participants array');

                // Проверяем, остались ли еще участники
                const participantsSnapshot = await db.collection('rooms').doc(currentRoom)
                    .collection('participants')
                    .get();

                // Если участников больше нет, удаляем комнату
                if (participantsSnapshot.empty) {
                    await db.collection('rooms').doc(currentRoom).delete();
                    console.log('Room deleted as last participant left');
                }
            } catch (error) {
                console.error('Error leaving room:', error);
            }
        }

        // НЕ вызываем cleanup здесь, потому что snapshot обновления
        // придут через listener и сами обновят UI
    }

    function cleanup() {
        console.log('Cleaning up room module');
        
        // Clear presence interval
        if (presenceInterval) {
            clearInterval(presenceInterval);
            presenceInterval = null;
        }

        // Clear room check timeout
        if (roomCheckTimeout) {
            clearTimeout(roomCheckTimeout);
            roomCheckTimeout = null;
        }

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
