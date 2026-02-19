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

    // Проверка бана перед действиями
    async function checkBanBeforeAction() {
        const user = firebase.auth().currentUser;
        if (!user) return true;
        
        try {
            const userDoc = await db.collection('users').doc(user.uid).get();
            if (!userDoc.exists) return false;
            
            const userData = userDoc.data();
            
            if (userData.banned) {
                if (userData.banExpiry) {
                    const expiryDate = userData.banExpiry.toDate();
                    if (expiryDate > new Date()) {
                        window.auth.showError('❌ Ваш аккаунт заблокирован');
                        await firebase.auth().signOut();
                        return true;
                    }
                } else {
                    window.auth.showError('❌ Ваш аккаунт заблокирован');
                    await firebase.auth().signOut();
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
        const videoElement = document.getElementById(type + '-' + userId);
        if (!videoElement) return;
        
        if (enlargedVideo === userId + type) {
            // Если уже увеличено, уменьшаем
            videoElement.classList.remove('enlarged');
            enlargedVideo = null;
        } else {
            // Убираем увеличение с предыдущего видео
            if (enlargedVideo) {
                const prevId = enlargedVideo.slice(0, -1);
                const prevType = enlargedVideo.slice(-1) === 'v' ? 'video' : 'screen';
                const prevVideo = document.getElementById(prevType + '-' + prevId);
                if (prevVideo) prevVideo.classList.remove('enlarged');
            }
            
            // Увеличиваем текущее
            videoElement.classList.add('enlarged');
            enlargedVideo = userId + type;
            
            // Прокручиваем к видео
            videoElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    // Create new room
    async function createRoom() {
        // Проверяем бан перед созданием
        if (await checkBanBeforeAction()) return;
        
        const user = firebase.auth().currentUser;
        if (!user) {
            window.auth.showError('Пользователь не авторизован');
            return;
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
            const avatar = userDoc.data().avatar || null;

            // Create room with host information
            const roomRef = await db.collection('rooms').add({
                code: roomCode,
                hostId: user.uid,
                hostName: displayName,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                participants: [user.uid],
                active: true,
                lastActive: firebase.firestore.FieldValue.serverTimestamp(),
                createdBy: user.uid,
                encrypted: true
            });

            currentRoom = roomRef.id;
            isHost = true;

            // Обновляем текущую комнату пользователя
            await db.collection('users').doc(user.uid).update({
                currentRoom: currentRoom,
                online: true,
                lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            });

            // Add host as participant with host privileges
            await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).set({
                userId: user.uid,
                displayName: displayName,
                avatar: avatar,
                joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
                isHost: true,
                online: true,
                lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
                muted: false,
                camera: false,
                screen: false
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

            window.auth.showSuccess('Комната создана! Код: ' + roomCode);
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
        // Проверяем бан перед входом
        if (await checkBanBeforeAction()) return;
        
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
            if (now - kickTime < 30000) {
                window.auth.showError('Вас выгнали из этой комнаты. Подождите 30 секунд.');
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
            const avatar = userDoc.data().avatar || null;

            // Обновляем текущую комнату пользователя
            await db.collection('users').doc(user.uid).update({
                currentRoom: currentRoom,
                online: true,
                lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            });

            // Check if user already exists in participants
            const existingParticipant = await db.collection('rooms').doc(currentRoom)
                .collection('participants').doc(user.uid).get();
            
            if (existingParticipant.exists) {
                await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).update({
                    online: true,
                    lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
                    isHost: isHost,
                    muted: false,
                    displayName: displayName,
                    avatar: avatar
                });
            } else {
                await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).set({
                    userId: user.uid,
                    displayName: displayName,
                    avatar: avatar,
                    joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    isHost: isHost,
                    online: true,
                    lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
                    muted: false,
                    camera: false,
                    screen: false
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
                message: displayName + ' присоединился к комнате',
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

        kickedListener = db.collection('rooms').doc(currentRoom)
            .collection('participants').doc(currentUser.uid)
            .onSnapshot(function(doc) {
                if (!doc.exists && currentRoom && !leaveInProgress && !wasKicked) {
                    console.log('You have been kicked from the room');
                    
                    wasKicked = true;
                    
                    if (roomCode) {
                        localStorage.setItem('kicked_' + currentUser.uid + '_' + roomCode, Date.now().toString());
                    }
                    
                    window.auth.showError('❌ Вас выгнали из комнаты');
                    
                    forceLeave();
                }
            }, function(error) {
                console.error('Kick listener error:', error);
            });
    }

    // Force leave
    function forceLeave() {
        console.log('Force leaving room due to kick');
        
        leaveInProgress = true;
        
        stopAllListeners();
        
        if (window.peer && typeof window.peer.cleanup === 'function') {
            window.peer.cleanup();
        }

        // Обновляем статус пользователя
        if (currentUser) {
            db.collection('users').doc(currentUser.uid).update({
                currentRoom: null,
                lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            }).catch(console.error);
        }

        // Скрываем видео
        if (localVideoContainer) localVideoContainer.classList.add('hidden');
        if (localScreenContainer) localScreenContainer.classList.add('hidden');

        if (participantsContainer) participantsContainer.innerHTML = '';
        if (chatMessages) chatMessages.innerHTML = '';
        
        enlargedVideo = null;
        
        currentRoom = null;
        roomCode = null;
        isHost = false;
        leaveInProgress = false;
        wasKicked = false;

        if (roomContainer) roomContainer.classList.remove('hidden');
        if (activeRoomContainer) activeRoomContainer.classList.add('hidden');
        if (roomCodeInput) roomCodeInput.value = '';
    }

    function stopAllListeners() {
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

        window.removeEventListener('beforeunload', handleBeforeUnload);
        window.removeEventListener('pagehide', handlePageHide);

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

    // Heartbeat
    function startHeartbeat() {
        const user = firebase.auth().currentUser;
        if (!user || !currentRoom) return;

        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }

        heartbeatInterval = setInterval(async function() {
            if (currentRoom && user && window.navigator.onLine && !leaveInProgress && !wasKicked) {
                try {
                    await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).update({
                        online: true,
                        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
                    });
                    
                    // Также обновляем статус в users
                    await db.collection('users').doc(user.uid).update({
                        online: true,
                        lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
                        currentRoom: currentRoom
                    });
                    
                    console.log('Heartbeat sent');
                } catch (error) {
                    console.error('Error sending heartbeat:', error);
                }
            }
        }, 3000);

        window.addEventListener('beforeunload', handleBeforeUnload);
        window.addEventListener('pagehide', handlePageHide);
    }

    function handleBeforeUnload() {
        immediateLeave();
    }

    function handlePageHide() {
        immediateLeave();
    }

    function immediateLeave() {
        const user = firebase.auth().currentUser;
        if (currentRoom && user && !leaveInProgress && !wasKicked) {
            leaveInProgress = true;
            
            // Обновляем статус в users
            db.collection('users').doc(user.uid).update({
                currentRoom: null,
                lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            }).catch(console.error);
            
            const url = 'https://firestore.googleapis.com/v1/projects/' + firebase.app().options.projectId + '/databases/(default)/documents/rooms/' + currentRoom + '/participants/' + user.uid;
            
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
            
            leaveRoom().catch(console.error);
        }
    }

    function startConnectionChecker() {
        if (connectionCheckInterval) {
            clearInterval(connectionCheckInterval);
        }

        connectionCheckInterval = setInterval(function() {
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
            .onSnapshot(function(doc) {
                if (!doc.exists && !leaveInProgress && !wasKicked) {
                    console.log('Room deleted');
                    window.auth.showError('Комната была удалена');
                    forceLeave();
                }
            }, function(error) {
                console.error('Room listener error:', error);
            });
    }

    function listenToParticipants() {
        if (!currentRoom) return;
        if (participantsListener) participantsListener();

        participantsListener = db.collection('rooms').doc(currentRoom)
            .collect
