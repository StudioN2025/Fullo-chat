// Room Module - Firebase integration
window.room = (function() {
    console.log('Initializing room module...');
    
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
    let enlargedVideo = null;

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
    const encryptionBadge = document.getElementById('encryptionBadge');
    const localVideoContainer = document.getElementById('localVideoContainer');
    const localScreenContainer = document.getElementById('localScreenContainer');

    // Проверка, что все DOM элементы найдены
    console.log('DOM Elements loaded:', {
        roomCodeInput: !!roomCodeInput,
        participantsContainer: !!participantsContainer,
        activeRoomContainer: !!activeRoomContainer
    });

    // Проверка бана перед действиями
    async function checkBanBeforeAction() {
        const user = auth.currentUser;
        if (!user) return true;
        
        try {
            const userDoc = await db.collection(AppwriteClient.usersCollectionId).doc(user.uid).get();
            if (!userDoc.exists) return false;
            
            const userData = userDoc.data();
            
            if (userData.banned) {
                if (userData.banExpiry) {
                    const expiryDate = new Date(userData.banExpiry);
                    if (expiryDate > new Date()) {
                        window.auth.showError('❌ Ваш аккаунт заблокирован');
                        await auth.signOut();
                        return true;
                    }
                } else {
                    window.auth.showError('❌ Ваш аккаунт заблокирован');
                    await auth.signOut();
                    return true;
                }
            }
        } catch (error) {
            console.error('Error checking ban:', error);
        }
        return false;
    }

    // Увеличение видео
    function enlargeVideo(userId, type) {
        console.log('Enlarging video:', userId, type);
        const videoElement = document.getElementById(type + '-' + userId);
        if (!videoElement) return;
        
        if (enlargedVideo === userId + type) {
            videoElement.classList.remove('enlarged');
            enlargedVideo = null;
        } else {
            if (enlargedVideo) {
                const prevId = enlargedVideo.slice(0, -1);
                const prevType = enlargedVideo.slice(-1) === 'v' ? 'video' : 'screen';
                const prevVideo = document.getElementById(prevType + '-' + prevId);
                if (prevVideo) prevVideo.classList.remove('enlarged');
            }
            
            videoElement.classList.add('enlarged');
            enlargedVideo = userId + type;
            videoElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    // Create new room
    async function createRoom() {
        console.log('createRoom called');
        
        // Проверяем бан перед созданием
        if (await checkBanBeforeAction()) return;
        
        const user = auth.currentUser;
        if (!user) {
            window.auth.showError('Пользователь не авторизован');
            return;
        }

        currentUser = user;
        roomCode = generateRoomCode();
        
        try {
            const userDoc = await db.collection(AppwriteClient.usersCollectionId).doc(user.uid).get();
            
            if (!userDoc.exists) {
                window.auth.showError('Профиль пользователя не найден');
                return;
            }
            
            const displayName = userDoc.data().displayName;
            const avatar = userDoc.data().avatar || null;

            // Create room with host information
            const roomRef = await db.collection(AppwriteClient.roomsCollectionId).add({
                code: roomCode,
                hostId: user.uid,
                hostName: displayName,
                createdAt: new Date().toISOString(),
                participants: [user.uid],
                active: true,
                lastActive: new Date().toISOString(),
                createdBy: user.uid,
                encrypted: true
            });

            currentRoom = roomRef.id;
            isHost = true;

            // Обновляем текущую комнату пользователя
            await db.collection(AppwriteClient.usersCollectionId).doc(user.uid).update({
                currentRoom: currentRoom,
                online: true,
                lastSeen: new Date().toISOString()
            });

            // Add host as participant with host privileges
            await db.collection(AppwriteClient.roomsCollectionId).doc(currentRoom).collection('participants').doc(user.uid).set({
                userId: user.uid,
                displayName: displayName,
                avatar: avatar,
                joinedAt: new Date().toISOString(),
                isHost: true,
                online: true,
                lastSeen: new Date().toISOString(),
                muted: false,
                camera: false,
                screen: false
            });

            // Initialize WebRTC
            if (window.peer && typeof window.peer.init === 'function') {
                await window.peer.init(user.uid, displayName);
                window.peer.setCurrentRoom(currentRoom);
            } else {
                console.error('Peer module not loaded');
            }

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

            window.auth.showSuccess('Комната создана! Код: ' + roomCode);
        } catch (error) {
            console.error('Error creating room:', error);
            window.auth.showError('Ошибка создания комнаты: ' + error.message);
        }
    }

    // ... (остальной код room.js - слушатели, heartbeat, и т.д.)

    // Public API - ВАЖНО: все методы должны быть здесь
    return {
        createRoom: createRoom,
        joinRoom: joinRoom,
        leaveRoom: leaveRoom,
        copyRoomCode: copyRoomCode,
        muteParticipant: muteParticipant,
        unmuteParticipant: unmuteParticipant,
        kickParticipant: kickParticipant,
        deleteRoom: deleteRoom,
        enlargeVideo: enlargeVideo,
        getCurrentRoom: function() { return currentRoom; },
        getRoomCode: function() { return roomCode; },
        isCurrentUserHost: function() { return isHost; }
    };
})();

console.log('room.js loaded, window.room:', window.room);
