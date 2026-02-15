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
    let currentUser = null;
    let kickedListener = null;
    let wasKicked = false;
    let lastHeartbeatTime = Date.now();

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

        // Check if user was kicked
        const kickedStatus = localStorage.getItem('kicked_' + user.uid);
        if (kickedStatus) {
            localStorage.removeItem('kicked_' + user.uid);
        }

        currentUser = user;
        roomCode = generateRoomCode();
        
        try {
            const userDoc = await db.collection('users').doc(user.uid).get();
            
            if (!userDoc.exists) {
                window.auth.showError('Профиль пользователя не найден');
                return;
            }
            
            const displayName = userDoc.data().displayName;

            // Create room with host information
            const roomRef = await db.collection('rooms').add({
                code: roomCode,
                hostId: user.uid,
                hostName: displayName,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                participants: [user.uid],
                active: true,
                lastActive: firebase.firestore.FieldValue.serverTimestamp(),
                createdBy: user.uid
            });

            currentRoom = roomRef.id;
            isHost = true;

            // Add host as participant with host privileges
            await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).set({
                userId: user.uid,
                displayName: displayName,
                joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
                isHost: true,
                online: true,
                lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
                muted: false,
                canMute: true,
                canKick: true,
                canDelete: true
            });

            // Initialize WebRTC
            await window.peer.init(user.uid, displayName);
            window.peer.setCurrentRoom(currentRoom);

            // Start heartbeat
            startHeartbeat();

            // Start connection checker
            startConnectionChecker();

            // Listen for kick
            listenForKick();

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

        // Check if user was kicked from this room
        const kickedStatus = localStorage.getItem('kicked_' + user.uid + '_' + code);
        if (kickedStatus) {
            const kickTime = parseInt(kickedStatus);
            const now = Date.now();
            // If kicked less than 30 seconds ago, prevent rejoin
            if (now - kickTime < 30000) {
                window.auth.showError('Вас выгнали из этой комнаты. Подождите 30 секунд перед повторным входом.');
                return;
            } else {
                localStorage.removeItem('kicked_' + user.uid + '_' + code);
            }
        }

        currentUser = user;

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
            const roomData = roomDoc.data();
            
            currentRoom = roomDoc.id;
            roomCode = code;
            
            // Check if current user is the host
            isHost = (roomData.hostId === user.uid);

            const userDoc = await db.collection('users').doc(user.uid).get();
            if (!userDoc.exists) {
                window.auth.showError('Профиль пользователя не найден');
                return;
            }
            
            const displayName = userDoc.data().displayName;

            // Check if user already exists in participants (from previous session)
            const existingParticipant = await db.collection('rooms').doc(currentRoom)
                .collection('participants').doc(user.uid).get();
            
            if (existingParticipant.exists) {
                // Update existing participant
                await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).update({
                    online: true,
                    lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
                    isHost: isHost,
                    muted: false
                });
            } else {
                // Add new participant
                await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).set({
                    userId: user.uid,
                    displayName: displayName,
                    joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    isHost: isHost,
                    online: true,
                    lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
                    muted: false,
                    canMute: isHost,
                    canKick: isHost,
                    canDelete: isHost
                });
            }

            // Add to room participants array if not already there
            if (!roomData.participants.includes(user.uid)) {
                await db.collection('rooms').doc(currentRoom).update({
                    participants: firebase.firestore.FieldValue.arrayUnion(user.uid),
                    lastActive: firebase.firestore.FieldValue.serverTimestamp()
                });
            }

            // Initialize WebRTC
            await window.peer.init(user.uid, displayName);
            window.peer.setCurrentRoom(currentRoom);

            // Start heartbeat
            startHeartbeat();

            // Start connection checker
            startConnectionChecker();

            // Listen for kick
            listenForKick();

            // Update UI
            updateRoomCodeDisplay(roomCode);
            if (activeDisplayName) activeDisplayName.textContent = displayName;
            if (roomContainer) roomContainer.classList.add('hidden');
            if (activeRoomContainer) activeRoomContainer.classList.remove('hidden');

            // Start listening
            listenToRoom();
            listenToParticipants();
            listenToMessages();

            // Send join message
            await db.collection('rooms').doc(currentRoom).collection('messages').add({
                senderId: 'system',
                senderName: '🔔 Система',
                message: `${displayName} присоединился к комнате`,
                type: 'join',
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });

            window.auth.showSuccess('Подключение к комнате выполнено');
        } catch (error) {
            console.error('Error joining room:', error);
            window.auth.showError('Ошибка подключения к комнате: ' + error.message);
        }
    }

    // Listen for being kicked
    function listenForKick() {
        if (!currentRoom || !currentUser) return;
        
        if (kickedListener) {
            kickedListener();
        }

        // Listen for deletion of own participant document (means we were kicked)
        kickedListener = db.collection('rooms').doc(currentRoom)
            .collection('participants').doc(currentUser.uid)
            .onSnapshot((doc) => {
                if (!doc.exists && currentRoom && !leaveInProgress && !wasKicked) {
                    console.log('You have been kicked from the room');
                    
                    // Mark as kicked
                    wasKicked = true;
                    
                    // Save kick timestamp to localStorage
                    if (roomCode) {
                        localStorage.setItem('kicked_' + currentUser.uid + '_' + roomCode, Date.now().toString());
                    }
                    
                    // Show message
                    window.auth.showError('❌ Вас выгнали из комнаты');
                    
                    // Force leave
                    forceLeave();
                }
            }, (error) => {
                console.error('Kick listener error:', error);
            });
    }

    // Force leave without cleanup
    function forceLeave() {
        console.log('Force leaving room due to kick');
        
        leaveInProgress = true;
        
        // Stop all listeners first
        stopAllListeners();
        
        // Cleanup WebRTC
        if (window.peer && typeof window.peer.cleanup === 'function') {
            window.peer.cleanup();
        }

        // Clear UI
        if (participantsContainer) participantsContainer.innerHTML = '';
        if (chatMessages) chatMessages.innerHTML = '';
        
        // Reset variables
        currentRoom = null;
        roomCode = null;
        isHost = false;
        leaveInProgress = false;
        wasKicked = false;

        // Show room container
        if (roomContainer) roomContainer.classList.remove('hidden');
        if (activeRoomContainer) activeRoomContainer.classList.add('hidden');
        if (roomCodeInput) roomCodeInput.value = '';
    }

    function stopAllListeners() {
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
        if (kickedListener) {
            kickedListener();
            kickedListener = null;
        }
    }

    // Mute participant (host only)
    async function muteParticipant(userId) {
        if (!isHost || !currentRoom) return;
        
        try {
            await db.collection('rooms').doc(currentRoom).collection('participants').doc(userId).update({
                muted: true
            });
            console.log('Participant muted:', userId);
            
            // Close WebRTC connection to this participant
            if (window.peer && typeof window.peer.closeConnection === 'function') {
                window.peer.closeConnection(userId);
            }

            // Send mute notification
            await db.collection('rooms').doc(currentRoom).collection('messages').add({
                senderId: 'system',
                senderName: '🔇 Система',
                message: `Участник был заглушен`,
                type: 'mute',
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });
        } catch (error) {
            console.error('Error muting participant:', error);
        }
    }

    // Unmute participant (host only)
    async function unmuteParticipant(userId) {
        if (!isHost || !currentRoom) return;
        
        try {
            await db.collection('rooms').doc(currentRoom).collection('participants').doc(userId).update({
                muted: false
            });
            console.log('Participant unmuted:', userId);
            
            // Reconnect to participant
            setTimeout(() => {
                window.peer.connectToPeer(userId);
            }, 1000);

            // Send unmute notification
            await db.collection('rooms').doc(currentRoom).collection('messages').add({
                senderId: 'system',
                senderName: '🔊 Система',
                message: `Участник разглушен`,
                type: 'unmute',
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });
        } catch (error) {
            console.error('Error unmuting participant:', error);
        }
    }

    // Kick participant (host only)
    async function kickParticipant(userId) {
        if (!isHost || !currentRoom || userId === currentUser?.uid) return;
        
        try {
            // Get participant name before removing
            const participantDoc = await db.collection('rooms').doc(currentRoom)
                .collection('participants').doc(userId).get();
            const participantName = participantDoc.exists ? participantDoc.data().displayName : 'Участник';

            // Close WebRTC connection to this participant
            if (window.peer && typeof window.peer.closeConnection === 'function') {
                window.peer.closeConnection(userId);
            }

            // Remove participant from room
            await db.collection('rooms').doc(currentRoom).collection('participants').doc(userId).delete();
            
            // Remove from participants array
            await db.collection('rooms').doc(currentRoom).update({
                participants: firebase.firestore.FieldValue.arrayRemove(userId)
            });

            // Send kick notification
            await db.collection('rooms').doc(currentRoom).collection('messages').add({
                senderId: 'system',
                senderName: '👑 Система',
                message: `${participantName} был удален из комнаты`,
                type: 'kick',
                targetUserId: userId,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            console.log('Participant kicked:', userId);
            window.auth.showSuccess('Участник удален');
        } catch (error) {
            console.error('Error kicking participant:', error);
            window.auth.showError('Ошибка при удалении участника');
        }
    }

    // Delete room (host only)
    async function deleteRoom() {
        if (!isHost || !currentRoom) return;
        
        try {
            // Notify all participants
            await db.collection('rooms').doc(currentRoom).collection('messages').add({
                senderId: 'system',
                senderName: '👑 Система',
                message: 'Комната была удалена создателем',
                type: 'room_deleted',
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });

            // Close all WebRTC connections
            if (window.peer && typeof window.peer.cleanup === 'function') {
                window.peer.cleanup();
            }

            // Delete all messages
            const messagesSnapshot = await db.collection('rooms').doc(currentRoom).collection('messages').get();
            const batch = db.batch();
            messagesSnapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            
            // Delete all participants
            const participantsSnapshot = await db.collection('rooms').doc(currentRoom).collection('participants').get();
            participantsSnapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            
            // Delete signaling data
            const signalingSnapshot = await db.collection('rooms').doc(currentRoom).collection('signaling').get();
            signalingSnapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            
            // Delete ICE candidates
            const iceSnapshot = await db.collection('rooms').doc(currentRoom).collection('iceCandidates').get();
            iceSnapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            
            // Delete the room itself
            batch.delete(db.collection('rooms').doc(currentRoom));
            
            await batch.commit();
            console.log('Room deleted by host');
            
            window.auth.showSuccess('Комната удалена');
            forceLeave();
        } catch (error) {
            console.error('Error deleting room:', error);
            window.auth.showError('Ошибка при удалении комнаты');
        }
    }

    // Heartbeat - обновляет статус online каждые 3 секунды
    function startHeartbeat() {
        const user = firebase.auth().currentUser;
        if (!user || !currentRoom) return;

        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }

        heartbeatInterval = setInterval(async () => {
            if (currentRoom && user && window.navigator.onLine && !leaveInProgress && !wasKicked) {
                try {
                    await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).update({
                        online: true,
                        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
                    });
                    lastHeartbeatTime = Date.now();
                    console.log('Heartbeat sent');
                } catch (error) {
                    console.error('Error sending heartbeat:', error);
                }
            }
        }, 3000); // Каждые 3 секунды

        window.addEventListener('beforeunload', handleBeforeUnload);
        window.addEventListener('pagehide', handlePageHide);
    }

    function handleBeforeUnload() {
        console.log('Page is being unloaded, leaving room');
        immediateLeave();
    }

    function handlePageHide() {
        console.log('Page is being hidden, leaving room');
        immediateLeave();
    }

    function immediateLeave() {
        const user = firebase.auth().currentUser;
        if (currentRoom && user && !leaveInProgress && !wasKicked) {
            leaveInProgress = true;
            
            // Отправляем статус offline
            const url = `https://firestore.googleapis.com/v1/projects/${firebase.app().options.projectId}/databases/(default)/documents/rooms/${currentRoom}/participants/${user.uid}`;
            
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
            
            // Также пытаемся выполнить нормальный выход
            leaveRoom().catch(console.error);
        }
    }

    function startConnectionChecker() {
        if (connectionCheckInterval) {
            clearInterval(connectionCheckInterval);
        }

        connectionCheckInterval = setInterval(() => {
            if (!window.navigator.onLine && !leaveInProgress && !wasKicked) {
                console.log('Internet connection lost');
                window.auth.showError('Потеряно соединение с интернетом');
            }
        }, 5000);
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
                if (!doc.exists && !leaveInProgress && !wasKicked) {
                    console.log('Room deleted');
                    window.auth.showError('Комната была удалена');
                    forceLeave();
                }
            }, (error) => {
                console.error('Room listener error:', error);
            });
    }

    function listenToParticipants() {
        if (!currentRoom) return;
        if (participantsListener) participantsListener();

        participantsListener = db.collection('rooms').doc(currentRoom)
            .collection('participants')
            .onSnapshot((snapshot) => {
                if (leaveInProgress || wasKicked) return;
                
                const now = Date.now();
                const currentUserId = firebase.auth().currentUser?.uid;
                
                // Filter online participants (lastSeen not older than 7 seconds)
                const onlineParticipants = snapshot.docs.filter(doc => {
                    const data = doc.data();
                    
                    // Current user always online
                    if (doc.id === currentUserId) {
                        return true;
                    }
                    
                    if (!data.online) return false;
                    
                    if (data.lastSeen) {
                        const lastSeen = data.lastSeen.toDate ? data.lastSeen.toDate() : new Date(data.lastSeen);
                        const diff = now - lastSeen.getTime();
                        // 7 секунд - компромисс между фоновым режимом и своевременным удалением
                        return diff < 7000; 
                    }
                    return false;
                });

                if (participantsCount) participantsCount.textContent = onlineParticipants.length;

                // Check for empty room (excluding current user)
                const otherParticipants = onlineParticipants.filter(p => p.id !== currentUserId);
                checkEmptyRoom(otherParticipants);

                // Get online IDs
                const onlineIds = new Set(onlineParticipants.map(doc => doc.id));
                
                // Remove from UI only those not online AND not current user
                document.querySelectorAll('.participant-card').forEach(card => {
                    const cardId = card.id.replace('participant-', '');
                    if (!onlineIds.has(cardId) && cardId !== currentUserId) {
                        removeParticipantFromUI(cardId);
                    }
                });

                // Add or update online participants
                onlineParticipants.forEach(doc => {
                    const data = doc.data();
                    const card = document.getElementById(`participant-${doc.id}`);
                    
                    if (card) {
                        updateParticipantInUI(doc.id, data);
                    } else {
                        addParticipantToUI(doc.id, data);
                    }
                });

                // Connect to new participants (not self)
                onlineParticipants.forEach(doc => {
                    if (doc.id !== currentUserId) {
                        setTimeout(() => {
                            window.peer.connectToPeer(doc.id);
                        }, 1000);
                    }
                });
            }, (error) => {
                console.error('Participants listener error:', error);
            });
    }

    function checkEmptyRoom(otherParticipants) {
        if (roomCheckTimeout) {
            clearTimeout(roomCheckTimeout);
        }

        // Only delete if there are NO other participants
        if (otherParticipants.length === 0) {
            console.log('Room has no other participants, scheduling deletion in 7 seconds');
            roomCheckTimeout = setTimeout(async () => {
                if (currentRoom) {
                    try {
                        const checkSnapshot = await db.collection('rooms').doc(currentRoom)
                            .collection('participants')
                            .get();
                        
                        // If only current user remains, delete room
                        if (checkSnapshot.size <= 1) {
                            await db.collection('rooms').doc(currentRoom).delete();
                            console.log('Room deleted - no other participants');
                            
                            if (!leaveInProgress && !wasKicked) {
                                window.auth.showError('Комната удалена');
                                forceLeave();
                            }
                        }
                    } catch (error) {
                        console.error('Error deleting empty room:', error);
                    }
                }
            }, 7000); // 7 секунд
        }
    }

    function listenToMessages() {
        if (!currentRoom) return;
        if (messagesListener) messagesListener();

        messagesListener = db.collection('rooms').doc(currentRoom)
            .collection('messages')
            .orderBy('timestamp', 'asc')
            .onSnapshot((snapshot) => {
                if (leaveInProgress || wasKicked) return;
                
                snapshot.docChanges().forEach((change) => {
                    if (change.type === 'added') {
                        const data = change.doc.data();
                        
                        // Handle system messages
                        if (data.type === 'kick' && data.targetUserId === currentUser?.uid) {
                            console.log('Kick message received');
                            forceLeave();
                        } else if (data.type === 'room_deleted') {
                            console.log('Room deleted message received');
                            forceLeave();
                        } else if (data.senderId !== firebase.auth().currentUser?.uid) {
                            // Regular message
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
        
        // Check if already exists
        if (document.getElementById(`participant-${userId}`)) return;

        const card = document.createElement('div');
        card.className = 'participant-card';
        card.id = `participant-${userId}`;
        
        const isCurrentUser = userId === firebase.auth().currentUser?.uid;
        const hostBadge = data.isHost ? ' 👑' : '';
        const mutedIcon = data.muted ? ' 🔇' : '';
        
        // Add special class for current user
        if (isCurrentUser) {
            card.classList.add('current-user');
        }
        
        let controls = '';
        if (isHost && !isCurrentUser && data.isHost === false) {
            controls = `
                <div class="participant-controls">
                    <button class="mute-btn" onclick="window.room.${data.muted ? 'unmuteParticipant' : 'muteParticipant'}('${userId}')">
                        ${data.muted ? '🔊 Включить звук' : '🔇 Заглушить'}
                    </button>
                    <button class="kick-btn" onclick="if(confirm('Вы уверены, что хотите выгнать этого участника?')) window.room.kickParticipant('${userId}')">
                        👢 Выгнать
                    </button>
                </div>
            `;
        }
        
        card.innerHTML = `
            <div class="participant-name">
                ${data.displayName || 'Unknown'}${hostBadge}
                ${isCurrentUser ? '<span style="font-size: 12px;"> (Вы)</span>' : ''}
            </div>
            <div class="participant-status">
                🟢 В сети${mutedIcon}
            </div>
            ${controls}
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
            
            // Update mute button if exists
            const muteBtn = card.querySelector('.mute-btn');
            if (muteBtn && isHost) {
                muteBtn.textContent = data.muted ? '🔊 Включить звук' : '🔇 Заглушить';
                muteBtn.setAttribute('onclick', `window.room.${data.muted ? 'unmuteParticipant' : 'muteParticipant'}('${userId}')`);
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
        if (leaveInProgress || wasKicked) return;
        leaveInProgress = true;
        
        const user = firebase.auth().currentUser;
        console.log('Leaving room:', currentRoom, 'user:', user?.uid);
        
        if (currentRoom && user) {
            try {
                // Send leave message
                const userDoc = await db.collection('users').doc(user.uid).get();
                const displayName = userDoc.exists ? userDoc.data().displayName : 'Пользователь';
                
                await db.collection('rooms').doc(currentRoom).collection('messages').add({
                    senderId: 'system',
                    senderName: '🔔 Система',
                    message: `${displayName} покинул комнату`,
                    type: 'leave',
                    timestamp: firebase.firestore.FieldValue.serverTimestamp()
                });

                // Mark user as offline
                await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).update({
                    online: false,
                    leftAt: firebase.firestore.FieldValue.serverTimestamp()
                });

                // Remove user from participants array
                await db.collection('rooms').doc(currentRoom).update({
                    participants: firebase.firestore.FieldValue.arrayRemove(user.uid)
                });
            } catch (error) {
                console.error('Error leaving room:', error);
            }
        }

        stopAllListeners();
        
        if (window.peer && typeof window.peer.cleanup === 'function') {
            window.peer.cleanup();
        }

        if (participantsContainer) participantsContainer.innerHTML = '';
        if (chatMessages) chatMessages.innerHTML = '';
        
        currentRoom = null;
        roomCode = null;
        isHost = false;
        leaveInProgress = false;

        if (roomContainer) roomContainer.classList.remove('hidden');
        if (activeRoomContainer) activeRoomContainer.classList.add('hidden');
        
        window.auth.showSuccess('Вы покинули комнату');
        if (roomCodeInput) roomCodeInput.value = '';
    }

    // Public API
    return {
        createRoom,
        joinRoom,
        leaveRoom,
        copyRoomCode,
        muteParticipant,
        unmuteParticipant,
        kickParticipant,
        deleteRoom,
        getCurrentRoom: () => currentRoom,
        getRoomCode: () => roomCode,
        isCurrentUserHost: () => isHost
    };
})();
