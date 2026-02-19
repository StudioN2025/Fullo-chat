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
        
        // Удаляем контейнеры с видео
        const remoteVideos = document.getElementById('remoteVideosContainer');
        const remoteScreens = document.getElementById('remoteScreensContainer');
        if (remoteVideos) remoteVideos.innerHTML = '';
        if (remoteScreens) remoteScreens.innerHTML = '';
        
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
            .collection('participants')
            .onSnapshot(function(snapshot) {
                if (leaveInProgress || wasKicked) return;
                
                const now = Date.now();
                const currentUserId = firebase.auth().currentUser?.uid;
                
                const onlineParticipants = snapshot.docs.filter(function(doc) {
                    const data = doc.data();
                    
                    if (doc.id === currentUserId) {
                        return true;
                    }
                    
                    if (!data.online) return false;
                    
                    if (data.lastSeen) {
                        const lastSeen = data.lastSeen.toDate ? data.lastSeen.toDate() : new Date(data.lastSeen);
                        const diff = now - lastSeen.getTime();
                        return diff < 7000;
                    }
                    return false;
                });

                if (participantsCount) participantsCount.textContent = onlineParticipants.length;

                const otherParticipants = onlineParticipants.filter(function(p) { return p.id !== currentUserId; });
                checkEmptyRoom(otherParticipants);

                const onlineIds = new Set(onlineParticipants.map(function(doc) { return doc.id; }));
                
                document.querySelectorAll('.participant-card').forEach(function(card) {
                    const cardId = card.id.replace('participant-', '');
                    if (!onlineIds.has(cardId) && cardId !== currentUserId) {
                        removeParticipantFromUI(cardId);
                    }
                });

                onlineParticipants.forEach(function(doc) {
                    const data = doc.data();
                    const card = document.getElementById('participant-' + doc.id);
                    
                    if (card) {
                        updateParticipantInUI(doc.id, data);
                    } else {
                        addParticipantToUI(doc.id, data);
                    }
                });

                onlineParticipants.forEach(function(doc) {
                    if (doc.id !== currentUserId) {
                        setTimeout(function() {
                            window.peer.connectToPeer(doc.id);
                        }, 1000);
                    }
                });
            }, function(error) {
                console.error('Participants listener error:', error);
            });
    }

    function checkEmptyRoom(otherParticipants) {
        if (roomCheckTimeout) {
            clearTimeout(roomCheckTimeout);
        }

        if (otherParticipants.length === 0) {
            console.log('Room has no other participants, scheduling deletion in 7 seconds');
            roomCheckTimeout = setTimeout(async function() {
                if (currentRoom) {
                    try {
                        const checkSnapshot = await db.collection('rooms').doc(currentRoom)
                            .collection('participants')
                            .get();
                        
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
            }, 7000);
        }
    }

    function listenToMessages() {
        if (!currentRoom) return;
        if (messagesListener) messagesListener();

        messagesListener = db.collection('rooms').doc(currentRoom)
            .collection('messages')
            .orderBy('timestamp', 'asc')
            .onSnapshot(function(snapshot) {
                if (leaveInProgress || wasKicked) return;
                
                snapshot.docChanges().forEach(function(change) {
                    if (change.type === 'added') {
                        const data = change.doc.data();
                        
                        if (data.type === 'kick' && data.targetUserId === currentUser?.uid) {
                            console.log('Kick message received');
                            forceLeave();
                        } else if (data.type === 'room_deleted') {
                            console.log('Room deleted message received');
                            forceLeave();
                        } else if (data.senderId !== firebase.auth().currentUser?.uid) {
                            window.peer.addMessage(data.senderName, data.message);
                        }
                    }
                });
            }, function(error) {
                console.error('Messages listener error:', error);
            });
    }

    function addParticipantToUI(userId, data) {
        if (!participantsContainer) return;
        
        // Check if already exists
        if (document.getElementById('participant-' + userId)) return;

        const card = document.createElement('div');
        card.className = 'participant-card';
        card.id = 'participant-' + userId;
        
        const isCurrentUser = userId === firebase.auth().currentUser?.uid;
        const hostBadge = data.isHost ? ' 👑' : '';
        const mutedIcon = data.muted ? ' 🔇' : '';
        const cameraIcon = data.camera ? ' 📷' : '';
        const screenIcon = data.screen ? ' 🖥️' : '';
        
        // Add special class for current user
        if (isCurrentUser) {
            card.classList.add('current-user');
        }
        
        // Аватарка (если есть)
        let avatarHtml = '';
        if (data.avatar) {
            avatarHtml = '<div class="participant-avatar" style="background-image: url(\'' + data.avatar + '\')"></div>';
        } else {
            const firstLetter = data.displayName ? data.displayName.charAt(0).toUpperCase() : '?';
            avatarHtml = '<div class="participant-avatar default-avatar">' + firstLetter + '</div>';
        }
        
        let controls = '';
        if (isHost && !isCurrentUser && data.isHost === false) {
            controls = '<div class="participant-controls">' +
                '<button class="mute-btn" onclick="window.room.' + (data.muted ? 'unmuteParticipant' : 'muteParticipant') + '(\'' + userId + '\')">' +
                    (data.muted ? '🔊 Включить звук' : '🔇 Заглушить') +
                '</button>' +
                '<button class="kick-btn" onclick="if(confirm(\'Вы уверены, что хотите выгнать этого участника?\')) window.room.kickParticipant(\'' + userId + '\')">' +
                    '👢 Выгнать' +
                '</button>' +
            '</div>';
        }
        
        card.innerHTML = 
            '<div class="participant-header">' +
                avatarHtml +
                '<div class="participant-name-container">' +
                    '<div class="participant-name">' +
                        (data.displayName || 'Unknown') + hostBadge +
                        (isCurrentUser ? '<span class="current-user-badge">(Вы)</span>' : '') +
                    '</div>' +
                    '<div class="participant-status">' +
                        '🟢 В сети' + mutedIcon + cameraIcon + screenIcon +
                    '</div>' +
                '</div>' +
            '</div>' +
            controls;

        participantsContainer.appendChild(card);
    }

    function updateParticipantInUI(userId, data) {
        const card = document.getElementById('participant-' + userId);
        if (card) {
            // Обновляем статус
            const statusDiv = card.querySelector('.participant-status');
            if (statusDiv) {
                const mutedIcon = data.muted ? ' 🔇' : '';
                const cameraIcon = data.camera ? ' 📷' : '';
                const screenIcon = data.screen ? ' 🖥️' : '';
                statusDiv.innerHTML = '🟢 В сети' + mutedIcon + cameraIcon + screenIcon;
            }
            
            // Обновляем аватар если изменился
            const avatarDiv = card.querySelector('.participant-avatar');
            if (avatarDiv) {
                if (data.avatar) {
                    avatarDiv.style.backgroundImage = 'url(\'' + data.avatar + '\')';
                    avatarDiv.classList.remove('default-avatar');
                    avatarDiv.textContent = '';
                } else {
                    avatarDiv.style.backgroundImage = '';
                    avatarDiv.classList.add('default-avatar');
                    const firstLetter = data.displayName ? data.displayName.charAt(0).toUpperCase() : '?';
                    avatarDiv.textContent = firstLetter;
                }
            }
            
            // Обновляем имя
            const nameDiv = card.querySelector('.participant-name');
            if (nameDiv) {
                const hostBadge = data.isHost ? ' 👑' : '';
                const isCurrentUser = userId === firebase.auth().currentUser?.uid;
                nameDiv.innerHTML = (data.displayName || 'Unknown') + hostBadge +
                    (isCurrentUser ? '<span class="current-user-badge">(Вы)</span>' : '');
            }
            
            // Update mute button if exists
            const muteBtn = card.querySelector('.mute-btn');
            if (muteBtn && isHost) {
                muteBtn.textContent = data.muted ? '🔊 Включить звук' : '🔇 Заглушить';
                muteBtn.setAttribute('onclick', 'window.room.' + (data.muted ? 'unmuteParticipant' : 'muteParticipant') + '(\'' + userId + '\')');
            }
        }
    }

    function removeParticipantFromUI(userId) {
        const card = document.getElementById('participant-' + userId);
        if (card) {
            console.log('Removing participant from UI:', userId);
            card.remove();
        }
    }

    function copyRoomCode() {
        if (!roomCode) return;
        navigator.clipboard.writeText(roomCode)
            .then(function() { window.auth.showSuccess('Код скопирован!'); })
            .catch(function() { window.auth.showError('Ошибка копирования'); });
    }

    async function leaveRoom() {
        if (leaveInProgress || wasKicked) return;
        leaveInProgress = true;
        
        const user = firebase.auth().currentUser;
        console.log('Leaving room:', currentRoom, 'user:', user?.uid);
        
        if (currentRoom && user) {
            try {
                // Обновляем статус в users
                await db.collection('users').doc(user.uid).update({
                    currentRoom: null,
                    lastSeen: firebase.firestore.FieldValue.serverTimestamp()
                });

                const userDoc = await db.collection('users').doc(user.uid).get();
                const displayName = userDoc.exists ? userDoc.data().displayName : 'Пользователь';
                
                await db.collection('rooms').doc(currentRoom).collection('messages').add({
                    senderId: 'system',
                    senderName: '🔔 Система',
                    message: displayName + ' покинул комнату',
                    type: 'leave',
                    timestamp: firebase.firestore.FieldValue.serverTimestamp()
                });

                await db.collection('rooms').doc(currentRoom).collection('participants').doc(user.uid).update({
                    online: false,
                    leftAt: firebase.firestore.FieldValue.serverTimestamp()
                });

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

        // Скрываем видео
        if (localVideoContainer) localVideoContainer.classList.add('hidden');
        if (localScreenContainer) localScreenContainer.classList.add('hidden');

        if (participantsContainer) participantsContainer.innerHTML = '';
        if (chatMessages) chatMessages.innerHTML = '';
        
        // Удаляем контейнеры с видео
        const remoteVideos = document.getElementById('remoteVideosContainer');
        const remoteScreens = document.getElementById('remoteScreensContainer');
        if (remoteVideos) remoteVideos.innerHTML = '';
        if (remoteScreens) remoteScreens.innerHTML = '';
        
        currentRoom = null;
        roomCode = null;
        isHost = false;
        leaveInProgress = false;

        if (roomContainer) roomContainer.classList.remove('hidden');
        if (activeRoomContainer) activeRoomContainer.classList.add('hidden');
        
        window.auth.showSuccess('Вы покинули комнату');
        if (roomCodeInput) roomCodeInput.value = '';
    }

    // Mute participant (host only)
    async function muteParticipant(userId) {
        if (!isHost || !currentRoom) return;
        try {
            await db.collection('rooms').doc(currentRoom).collection('participants').doc(userId).update({
                muted: true
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
            setTimeout(function() {
                window.peer.connectToPeer(userId);
            }, 1000);
        } catch (error) {
            console.error('Error unmuting participant:', error);
        }
    }

    // Kick participant (host only)
    async function kickParticipant(userId) {
        if (!isHost || !currentRoom || userId === currentUser?.uid) return;
        
        try {
            const participantDoc = await db.collection('rooms').doc(currentRoom)
                .collection('participants').doc(userId).get();
            const participantName = participantDoc.exists ? participantDoc.data().displayName : 'Участник';

            if (window.peer && typeof window.peer.closeConnection === 'function') {
                window.peer.closeConnection(userId);
            }

            await db.collection('rooms').doc(currentRoom).collection('participants').doc(userId).delete();
            await db.collection('rooms').doc(currentRoom).update({
                participants: firebase.firestore.FieldValue.arrayRemove(userId)
            });

            // Также обновляем статус в users
            await db.collection('users').doc(userId).update({
                currentRoom: null,
                lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            });

            await db.collection('rooms').doc(currentRoom).collection('messages').add({
                senderId: 'system',
                senderName: '👑 Система',
                message: participantName + ' был удален из комнаты',
                type: 'kick',
                targetUserId: userId,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });
            
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
            await db.collection('rooms').doc(currentRoom).collection('messages').add({
                senderId: 'system',
                senderName: '👑 Система',
                message: 'Комната была удалена создателем',
                type: 'room_deleted',
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });

            if (window.peer && typeof window.peer.cleanup === 'function') {
                window.peer.cleanup();
            }

            // Get all participants to update their status
            const participantsSnapshot = await db.collection('rooms').doc(currentRoom).collection('participants').get();
            const batch = db.batch();
            
            // Update each participant's user document
            participantsSnapshot.docs.forEach(function(participantDoc) {
                batch.update(db.collection('users').doc(participantDoc.id), {
                    currentRoom: null,
                    lastSeen: firebase.firestore.FieldValue.serverTimestamp()
                });
            });

            // Delete messages
            const messagesSnapshot = await db.collection('rooms').doc(currentRoom).collection('messages').get();
            messagesSnapshot.docs.forEach(function(doc) { batch.delete(doc.ref); });
            
            // Delete participants
            participantsSnapshot.docs.forEach(function(doc) { batch.delete(doc.ref); });
            
            // Delete signaling data
            const signalingSnapshot = await db.collection('rooms').doc(currentRoom).collection('signaling').get();
            signalingSnapshot.docs.forEach(function(doc) { batch.delete(doc.ref); });
            
            // Delete ICE candidates
            const iceSnapshot = await db.collection('rooms').doc(currentRoom).collection('iceCandidates').get();
            iceSnapshot.docs.forEach(function(doc) { batch.delete(doc.ref); });
            
            // Delete broadcasts
            const broadcastsSnapshot = await db.collection('rooms').doc(currentRoom).collection('broadcasts').get();
            broadcastsSnapshot.docs.forEach(function(doc) { batch.delete(doc.ref); });
            
            // Delete the room
            batch.delete(db.collection('rooms').doc(currentRoom));
            
            await batch.commit();
            
            window.auth.showSuccess('Комната удалена');
            forceLeave();
        } catch (error) {
            console.error('Error deleting room:', error);
            window.auth.showError('Ошибка при удалении комнаты');
        }
    }

    // Public API
    return {
        createRoom: createRoom,
        joinRoom: joinRoom,
        leaveRoom: leaveRoom,
        copyRoomCode: copyRoomCode,
        muteParticipant: muteParticipant,
        unmuteParticipant: unmuteParticipant,
        kickParticipant: kickParticipant,
        deleteRoom: deleteRoom,
        getCurrentRoom: function() { return currentRoom; },
        getRoomCode: function() { return roomCode; },
        isCurrentUserHost: function() { return isHost; }
    };
})();
