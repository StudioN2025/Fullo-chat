// Room Module - Firebase integration
window.room = (function() {
    let currentRoom = null;
    let roomCode = null;
    let roomListener = null;
    let participantsListener = null;
    let messagesListener = null;
    let myPeerId = null;
    let isHost = false;

    // DOM Elements
    const roomCodeInput = document.getElementById('roomCodeInput');
    const currentRoomCode = document.getElementById('currentRoomCode');
    const participantsContainer = document.getElementById('participantsContainer');
    const chatMessages = document.getElementById('chatMessages');
    const roomCodeDisplay = document.getElementById('roomCodeDisplay');
    const activeDisplayName = document.getElementById('activeDisplayName');
    const participantsCount = document.getElementById('participantsCount');

    // Create new room
    async function createRoom() {
        const user = firebase.auth().currentUser;
        if (!user) {
            window.auth.showError('Пользователь не авторизован');
            return;
        }

        // Generate 12-digit room code
        roomCode = generateRoomCode();
        
        try {
            // Get user's display name
            const userDoc = await db.collection('users').doc(user.uid).get();
            
            if (!userDoc.exists) {
                window.auth.showError('Профиль пользователя не найден');
                return;
            }
            
            const displayName = userDoc.data().displayName;

            // Create room in Firestore
            const roomRef = await db.collection('rooms').add({
                code: roomCode,
                hostId: user.uid,
                hostName: displayName,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                participants: [user.uid],
                active: true,
                createdBy: user.uid,
                createdAt_server: firebase.firestore.FieldValue.serverTimestamp()
            });

            currentRoom = roomRef.id;
            isHost = true;

            // Add host as participant
            await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).set({
                userId: user.uid,
                displayName: displayName,
                joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
                online: true,
                isHost: true,
                peerId: myPeerId || ''
            });

            // Initialize PeerJS
            myPeerId = window.peer.init(user.uid, displayName);
            window.peer.setCurrentRoom(currentRoom);

            // Update UI
            updateRoomCodeDisplay(roomCode);
            if (activeDisplayName) {
                activeDisplayName.textContent = displayName;
            }
            window.auth.showActiveRoom();
            
            // Start listening for participants
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
        const chars = '0123456789';
        let code = '';
        for (let i = 0; i < 12; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
        return code;
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
            window.auth.showSuccess('Поиск комнаты...');
            
            // Find room by code
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
            isHost = false;

            // Get user's display name
            const userDoc = await db.collection('users').doc(user.uid).get();
            
            if (!userDoc.exists) {
                window.auth.showError('Профиль пользователя не найден');
                return;
            }
            
            const displayName = userDoc.data().displayName;

            // Add user to room participants array
            await db.collection('rooms').doc(currentRoom).update({
                participants: firebase.firestore.FieldValue.arrayUnion(user.uid)
            });

            // Add user to participants subcollection
            await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).set({
                userId: user.uid,
                displayName: displayName,
                joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
                online: true,
                isHost: false,
                peerId: ''
            });

            // Initialize PeerJS
            myPeerId = window.peer.init(user.uid, displayName);
            window.peer.setCurrentRoom(currentRoom);

            // Update UI
            updateRoomCodeDisplay(roomCode);
            if (activeDisplayName) {
                activeDisplayName.textContent = displayName;
            }
            window.auth.showActiveRoom();

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

    // Update room code display
    function updateRoomCodeDisplay(code) {
        if (currentRoomCode) {
            currentRoomCode.textContent = code;
        }
        if (roomCodeDisplay) {
            roomCodeDisplay.textContent = code;
        }
    }

    // Listen to room changes
    function listenToRoom() {
        if (!currentRoom) return;
        
        if (roomListener) {
            roomListener();
        }

        roomListener = db.collection('rooms').doc(currentRoom)
            .onSnapshot((doc) => {
                if (!doc.exists) {
                    window.auth.showError('Комната не существует');
                    leaveRoom();
                } else {
                    const data = doc.data();
                    if (!data.active) {
                        window.auth.showError('Комната закрыта');
                        leaveRoom();
                    }
                }
            }, (error) => {
                console.error('Room listener error:', error);
                // Don't show error to user, just log it
            });
    }

    // Listen to participants
    function listenToParticipants() {
        if (!currentRoom) return;
        
        if (participantsListener) {
            participantsListener();
        }

        participantsListener = db.collection('rooms').doc(currentRoom)
            .collection('participants')
            .onSnapshot((snapshot) => {
                // Update participants count
                if (participantsCount) {
                    participantsCount.textContent = snapshot.size;
                }

                snapshot.docChanges().forEach((change) => {
                    const participantData = change.doc.data();
                    
                    if (change.type === 'added') {
                        addParticipantToUI(change.doc.id, participantData);
                        // Only connect to new participants if they're not the current user
                        if (change.doc.id !== firebase.auth().currentUser?.uid) {
                            connectToNewParticipant(change.doc.id, participantData);
                        }
                    }
                    
                    if (change.type === 'modified') {
                        updateParticipantInUI(change.doc.id, participantData);
                    }
                    
                    if (change.type === 'removed') {
                        removeParticipantFromUI(change.doc.id);
                    }
                });
            }, (error) => {
                console.error('Participants listener error:', error);
            });
    }

    // Listen to messages
    function listenToMessages() {
        if (!currentRoom) return;
        
        if (messagesListener) {
            messagesListener();
        }

        messagesListener = db.collection('rooms').doc(currentRoom)
            .collection('messages')
            .orderBy('timestamp', 'asc')
            .onSnapshot((snapshot) => {
                snapshot.docChanges().forEach((change) => {
                    if (change.type === 'added') {
                        const data = change.doc.data();
                        // Don't add own messages twice
                        if (data.senderId !== firebase.auth().currentUser?.uid) {
                            addMessageToUI(data.senderName, data.message);
                        }
                    }
                });
            }, (error) => {
                console.error('Messages listener error:', error);
            });
    }

    // Add participant to UI
    function addParticipantToUI(userId, data) {
        if (!participantsContainer) return;
        
        // Check if already exists
        if (document.getElementById(`participant-${userId}`)) return;

        const card = document.createElement('div');
        card.className = 'participant-card';
        card.id = `participant-${userId}`;
        
        const isCurrentUser = userId === firebase.auth().currentUser?.uid;
        const statusText = data.online ? '🔊 В сети' : '📴 Не в сети';
        const statusClass = data.online ? '' : 'muted';
        const hostBadge = data.isHost ? ' 👑' : '';
        
        card.innerHTML = `
            <div class="participant-name">
                ${data.displayName || 'Unknown'}${hostBadge}
                ${isCurrentUser ? '<span style="font-size: 12px; color: #667eea;"> (Вы)</span>' : ''}
            </div>
            <div class="participant-status ${statusClass}">
                ${statusText}
                ${data.muted ? ' 🔇' : ''}
            </div>
        `;

        participantsContainer.appendChild(card);
    }

    function updateParticipantInUI(userId, data) {
        const card = document.getElementById(`participant-${userId}`);
        if (card) {
            const statusDiv = card.querySelector('.participant-status');
            if (statusDiv) {
                statusDiv.textContent = data.online ? '🔊 В сети' : '📴 Не в сети';
                statusDiv.classList.toggle('muted', !data.online);
                if (data.muted) {
                    statusDiv.textContent += ' 🔇';
                }
            }
        }
    }

    function removeParticipantFromUI(userId) {
        const card = document.getElementById(`participant-${userId}`);
        if (card) {
            card.remove();
        }
    }

    function addMessageToUI(sender, message) {
        if (!chatMessages) return;
        
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message';
        messageDiv.innerHTML = `<span class="message-sender">${sender}:</span> <span class="message-text">${message}</span>`;
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // Connect to new participant via PeerJS
    function connectToNewParticipant(userId, data) {
        if (!data.peerId) return;
        
        // Check if we already have a connection
        if (window.peer && typeof window.peer.connectToPeer === 'function') {
            console.log('Connecting to new participant:', userId, 'with peerId:', data.peerId);
            window.peer.connectToPeer(data.peerId, userId);
        }
    }

    // Copy room code to clipboard
    function copyRoomCode() {
        if (!roomCode) return;
        
        navigator.clipboard.writeText(roomCode).then(() => {
            window.auth.showSuccess('Код скопирован в буфер обмена!');
        }).catch((err) => {
            console.error('Error copying to clipboard:', err);
            window.auth.showError('Ошибка копирования кода');
        });
    }

    // Leave room
    async function leaveRoom() {
        const user = firebase.auth().currentUser;
        
        if (currentRoom && user) {
            try {
                // Update participant status
                await db.collection('rooms').doc(currentRoom)
                    .collection('participants').doc(user.uid)
                    .update({
                        online: false,
                        leftAt: firebase.firestore.FieldValue.serverTimestamp()
                    });

                // Remove from room participants array
                await db.collection('rooms').doc(currentRoom).update({
                    participants: firebase.firestore.FieldValue.arrayRemove(user.uid)
                });

                // Check if room is empty and user is host
                const roomDoc = await db.collection('rooms').doc(currentRoom).get();
                if (roomDoc.exists) {
                    const roomData = roomDoc.data();
                    const participants = roomData.participants || [];
                    
                    // If room is empty or host is leaving and no other participants, close the room
                    if (participants.length === 0 || (roomData.hostId === user.uid && participants.length === 1)) {
                        await db.collection('rooms').doc(currentRoom).update({
                            active: false,
                            closedAt: firebase.firestore.FieldValue.serverTimestamp(),
                            closedBy: user.uid
                        });
                    }
                }
            } catch (error) {
                console.error('Error leaving room:', error);
            }
        }

        // Clean up listeners
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

        // Clean up PeerJS
        if (window.peer && typeof window.peer.cleanup === 'function') {
            window.peer.cleanup();
        }

        // Clear UI
        if (participantsContainer) {
            participantsContainer.innerHTML = '';
        }
        if (chatMessages) {
            chatMessages.innerHTML = '';
        }
        
        // Reset room variables
        currentRoom = null;
        roomCode = null;
        isHost = false;
        myPeerId = null;

        // Show room container
        const roomContainer = document.getElementById('roomContainer');
        const activeRoomContainer = document.getElementById('activeRoomContainer');
        
        if (roomContainer) {
            roomContainer.classList.remove('hidden');
        }
        if (activeRoomContainer) {
            activeRoomContainer.classList.add('hidden');
        }
        
        window.auth.showSuccess('Вы покинули комнату');
        
        // Clear room code input
        if (roomCodeInput) {
            roomCodeInput.value = '';
        }
    }

    // Get current room info
    function getCurrentRoom() {
        return currentRoom;
    }

    function getRoomCode() {
        return roomCode;
    }

    function isCurrentUserHost() {
        return isHost;
    }

    // Public API
    return {
        createRoom,
        joinRoom,
        leaveRoom,
        copyRoomCode,
        getCurrentRoom,
        getRoomCode,
        isCurrentUserHost
    };
})();
