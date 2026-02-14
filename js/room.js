// Room Module - Firebase integration
window.room = (function() {
    let currentRoom = null;
    let roomCode = null;
    let roomListener = null;
    let participantsListener = null;
    let messagesListener = null;
    let myPeerId = null;

    // DOM Elements
    const roomCodeInput = document.getElementById('roomCodeInput');
    const currentRoomCode = document.getElementById('currentRoomCode');
    const participantsContainer = document.getElementById('participantsContainer');
    const chatMessages = document.getElementById('chatMessages');

    // Create new room
    async function createRoom() {
        const user = firebase.auth().currentUser;
        if (!user) return;

        // Generate 12-digit room code
        roomCode = generateRoomCode();
        
        try {
            // Get user's display name
            const userDoc = await db.collection('users').doc(user.uid).get();
            const displayName = userDoc.data().displayName;

            // Create room in Firestore
            const roomRef = await db.collection('rooms').add({
                code: roomCode,
                hostId: user.uid,
                hostName: displayName,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                participants: [user.uid],
                active: true
            });

            currentRoom = roomRef.id;

            // Add host as participant
            await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).set({
                userId: user.uid,
                displayName: displayName,
                joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
                online: true
            });

            // Initialize PeerJS
            myPeerId = window.peer.init(user.uid, displayName);
            window.peer.setCurrentRoom(currentRoom);

            // Update UI
            currentRoomCode.textContent = roomCode;
            window.auth.showActiveRoom();
            
            // Start listening for participants
            listenToRoom();
            listenToParticipants();
            listenToMessages();

            window.auth.showSuccess(`Комната создана! Код: ${roomCode}`);
        } catch (error) {
            console.error('Error creating room:', error);
            window.auth.showError('Ошибка создания комнаты');
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
        if (!user) return;

        try {
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

            // Get user's display name
            const userDoc = await db.collection('users').doc(user.uid).get();
            const displayName = userDoc.data().displayName;

            // Add user to room participants
            await db.collection('rooms').doc(currentRoom).update({
                participants: firebase.firestore.FieldValue.arrayUnion(user.uid)
            });

            await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).set({
                userId: user.uid,
                displayName: displayName,
                joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
                online: true
            });

            // Initialize PeerJS
            myPeerId = window.peer.init(user.uid, displayName);
            window.peer.setCurrentRoom(currentRoom);

            // Update UI
            currentRoomCode.textContent = roomCode;
            window.auth.showActiveRoom();

            // Start listening
            listenToRoom();
            listenToParticipants();
            listenToMessages();

            window.auth.showSuccess('Подключение к комнате выполнено');
        } catch (error) {
            console.error('Error joining room:', error);
            window.auth.showError('Ошибка подключения к комнате');
        }
    }

    // Listen to room changes
    function listenToRoom() {
        if (roomListener) roomListener();

        roomListener = db.collection('rooms').doc(currentRoom)
            .onSnapshot((doc) => {
                if (!doc.exists || !doc.data().active) {
                    // Room was closed
                    window.auth.showError('Комната закрыта');
                    leaveRoom();
                }
            });
    }

    // Listen to participants
    function listenToParticipants() {
        if (participantsListener) participantsListener();

        participantsListener = db.collection('rooms').doc(currentRoom)
            .collection('participants')
            .onSnapshot((snapshot) => {
                snapshot.docChanges().forEach((change) => {
                    if (change.type === 'added') {
                        addParticipantToUI(change.doc.id, change.doc.data());
                        connectToNewParticipant(change.doc.id, change.doc.data());
                    }
                    if (change.type === 'modified') {
                        updateParticipantInUI(change.doc.id, change.doc.data());
                    }
                    if (change.type === 'removed') {
                        removeParticipantFromUI(change.doc.id);
                    }
                });
            });
    }

    // Listen to messages
    function listenToMessages() {
        if (messagesListener) messagesListener();

        messagesListener = db.collection('rooms').doc(currentRoom)
            .collection('messages')
            .orderBy('timestamp', 'asc')
            .onSnapshot((snapshot) => {
                snapshot.docChanges().forEach((change) => {
                    if (change.type === 'added') {
                        const data = change.doc.data();
                        addMessageToUI(data.senderName, data.message);
                    }
                });
            });
    }

    // Add participant to UI
    function addParticipantToUI(userId, data) {
        // Check if already exists
        if (document.getElementById(`participant-${userId}`)) return;

        const card = document.createElement('div');
        card.className = 'participant-card';
        card.id = `participant-${userId}`;
        
        const isCurrentUser = userId === firebase.auth().currentUser.uid;
        const statusText = data.online ? '🔊 В сети' : '📴 Не в сети';
        const statusClass = data.online ? '' : 'muted';
        
        card.innerHTML = `
            <div class="participant-name">${data.displayName} ${isCurrentUser ? '(Вы)' : ''}</div>
            <div class="participant-status ${statusClass}">${statusText}</div>
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
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message';
        messageDiv.innerHTML = `<span class="message-sender">${sender}:</span> <span class="message-text">${message}</span>`;
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // Connect to new participant via PeerJS
    function connectToNewParticipant(userId, data) {
        if (userId === firebase.auth().currentUser.uid) return;
        if (!data.peerId) return;

        // Connect via PeerJS
        window.peer.connectToPeer(data.peerId, userId);
    }

    // Copy room code to clipboard
    function copyRoomCode() {
        navigator.clipboard.writeText(roomCode).then(() => {
            window.auth.showSuccess('Код скопирован!');
        }).catch(() => {
            window.auth.showError('Ошибка копирования');
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

                // Check if room is empty
                const roomDoc = await db.collection('rooms').doc(currentRoom).get();
                const participants = roomDoc.data().participants || [];
                
                if (participants.length === 0) {
                    // Close the room
                    await db.collection('rooms').doc(currentRoom).update({
                        active: false,
                        closedAt: firebase.firestore.FieldValue.serverTimestamp()
                    });
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
        window.peer.cleanup();

        // Clear UI
        participantsContainer.innerHTML = '';
        chatMessages.innerHTML = '';
        
        currentRoom = null;
        roomCode = null;

        // Show room container
        document.getElementById('roomContainer').classList.remove('hidden');
        document.getElementById('activeRoomContainer').classList.add('hidden');
    }

    // Public API
    return {
        createRoom,
        joinRoom,
        leaveRoom,
        copyRoomCode,
        currentRoom: () => currentRoom
    };
})();