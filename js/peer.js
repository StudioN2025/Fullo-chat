// Peer Module for P2P connections
window.peer = (function() {
    let peer = null;
    let myStream = null;
    let micEnabled = true;
    let peerConnections = new Map();
    let participantAudios = new Map();
    let currentRoom = null;
    let userName = '';
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 5;

    // DOM Elements
    const micToggleButton = document.getElementById('micToggleButton');
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput');

    // Initialize Peer with custom configuration
    function init(userId, displayName) {
        userName = displayName;
        
        // Generate random Peer ID
        const peerId = generatePeerId();
        
        // Используем только STUN серверы, без TURN
        // Это позволит работать в локальных сетях и при прямых соединениях
        const peerConfig = {
            config: {
                'iceServers': [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' },
                    { urls: 'stun:stun3.l.google.com:19302' },
                    { urls: 'stun:stun4.l.google.com:19302' },
                    { urls: 'stun:stun.ekiga.net' },
                    { urls: 'stun:stun.ideasip.com' },
                    { urls: 'stun:stun.schlund.de' }
                ]
            },
            debug: 2, // Уровень логирования 0-3
            pingInterval: 5000, // Пинг каждые 5 секунд
            reliable: false // Не использовать надежные соединения для аудио
        };

        try {
            peer = new Peer(peerId, peerConfig);

            peer.on('open', (id) => {
                console.log('PeerJS connected with ID:', id);
                reconnectAttempts = 0;
                
                // Save peer ID to Firestore
                if (currentRoom && userId) {
                    db.collection('rooms').doc(currentRoom).collection('participants').doc(userId).update({
                        peerId: id,
                        online: true,
                        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
                    }).catch(err => console.error('Error updating peer ID:', err));
                }
            });

            peer.on('call', handleIncomingCall);
            
            peer.on('error', (error) => {
                console.error('PeerJS error:', error);
                
                // Не показываем ошибки соединения пользователю, так как они могут быть временными
                if (error.type === 'unavailable-id') {
                    // ID already taken, generate new one and reconnect
                    reconnectWithNewId(userId);
                } else if (error.type === 'network' || error.type === 'disconnected') {
                    // Попытка переподключения
                    attemptReconnect(userId);
                }
            });

            peer.on('disconnected', () => {
                console.log('PeerJS disconnected, attempting to reconnect...');
                attemptReconnect(userId);
            });

            peer.on('close', () => {
                console.log('PeerJS connection closed');
            });

            // Get user media
            navigator.mediaDevices.getUserMedia({ audio: true, video: false })
                .then((stream) => {
                    myStream = stream;
                    console.log('Microphone access granted');
                    updateMicButton();
                })
                .catch((error) => {
                    console.error('Error accessing microphone:', error);
                    window.auth.showError('Ошибка доступа к микрофону: ' + error.message);
                });

            return peerId;
        } catch (error) {
            console.error('Error creating PeerJS instance:', error);
            window.auth.showError('Ошибка создания P2P соединения');
            return null;
        }
    }

    function generatePeerId() {
        // Более короткий ID для стабильности
        return 'user_' + Math.random().toString(36).substr(2, 6);
    }

    function reconnectWithNewId(userId) {
        if (peer && !peer.destroyed) {
            peer.destroy();
        }
        
        const newId = generatePeerId();
        console.log('Reconnecting with new ID:', newId);
        
        // Reinitialize with new ID
        init(userId, userName);
    }

    function attemptReconnect(userId) {
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            console.log(`Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
            
            setTimeout(() => {
                if (peer && !peer.destroyed) {
                    peer.reconnect();
                } else {
                    reconnectWithNewId(userId);
                }
            }, 2000 * reconnectAttempts); // Увеличиваем задержку с каждой попыткой
        } else {
            console.log('Max reconnect attempts reached');
            window.auth.showError('Не удалось подключиться к P2P сети. Проверьте интернет соединение.');
        }
    }

    // Handle incoming call
    function handleIncomingCall(call) {
        if (!myStream) {
            console.error('No local stream available');
            call.close();
            return;
        }

        console.log('Incoming call from:', call.peer);
        
        // Answer the call
        call.answer(myStream);
        
        call.on('stream', (remoteStream) => {
            console.log('Received remote stream from:', call.peer);
            addRemoteAudio(call.peer, remoteStream);
        });

        call.on('close', () => {
            console.log('Call closed with:', call.peer);
            removeRemoteAudio(call.peer);
        });

        call.on('error', (err) => {
            console.error('Call error:', err);
        });

        // Store call
        if (peerConnections.has(call.peer)) {
            peerConnections.get(call.peer).call = call;
        } else {
            peerConnections.set(call.peer, { call });
        }
    }

    // Connect to a peer
    function connectToPeer(peerId, targetUserId) {
        if (!peer || !myStream) {
            console.log('Peer or stream not ready');
            return;
        }

        console.log('Connecting to peer:', peerId);
        
        try {
            // Call the peer
            const call = peer.call(peerId, myStream);
            
            call.on('stream', (remoteStream) => {
                console.log('Connected to peer:', peerId);
                addRemoteAudio(peerId, remoteStream, targetUserId);
            });

            call.on('close', () => {
                console.log('Call closed with peer:', peerId);
                removeRemoteAudio(peerId);
            });

            call.on('error', (err) => {
                console.error('Call error:', err);
            });

            // Store connection
            peerConnections.set(peerId, { call });
        } catch (error) {
            console.error('Error connecting to peer:', error);
        }
    }

    // Add remote audio
    function addRemoteAudio(peerId, stream, userId) {
        // Remove existing audio if any
        removeRemoteAudio(peerId);

        const audio = document.createElement('audio');
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.id = `audio-${peerId}`;
        audio.style.display = 'none'; // Скрываем аудио элемент
        document.body.appendChild(audio);

        participantAudios.set(peerId, audio);
        console.log('Remote audio added for peer:', peerId);
    }

    function removeRemoteAudio(peerId) {
        const audio = participantAudios.get(peerId);
        if (audio) {
            audio.pause();
            audio.srcObject = null;
            audio.remove();
            participantAudios.delete(peerId);
        }
    }

    function updateMicButton() {
        if (micToggleButton) {
            micToggleButton.textContent = micEnabled ? '🎤 Микрофон включен' : '🔇 Микрофон выключен';
            micToggleButton.classList.toggle('muted', !micEnabled);
        }
    }

    // Toggle microphone
    function toggleMic() {
        if (!myStream) return;

        micEnabled = !micEnabled;
        if (myStream.getAudioTracks().length > 0) {
            myStream.getAudioTracks()[0].enabled = micEnabled;
        }

        updateMicButton();

        // Notify peers about mute status via Firestore
        if (currentRoom && firebase.auth().currentUser) {
            db.collection('rooms').doc(currentRoom).collection('participants')
                .doc(firebase.auth().currentUser.uid)
                .update({ 
                    muted: !micEnabled,
                    lastSeen: firebase.firestore.FieldValue.serverTimestamp()
                })
                .catch(err => console.error('Error updating mute status:', err));
        }
    }

    // Send chat message
    function sendMessage() {
        const message = chatInput.value.trim();
        if (!message) return;

        // Display own message
        addMessage(userName, message);

        // Send to all peers via Firestore
        if (currentRoom && firebase.auth().currentUser) {
            db.collection('rooms').doc(currentRoom).collection('messages').add({
                senderId: firebase.auth().currentUser.uid,
                senderName: userName,
                message: message,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            }).catch(err => console.error('Error sending message:', err));
        }

        chatInput.value = '';
    }

    function addMessage(sender, message) {
        if (!chatMessages) return;
        
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message';
        messageDiv.innerHTML = `<span class="message-sender">${sender}:</span> <span class="message-text">${message}</span>`;
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // Set current room
    function setCurrentRoom(roomId) {
        currentRoom = roomId;
    }

    // Clean up
    function cleanup() {
        console.log('Cleaning up PeerJS connections');
        
        if (myStream) {
            myStream.getTracks().forEach(track => {
                track.stop();
                track.enabled = false;
            });
            myStream = null;
        }

        peerConnections.forEach((connection, peerId) => {
            if (connection.call) {
                connection.call.close();
            }
        });
        peerConnections.clear();

        participantAudios.forEach((audio, peerId) => {
            audio.pause();
            audio.srcObject = null;
            audio.remove();
        });
        participantAudios.clear();

        if (peer && !peer.destroyed) {
            peer.destroy();
            peer = null;
        }
        
        reconnectAttempts = 0;
    }

    // Public API
    return {
        init,
        connectToPeer,
        toggleMic,
        sendMessage,
        setCurrentRoom,
        cleanup,
        isMicEnabled: () => micEnabled
    };
})();
