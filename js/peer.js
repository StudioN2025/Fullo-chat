// Peer Module for P2P connections
window.peer = (function() {
    let peer = null;
    let myStream = null;
    let micEnabled = true;
    let peerConnections = new Map(); // peerId -> {conn, call}
    let participantAudios = new Map(); // peerId -> audio element
    let currentRoom = null;
    let userName = '';

    // DOM Elements
    const micToggleButton = document.getElementById('micToggleButton');
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput');

    // Initialize Peer
    function init(userId, displayName) {
        userName = displayName;
        
        // Generate random Peer ID
        const peerId = generatePeerId();
        
        peer = new Peer(peerId, {
            config: {
                'iceServers': [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' },
                    { urls: 'stun:stun3.l.google.com:19302' },
                    { urls: 'stun:stun4.l.google.com:19302' }
                ]
            }
        });

        peer.on('open', (id) => {
            console.log('PeerJS connected with ID:', id);
            // Save peer ID to Firestore
            if (currentRoom) {
                db.collection('rooms').doc(currentRoom).collection('participants').doc(userId).update({
                    peerId: id,
                    online: true
                });
            }
        });

        peer.on('call', handleIncomingCall);
        peer.on('error', (error) => {
            console.error('PeerJS error:', error);
            window.auth.showError('Ошибка соединения: ' + error.type);
        });

        peer.on('disconnected', () => {
            console.log('PeerJS disconnected, reconnecting...');
            peer.reconnect();
        });

        // Get user media
        navigator.mediaDevices.getUserMedia({ audio: true, video: false })
            .then((stream) => {
                myStream = stream;
                console.log('Microphone access granted');
            })
            .catch((error) => {
                console.error('Error accessing microphone:', error);
                window.auth.showError('Ошибка доступа к микрофону');
            });

        return peerId;
    }

    function generatePeerId() {
        return 'peer_' + Math.random().toString(36).substr(2, 9);
    }

    // Handle incoming call
    function handleIncomingCall(call) {
        if (!myStream) {
            console.error('No local stream available');
            call.close();
            return;
        }

        call.answer(myStream);
        
        call.on('stream', (remoteStream) => {
            addRemoteAudio(call.peer, remoteStream);
        });

        call.on('close', () => {
            removeRemoteAudio(call.peer);
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
        if (!peer || !myStream) return;

        // Call the peer
        const call = peer.call(peerId, myStream);
        
        call.on('stream', (remoteStream) => {
            addRemoteAudio(peerId, remoteStream, targetUserId);
        });

        call.on('close', () => {
            removeRemoteAudio(peerId);
        });

        // Store connection
        peerConnections.set(peerId, { call });
    }

    // Add remote audio
    function addRemoteAudio(peerId, stream, userId) {
        // Remove existing audio if any
        removeRemoteAudio(peerId);

        const audio = document.createElement('audio');
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.id = `audio-${peerId}`;
        document.body.appendChild(audio);

        participantAudios.set(peerId, audio);

        // Update participant card
        updateParticipantAudioStatus(peerId, userId);
    }

    function removeRemoteAudio(peerId) {
        const audio = participantAudios.get(peerId);
        if (audio) {
            audio.remove();
            participantAudios.delete(peerId);
        }
    }

    function updateParticipantAudioStatus(peerId, userId) {
        const participantCard = document.getElementById(`participant-${userId || peerId}`);
        if (participantCard) {
            const statusDiv = participantCard.querySelector('.participant-status');
            if (statusDiv) {
                statusDiv.textContent = '🔊 В сети';
                statusDiv.classList.remove('muted');
            }
        }
    }

    // Toggle microphone
    function toggleMic() {
        if (!myStream) return;

        micEnabled = !micEnabled;
        myStream.getAudioTracks()[0].enabled = micEnabled;

        // Update button
        micToggleButton.textContent = micEnabled ? '🎤 Микрофон включен' : '🔇 Микрофон выключен';
        micToggleButton.classList.toggle('muted', !micEnabled);

        // Notify all peers about mute status
        const muteStatus = !micEnabled;
        peerConnections.forEach((connection, peerId) => {
            if (connection.call && connection.call.open) {
                // We'll use data connection for control messages
                // For now, just log
                console.log(`Sending mute status ${muteStatus} to ${peerId}`);
            }
        });
    }

    // Send chat message
    function sendMessage() {
        const message = chatInput.value.trim();
        if (!message) return;

        // Display own message
        addMessage(userName, message);

        // Send to all peers via Firestore (as backup) or via PeerJS data connection
        // For simplicity, we'll use Firestore for now
        if (currentRoom) {
            db.collection('rooms').doc(currentRoom).collection('messages').add({
                senderId: firebase.auth().currentUser.uid,
                senderName: userName,
                message: message,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });
        }

        chatInput.value = '';
    }

    function addMessage(sender, message) {
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
        if (myStream) {
            myStream.getTracks().forEach(track => track.stop());
            myStream = null;
        }

        peerConnections.forEach((connection, peerId) => {
            if (connection.call) connection.call.close();
        });
        peerConnections.clear();

        participantAudios.forEach((audio, peerId) => {
            audio.remove();
        });
        participantAudios.clear();

        if (peer) {
            peer.destroy();
            peer = null;
        }
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