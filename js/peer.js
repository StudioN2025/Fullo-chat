// Native WebRTC Peer Module with Screen Sharing, Camera and Encryption
window.peer = (function() {
    let localStream = null;
    let screenStream = null;
    let cameraStream = null;
    let peerConnections = new Map();
    let remoteAudioElements = new Map();
    let micEnabled = true;
    let cameraEnabled = false;
    let screenSharing = false;
    let currentRoom = null;
    let userName = '';
    let userId = null;
    let pendingCandidates = new Map();
    let micGainNode = null;
    let audioContext = null;
    
    // DOM Elements
    const micToggleButton = document.getElementById('micToggleButton');
    const cameraToggleButton = document.getElementById('cameraToggleButton');
    const screenShareButton = document.getElementById('screenShareButton');
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput');
    const localVideo = document.getElementById('localVideo');
    const localScreen = document.getElementById('localScreen');

    // Configuration
    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ],
        iceCandidatePoolSize: 10
    };

    // Initialize
    async function init(uid, displayName) {
        userId = uid;
        userName = displayName;
        
        console.log('Initializing WebRTC for user:', userId);
        
        try {
            // Создаем AudioContext для управления громкостью
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            
            // Получаем доступ только к аудио (микрофон)
            localStream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }, 
                video: false 
            });
            
            // Создаем узел усиления для микрофона
            const source = audioContext.createMediaStreamSource(localStream);
            micGainNode = audioContext.createGain();
            source.connect(micGainNode);
            
            // Создаем новый поток с усилением
            const destination = audioContext.createMediaStreamDestination();
            micGainNode.connect(destination);
            
            // Заменяем оригинальный поток на обработанный
            localStream = destination.stream;
            
            console.log('Microphone access granted');
            updateMicButton();
            
            // Загружаем настройки громкости
            const userSettings = window.auth?.getUserSettings?.();
            if (userSettings) {
                setVolume(userSettings.micVolume / 100, userSettings.speakerVolume / 100);
            }
            
            listenForSignaling();
            
            return userId;
        } catch (error) {
            console.error('Error accessing microphone:', error);
            window.auth.showError('Ошибка доступа к микрофону: ' + error.message);
            return null;
        }
    }

    // Установка громкости
    function setVolume(micVolume, speakerVolume) {
        if (micGainNode) {
            micGainNode.gain.value = micVolume;
        }
        
        // Устанавливаем громкость для всех удаленных аудио
        remoteAudioElements.forEach(function(audio, userId) {
            audio.volume = speakerVolume;
        });
        
        console.log('Volume set - mic: ' + micVolume + ', speaker: ' + speakerVolume);
    }

    // Включение/выключение камеры
    async function toggleCamera() {
        if (!currentRoom || !userId) {
            window.auth.showError('Сначала войдите в комнату');
            return;
        }

        try {
            if (cameraEnabled) {
                // Выключаем камеру
                if (cameraStream) {
                    cameraStream.getTracks().forEach(function(track) { track.stop(); });
                    cameraStream = null;
                }
                cameraEnabled = false;
                
                // Скрываем локальное видео
                if (localVideo) {
                    localVideo.srcObject = null;
                    localVideoContainer.classList.add('hidden');
                }
                
                // Удаляем видео из своей карточки
                const videoContainer = document.getElementById('video-container-' + userId);
                if (videoContainer) {
                    videoContainer.innerHTML = '';
                }
            } else {
                // Включаем камеру
                cameraStream = await navigator.mediaDevices.getUserMedia({ 
                    video: {
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                        facingMode: 'user'
                    }, 
                    audio: false 
                });
                
                cameraEnabled = true;
                
                // Показываем локальное видео
                if (localVideo) {
                    localVideo.srcObject = cameraStream;
                    localVideoContainer.classList.remove('hidden');
                }
                
                // Добавляем видео в свою карточку
                const videoContainer = document.getElementById('video-container-' + userId);
                if (videoContainer) {
                    videoContainer.innerHTML = '';
                    const video = document.createElement('video');
                    video.srcObject = cameraStream;
                    video.autoplay = true;
                    video.playsInline = true;
                    video.muted = true;
                    video.id = 'video-' + userId;
                    video.className = 'participant-video';
                    videoContainer.appendChild(video);
                }
                
                // Добавляем видео-треки ко всем существующим соединениям
                peerConnections.forEach(function(connection, targetUserId) {
                    if (connection.pc && connection.pc.connectionState === 'connected') {
                        cameraStream.getTracks().forEach(function(track) {
                            connection.pc.addTrack(track, cameraStream);
                        });
                        
                        // Отправляем уведомление о включении камеры
                        sendSignal(targetUserId, 'camera-on', {});
                    }
                });
            }
            
            updateCameraButton();
            
            // Обновляем статус камеры в participants
            await db.collection(AppwriteClient.roomsCollectionId).doc(currentRoom).collection('participants').doc(userId).update({
                camera: cameraEnabled
            });
            
            // Уведомляем всех участников об изменении статуса камеры
            broadcastSignal('camera-status', { enabled: cameraEnabled });
            
        } catch (error) {
            console.error('Error toggling camera:', error);
            window.auth.showError('Ошибка доступа к камере: ' + error.message);
        }
    }

    // Демонстрация экрана
    async function toggleScreenShare() {
        if (!currentRoom || !userId) {
            window.auth.showError('Сначала войдите в комнату');
            return;
        }

        try {
            if (screenSharing) {
                // Выключаем демонстрацию экрана
                if (screenStream) {
                    screenStream.getTracks().forEach(function(track) { track.stop(); });
                    screenStream = null;
                }
                screenSharing = false;
                
                // Скрываем локальный экран
                if (localScreen) {
                    localScreen.srcObject = null;
                    localScreenContainer.classList.add('hidden');
                }
                
                // Удаляем экран из своей карточки
                const screenContainer = document.getElementById('screen-container-' + userId);
                if (screenContainer) {
                    screenContainer.innerHTML = '';
                }
            } else {
                // Включаем демонстрацию экрана
                screenStream = await navigator.mediaDevices.getDisplayMedia({ 
                    video: {
                        cursor: 'always'
                    },
                    audio: true
                });
                
                screenSharing = true;
                
                // Показываем локальный экран
                if (localScreen) {
                    localScreen.srcObject = screenStream;
                    localScreenContainer.classList.remove('hidden');
                }
                
                // Добавляем экран в свою карточку
                const screenContainer = document.getElementById('screen-container-' + userId);
                if (screenContainer) {
                    screenContainer.innerHTML = '';
                    const video = document.createElement('video');
                    video.srcObject = screenStream;
                    video.autoplay = true;
                    video.playsInline = true;
                    video.muted = true;
                    video.id = 'screen-' + userId;
                    video.className = 'participant-screen';
                    screenContainer.appendChild(video);
                }
                
                // Добавляем экранные треки ко всем существующим соединениям
                peerConnections.forEach(function(connection, targetUserId) {
                    if (connection.pc && connection.pc.connectionState === 'connected') {
                        screenStream.getTracks().forEach(function(track) {
                            connection.pc.addTrack(track, screenStream);
                        });
                        
                        // Отправляем уведомление о начале демонстрации
                        sendSignal(targetUserId, 'screen-on', {});
                    }
                });
                
                // Обработчик остановки демонстрации (если пользователь нажал "Остановить")
                screenStream.getVideoTracks()[0].onended = function() {
                    toggleScreenShare();
                };
            }
            
            updateScreenButton();
            
            // Обновляем статус демонстрации в participants
            await db.collection(AppwriteClient.roomsCollectionId).doc(currentRoom).collection('participants').doc(userId).update({
                screen: screenSharing
            });
            
            // Уведомляем всех участников об изменении статуса демонстрации
            broadcastSignal('screen-status', { enabled: screenSharing });
            
        } catch (error) {
            console.error('Error toggling screen share:', error);
            window.auth.showError('Ошибка демонстрации экрана: ' + error.message);
        }
    }

    // Обновление кнопки камеры
    function updateCameraButton() {
        if (cameraToggleButton) {
            cameraToggleButton.textContent = cameraEnabled ? '📷 Камера вкл' : '📷 Камера выкл';
            cameraToggleButton.classList.toggle('active', cameraEnabled);
        }
    }

    // Обновление кнопки демонстрации экрана
    function updateScreenButton() {
        if (screenShareButton) {
            screenShareButton.textContent = screenSharing ? '🖥️ Экран вкл' : '🖥️ Поделиться экраном';
            screenShareButton.classList.toggle('active', screenSharing);
        }
    }

    // Отправка сигнала конкретному участнику
    async function sendSignal(targetUserId, type, data) {
        try {
            await db.collection(AppwriteClient.roomsCollectionId).doc(currentRoom)
                .collection('signals')
                .add({
                    from: userId,
                    target: targetUserId,
                    type: type,
                    data: data,
                    timestamp: new Date().toISOString(),
                    encrypted: true
                });
        } catch (error) {
            console.error('Error sending signal:', error);
        }
    }

    // Рассылка сигнала всем участникам
    async function broadcastSignal(type, data) {
        try {
            await db.collection(AppwriteClient.roomsCollectionId).doc(currentRoom)
                .collection('broadcasts')
                .add({
                    from: userId,
                    type: type,
                    data: data,
                    timestamp: new Date().toISOString(),
                    encrypted: true
                });
        } catch (error) {
            console.error('Error broadcasting signal:', error);
        }
    }

    // Listen for WebRTC signaling
    function listenForSignaling() {
        if (!currentRoom || !userId) return;

        console.log('Listening for WebRTC signaling...');

        // Listen for offers
        db.collection(AppwriteClient.roomsCollectionId).doc(currentRoom)
            .collection('signaling')
            .where('target', '==', userId)
            .onSnapshot(function(snapshot) {
                snapshot.docChanges().forEach(function(change) {
                    if (change.type === 'added') {
                        const data = change.doc.data();
                        handleSignal(data);
                        // Удаляем документ после обработки
                        change.doc.ref.delete().catch(console.error);
                    }
                });
            });

        // Listen for ICE candidates
        db.collection(AppwriteClient.roomsCollectionId).doc(currentRoom)
            .collection('iceCandidates')
            .where('target', '==', userId)
            .onSnapshot(function(snapshot) {
                snapshot.docChanges().forEach(function(change) {
                    if (change.type === 'added') {
                        const data = change.doc.data();
                        handleIceCandidate(data);
                        // Удаляем документ после обработки
                        change.doc.ref.delete().catch(console.error);
                    }
                });
            });

        // Listen for broadcast signals (camera/screen status)
        db.collection(AppwriteClient.roomsCollectionId).doc(currentRoom)
            .collection('broadcasts')
            .where('timestamp', '>', new Date(Date.now() - 5000))
            .onSnapshot(function(snapshot) {
                snapshot.docChanges().forEach(function(change) {
                    if (change.type === 'added') {
                        const data = change.doc.data();
                        if (data.from !== userId) {
                            handleBroadcast(data);
                        }
                        // Удаляем документ после обработки
                        change.doc.ref.delete().catch(console.error);
                    }
                });
            });
    }

    // Handle broadcast signals
    function handleBroadcast(data) {
        console.log('Received broadcast:', data.type, 'from:', data.from);
        
        switch (data.type) {
            case 'camera-status':
                updateParticipantCamera(data.from, data.data.enabled);
                break;
            case 'screen-status':
                updateParticipantScreen(data.from, data.data.enabled);
                break;
        }
    }

    // Update participant camera status in UI
    function updateParticipantCamera(participantId, enabled) {
        const card = document.getElementById('participant-' + participantId);
        if (card) {
            const statusDiv = card.querySelector('.participant-status');
            if (statusDiv) {
                if (enabled) {
                    if (!statusDiv.innerHTML.includes('📷')) {
                        statusDiv.innerHTML += ' 📷';
                    }
                } else {
                    statusDiv.innerHTML = statusDiv.innerHTML.replace(' 📷', '');
                }
            }
        }
    }

    // Update participant screen share status in UI
    function updateParticipantScreen(participantId, enabled) {
        const card = document.getElementById('participant-' + participantId);
        if (card) {
            const statusDiv = card.querySelector('.participant-status');
            if (statusDiv) {
                if (enabled) {
                    if (!statusDiv.innerHTML.includes('🖥️')) {
                        statusDiv.innerHTML += ' 🖥️';
                    }
                } else {
                    statusDiv.innerHTML = statusDiv.innerHTML.replace(' 🖥️', '');
                }
            }
        }
    }

    // Handle signaling messages
    async function handleSignal(data) {
        console.log('Received signal:', data.type, 'from:', data.from);
        
        if (data.type === 'offer') {
            await handleOffer(data.from, data.offer);
        } else if (data.type === 'answer') {
            await handleAnswer(data.from, data.answer);
        }
    }

    // Handle ICE candidates
    async function handleIceCandidate(data) {
        console.log('Received ICE candidate from:', data.from);
        
        try {
            const candidate = new RTCIceCandidate(data.candidate);
            const peerConnection = peerConnections.get(data.from);
            
            if (peerConnection && peerConnection.pc && peerConnection.pc.remoteDescription) {
                await peerConnection.pc.addIceCandidate(candidate);
                console.log('ICE candidate added');
            } else {
                if (!pendingCandidates.has(data.from)) {
                    pendingCandidates.set(data.from, []);
                }
                pendingCandidates.get(data.from).push(candidate);
                console.log('ICE candidate stored for later');
            }
        } catch (error) {
            console.error('Error handling ICE candidate:', error);
        }
    }

    // Create peer connection
    function createPeerConnection(targetUserId) {
        console.log('Creating peer connection to:', targetUserId);
        
        const pc = new RTCPeerConnection(configuration);
        
        // Add local audio stream
        if (localStream) {
            localStream.getTracks().forEach(function(track) {
                pc.addTrack(track, localStream);
                console.log('Added audio track:', track.kind);
            });
        }
        
        // Add camera stream if enabled
        if (cameraStream && cameraEnabled) {
            cameraStream.getTracks().forEach(function(track) {
                pc.addTrack(track, cameraStream);
                console.log('Added video track:', track.kind);
            });
        }
        
        // Add screen stream if enabled
        if (screenStream && screenSharing) {
            screenStream.getTracks().forEach(function(track) {
                pc.addTrack(track, screenStream);
                console.log('Added screen track:', track.kind);
            });
        }

        // Handle ICE candidates
        pc.onicecandidate = function(event) {
            if (event.candidate && currentRoom && userId) {
                console.log('Generated ICE candidate for:', targetUserId);
                db.collection('rooms').doc(currentRoom)
                    .collection('iceCandidates')
                    .add({
                        from: userId,
                        target: targetUserId,
                        candidate: {
                            candidate: event.candidate.candidate,
                            sdpMid: event.candidate.sdpMid,
                            sdpMLineIndex: event.candidate.sdpMLineIndex
                        },
                        timestamp: firebase.firestore.FieldValue.serverTimestamp()
                    }).catch(function(err) { 
                        console.
