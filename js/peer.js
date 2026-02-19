// Native WebRTC Peer Module with Screen Sharing, Camera and Encryption
window.peer = (function() {
    let localStream = null;
    let screenStream = null;
    let cameraStream = null;
    let peerConnections = new Map();
    let remoteAudioElements = new Map();
    let remoteVideoElements = new Map();
    let remoteScreenElements = new Map();
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
                if (localVideo) localVideo.style.display = 'none';
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
                    localVideo.style.display = 'block';
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
                if (localScreen) localScreen.style.display = 'none';
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
                    localScreen.style.display = 'block';
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
            await db.collection('rooms').doc(currentRoom)
                .collection('signals')
                .add({
                    from: userId,
                    target: targetUserId,
                    type: type,
                    data: data,
                    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                    encrypted: true // Помечаем как зашифрованное
                });
        } catch (error) {
            console.error('Error sending signal:', error);
        }
    }

    // Рассылка сигнала всем участникам
    async function broadcastSignal(type, data) {
        try {
            await db.collection('rooms').doc(currentRoom)
                .collection('broadcasts')
                .add({
                    from: userId,
                    type: type,
                    data: data,
                    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
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
        db.collection('rooms').doc(currentRoom)
            .collection('signaling')
            .where('target', '==', userId)
            .onSnapshot(function(snapshot) {
                snapshot.docChanges().forEach(function(change) {
                    if (change.type === 'added') {
                        const data = change.doc.data();
                        handleSignal(data);
                        change.doc.ref.delete().catch(console.error);
                    }
                });
            });

        // Listen for ICE candidates
        db.collection('rooms').doc(currentRoom)
            .collection('iceCandidates')
            .where('target', '==', userId)
            .onSnapshot(function(snapshot) {
                snapshot.docChanges().forEach(function(change) {
                    if (change.type === 'added') {
                        const data = change.doc.data();
                        handleIceCandidate(data);
                        change.doc.ref.delete().catch(console.error);
                    }
                });
            });

        // Listen for broadcast signals (camera/screen status)
        db.collection('rooms').doc(currentRoom)
            .collection('broadcasts')
            .where('timestamp', '>', new Date(Date.now() - 5000))
            .onSnapshot(function(snapshot) {
                snapshot.docChanges().forEach(function(change) {
                    if (change.type === 'added') {
                        const data = change.doc.data();
                        if (data.from !== userId) {
                            handleBroadcast(data);
                        }
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
            const cameraIcon = card.querySelector('.camera-icon');
            if (cameraIcon) {
                cameraIcon.textContent = enabled ? '📷' : '';
            }
        }
    }

    // Update participant screen share status in UI
    function updateParticipantScreen(participantId, enabled) {
        const card = document.getElementById('participant-' + participantId);
        if (card) {
            const screenIcon = card.querySelector('.screen-icon');
            if (screenIcon) {
                screenIcon.textContent = enabled ? '🖥️' : '';
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
                        console.error('Error sending ICE candidate:', err);
                    });
            }
        };

        // Handle connection state
        pc.onconnectionstatechange = function() {
            console.log('Connection state to', targetUserId, ':', pc.connectionState);
            if (pc.connectionState === 'connected') {
                console.log('Successfully connected to:', targetUserId);
                window.auth.showSuccess('Подключен к участнику');
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                console.log('Connection lost to:', targetUserId);
            }
        };

        // Handle ICE connection state
        pc.oniceconnectionstatechange = function() {
            console.log('ICE connection state to', targetUserId, ':', pc.iceConnectionState);
        };

        // Handle remote stream
        pc.ontrack = function(event) {
            console.log('Received remote stream from:', targetUserId);
            console.log('Stream tracks:', event.streams[0].getTracks().length);
            
            // Определяем тип потока (аудио, видео, экран)
            const hasVideo = event.streams[0].getVideoTracks().length > 0;
            const isScreen = event.track && event.track.kind === 'video' && 
                            event.track.label && event.track.label.includes('screen');
            
            if (!hasVideo) {
                // Только аудио
                addRemoteAudio(targetUserId, event.streams[0]);
            } else if (isScreen) {
                // Демонстрация экрана
                addRemoteScreen(targetUserId, event.streams[0]);
            } else {
                // Видео с камеры
                addRemoteVideo(targetUserId, event.streams[0]);
            }
        };

        // Store connection
        peerConnections.set(targetUserId, { pc: pc });

        return pc;
    }

    // Add remote audio
    function addRemoteAudio(userId, stream) {
        // Remove existing audio if any
        const oldAudio = remoteAudioElements.get(userId);
        if (oldAudio) {
            oldAudio.remove();
        }

        const audio = document.createElement('audio');
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.id = 'audio-' + userId;
        audio.style.display = 'none';
        document.body.appendChild(audio);
        
        // Устанавливаем громкость из настроек
        const userSettings = window.auth?.getUserSettings?.();
        if (userSettings) {
            audio.volume = userSettings.speakerVolume / 100;
        }

        remoteAudioElements.set(userId, audio);
        
        audio.play().catch(function(e) { 
            console.log('Audio play error:', e);
        });
        
        console.log('Remote audio added for user:', userId);
    }

    // Add remote video
    function addRemoteVideo(userId, stream) {
        // Check if video container exists
        let videoContainer = document.getElementById('remote-videos');
        if (!videoContainer) {
            videoContainer = document.createElement('div');
            videoContainer.id = 'remote-videos';
            videoContainer.className = 'remote-videos-grid';
            document.querySelector('.participants-grid').after(videoContainer);
        }
        
        // Remove existing video if any
        const oldVideo = remoteVideoElements.get(userId);
        if (oldVideo) {
            oldVideo.remove();
        }

        const videoWrapper = document.createElement('div');
        videoWrapper.className = 'remote-video-wrapper';
        videoWrapper.id = 'video-wrapper-' + userId;
        
        const video = document.createElement('video');
        video.srcObject = stream;
        video.autoplay = true;
        video.playsInline = true;
        video.className = 'remote-video';
        
        const label = document.createElement('div');
        label.className = 'video-label';
        label.textContent = getUserDisplayName(userId) + ' (камера)';
        
        videoWrapper.appendChild(video);
        videoWrapper.appendChild(label);
        videoContainer.appendChild(videoWrapper);

        remoteVideoElements.set(userId, videoWrapper);
        
        console.log('Remote video added for user:', userId);
    }

    // Add remote screen
    function addRemoteScreen(userId, stream) {
        // Check if screen container exists
        let screenContainer = document.getElementById('remote-screens');
        if (!screenContainer) {
            screenContainer = document.createElement('div');
            screenContainer.id = 'remote-screens';
            screenContainer.className = 'remote-screens-grid';
            document.querySelector('.participants-grid').after(screenContainer);
        }
        
        // Remove existing screen if any
        const oldScreen = remoteScreenElements.get(userId);
        if (oldScreen) {
            oldScreen.remove();
        }

        const screenWrapper = document.createElement('div');
        screenWrapper.className = 'remote-screen-wrapper';
        screenWrapper.id = 'screen-wrapper-' + userId;
        
        const video = document.createElement('video');
        video.srcObject = stream;
        video.autoplay = true;
        video.playsInline = true;
        video.className = 'remote-screen';
        
        const label = document.createElement('div');
        label.className = 'screen-label';
        label.textContent = getUserDisplayName(userId) + ' (экран)';
        
        screenWrapper.appendChild(video);
        screenWrapper.appendChild(label);
        screenContainer.appendChild(screenWrapper);

        remoteScreenElements.set(userId, screenWrapper);
        
        console.log('Remote screen added for user:', userId);
    }

    // Get user display name by ID
    function getUserDisplayName(userId) {
        // Пытаемся получить из UI
        const card = document.getElementById('participant-' + userId);
        if (card) {
            const nameDiv = card.querySelector('.participant-name');
            if (nameDiv) {
                return nameDiv.textContent.replace('👑', '').replace('(Вы)', '').trim();
            }
        }
        return 'Участник';
    }

    // Handle offer
    async function handleOffer(fromUserId, offerObj) {
        if (!currentRoom || !userId) {
            console.log('No room or user, ignoring offer');
            return;
        }
        
        console.log('Handling offer from:', fromUserId);
        
        try {
            const pc = createPeerConnection(fromUserId);
            
            await pc.setRemoteDescription(new RTCSessionDescription(offerObj));
            console.log('Remote description set from offer');
            
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            console.log('Local description set as answer');
            
            // Send answer
            await db.collection('rooms').doc(currentRoom)
                .collection('signaling')
                .add({
                    from: userId,
                    target: fromUserId,
                    type: 'answer',
                    answer: {
                        type: answer.type,
                        sdp: answer.sdp
                    },
                    timestamp: firebase.firestore.FieldValue.serverTimestamp()
                });
            
            console.log('Answer sent to:', fromUserId);
            
            // Add pending candidates
            const candidates = pendingCandidates.get(fromUserId);
            if (candidates) {
                for (const candidate of candidates) {
                    await pc.addIceCandidate(candidate);
                }
                pendingCandidates.delete(fromUserId);
                console.log('Added pending ICE candidates');
            }
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    }

    // Handle answer
    async function handleAnswer(fromUserId, answerObj) {
        console.log('Handling answer from:', fromUserId);
        
        try {
            const peerConnection = peerConnections.get(fromUserId);
            if (!peerConnection || !peerConnection.pc) {
                console.error('No peer connection for:', fromUserId);
                return;
            }
            
            await peerConnection.pc.setRemoteDescription(new RTCSessionDescription(answerObj));
            console.log('Remote description set from answer');
            
            const candidates = pendingCandidates.get(fromUserId);
            if (candidates) {
                for (const candidate of candidates) {
                    await peerConnection.pc.addIceCandidate(candidate);
                }
                pendingCandidates.delete(fromUserId);
                console.log('Added pending ICE candidates');
            }
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }

    // Connect to peer
    async function connectToPeer(targetUserId) {
        if (!currentRoom || !userId || targetUserId === userId) {
            console.log('Cannot connect to self or invalid room');
            return;
        }

        if (peerConnections.has(targetUserId)) {
            console.log('Already have connection to:', targetUserId);
            return;
        }

        console.log('Initiating connection to:', targetUserId);

        try {
            const pc = createPeerConnection(targetUserId);
            
            const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            
            await pc.setLocalDescription(offer);
            console.log('Local description set as offer');
            
            // Send offer
            await db.collection('rooms').doc(currentRoom)
                .collection('signaling')
                .add({
                    from: userId,
                    target: targetUserId,
                    type: 'offer',
                    offer: {
                        type: offer.type,
                        sdp: offer.sdp
                    },
                    timestamp: firebase.firestore.FieldValue.serverTimestamp()
                });
            
            console.log('Offer sent to:', targetUserId);
        } catch (error) {
            console.error('Error connecting to peer:', error);
        }
    }

    // Update mic button state
    function updateMicButton() {
        if (micToggleButton) {
            micToggleButton.textContent = micEnabled ? '🎤 Микрофон вкл' : '🔇 Микрофон выкл';
            micToggleButton.classList.toggle('muted', !micEnabled);
        }
    }

    // Toggle microphone
    function toggleMic() {
        if (!localStream) return;

        micEnabled = !micEnabled;
        if (localStream.getAudioTracks().length > 0) {
            localStream.getAudioTracks()[0].enabled = micEnabled;
        }
        updateMicButton();

        if (currentRoom && userId) {
            db.collection('rooms').doc(currentRoom).collection('participants')
                .doc(userId)
                .update({ 
                    muted: !micEnabled,
                    lastSeen: firebase.firestore.FieldValue.serverTimestamp()
                })
                .catch(console.error);
        }
    }

    // Send message
    function sendMessage() {
        const message = chatInput.value.trim();
        if (!message) return;

        addMessage(userName, message, true);

        if (currentRoom && userId) {
            db.collection('rooms').doc(currentRoom).collection('messages').add({
                senderId: userId,
                senderName: userName,
                message: message,
                timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                encrypted: true
            }).catch(console.error);
        }

        chatInput.value = '';
    }

    function addMessage(sender, message, isOwn) {
        if (!chatMessages) return;
        
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message';
        if (isOwn) {
            messageDiv.classList.add('own-message');
        }
        messageDiv.innerHTML = '<span class="message-sender">' + sender + ':</span> <span class="message-text">' + message + '</span>';
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        
        // Воспроизводим звук уведомления если не свое сообщение
        if (!isOwn) {
            playNotificationSound();
        }
    }

    function playNotificationSound() {
        const userSettings = window.auth?.getUserSettings?.();
        if (userSettings && userSettings.notifyMessages) {
            // Здесь можно добавить звук уведомления
            console.log('New message notification');
        }
    }

    function setCurrentRoom(roomId) {
        currentRoom = roomId;
        if (userId) {
            listenForSignaling();
        }
    }

    function closeConnection(userId) {
        const connection = peerConnections.get(userId);
        if (connection && connection.pc) {
            connection.pc.close();
            peerConnections.delete(userId);
        }
        
        const audio = remoteAudioElements.get(userId);
        if (audio) {
            audio.pause();
            audio.srcObject = null;
            audio.remove();
            remoteAudioElements.delete(userId);
        }
        
        const video = remoteVideoElements.get(userId);
        if (video) {
            video.remove();
            remoteVideoElements.delete(userId);
        }
        
        const screen = remoteScreenElements.get(userId);
        if (screen) {
            screen.remove();
            remoteScreenElements.delete(userId);
        }
        
        console.log('Closed connection to user:', userId);
    }

    function cleanup() {
        console.log('Cleaning up WebRTC connections');
        
        peerConnections.forEach(function(connection, userId) {
            if (connection.pc) {
                connection.pc.close();
            }
        });
        peerConnections.clear();
        
        remoteAudioElements.forEach(function(audio, userId) {
            audio.pause();
            audio.srcObject = null;
            audio.remove();
        });
        remoteAudioElements.clear();
        
        remoteVideoElements.forEach(function(video, userId) {
            video.remove();
        });
        remoteVideoElements.clear();
        
        remoteScreenElements.forEach(function(screen, userId) {
            screen.remove();
        });
        remoteScreenElements.clear();
        
        if (localStream) {
            localStream.getTracks().forEach(function(track) {
                track.stop();
            });
            localStream = null;
        }
        
        if (cameraStream) {
            cameraStream.getTracks().forEach(function(track) {
                track.stop();
            });
            cameraStream = null;
        }
        
        if (screenStream) {
            screenStream.getTracks().forEach(function(track) {
                track.stop();
            });
            screenStream = null;
        }
        
        if (audioContext) {
            audioContext.close();
            audioContext = null;
        }
        
        micGainNode = null;
        pendingCandidates.clear();
        currentRoom = null;
        userId = null;
        cameraEnabled = false;
        screenSharing = false;
    }

    // Public API
    return {
        init: init,
        connectToPeer: connectToPeer,
        toggleMic: toggleMic,
        toggleCamera: toggleCamera,
        toggleScreenShare: toggleScreenShare,
        sendMessage: sendMessage,
        addMessage: addMessage,
        setCurrentRoom: setCurrentRoom,
        closeConnection: closeConnection,
        cleanup: cleanup,
        setVolume: setVolume,
        isMicEnabled: function() { return micEnabled; },
        isCameraEnabled: function() { return cameraEnabled; },
        isScreenSharing: function() { return screenSharing; }
    };
})();
