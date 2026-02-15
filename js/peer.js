// Native WebRTC Peer Module (без PeerJS)
window.peer = (function() {
    let localStream = null;
    let peerConnections = new Map(); // userId -> RTCPeerConnection
    let dataChannels = new Map(); // userId -> RTCDataChannel
    let remoteAudioElements = new Map(); // userId -> audio element
    let micEnabled = true;
    let currentRoom = null;
    let userName = '';
    let userId = null;
    let pendingCandidates = new Map(); // userId -> RTCIceCandidate[]
    let pendingOffers = new Map(); // userId -> RTCSessionDescription

    // DOM Elements
    const micToggleButton = document.getElementById('micToggleButton');
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput');

    // Configuration
    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ]
    };

    // Initialize
    async function init(uid, displayName) {
        userId = uid;
        userName = displayName;
        
        console.log('Initializing WebRTC for user:', userId);
        
        try {
            // Get user media
            localStream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }, 
                video: false 
            });
            
            console.log('Microphone access granted');
            updateMicButton();
            
            // Listen for WebRTC signaling from Firestore
            listenForSignaling();
            
            return userId;
        } catch (error) {
            console.error('Error accessing microphone:', error);
            window.auth.showError('Ошибка доступа к микрофону: ' + error.message);
            return null;
        }
    }

    // Listen for WebRTC signaling from Firestore
    function listenForSignaling() {
        if (!currentRoom || !userId) return;

        console.log('Listening for WebRTC signaling...');

        // Listen for offers
        db.collection('rooms').doc(currentRoom)
            .collection('signaling')
            .where('target', '==', userId)
            .onSnapshot((snapshot) => {
                snapshot.docChanges().forEach((change) => {
                    if (change.type === 'added') {
                        const data = change.doc.data();
                        handleSignal(data);
                        // Delete after processing
                        change.doc.ref.delete().catch(err => console.error('Error deleting signal:', err));
                    }
                });
            });

        // Listen for ICE candidates
        db.collection('rooms').doc(currentRoom)
            .collection('iceCandidates')
            .where('target', '==', userId)
            .onSnapshot((snapshot) => {
                snapshot.docChanges().forEach((change) => {
                    if (change.type === 'added') {
                        const data = change.doc.data();
                        handleIceCandidate(data);
                        // Delete after processing
                        change.doc.ref.delete().catch(err => console.error('Error deleting ICE candidate:', err));
                    }
                });
            });
    }

    // Handle signaling messages
    async function handleSignal(data) {
        console.log('Received signal from:', data.from, 'type:', data.type);
        
        const fromUserId = data.from;
        
        if (data.type === 'offer') {
            await handleOffer(fromUserId, data.offer);
        } else if (data.type === 'answer') {
            await handleAnswer(fromUserId, data.answer);
        }
    }

    // Handle ICE candidates
    async function handleIceCandidate(data) {
        console.log('Received ICE candidate from:', data.from);
        
        const fromUserId = data.from;
        const candidate = new RTCIceCandidate(data.candidate);
        
        const peerConnection = peerConnections.get(fromUserId);
        if (peerConnection) {
            try {
                await peerConnection.addIceCandidate(candidate);
                console.log('ICE candidate added to connection');
            } catch (error) {
                console.error('Error adding ICE candidate:', error);
            }
        } else {
            // Store candidate for later
            if (!pendingCandidates.has(fromUserId)) {
                pendingCandidates.set(fromUserId, []);
            }
            pendingCandidates.get(fromUserId).push(candidate);
        }
    }

    // Create peer connection for a user
    async function createPeerConnection(targetUserId) {
        console.log('Creating peer connection to:', targetUserId);
        
        const peerConnection = new RTCPeerConnection(configuration);
        
        // Add local stream
        if (localStream) {
            localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, localStream);
            });
        }

        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Generated ICE candidate');
                // Send ICE candidate to target user via Firestore
                db.collection('rooms').doc(currentRoom)
                    .collection('iceCandidates')
                    .add({
                        from: userId,
                        target: targetUserId,
                        candidate: event.candidate.toJSON(),
                        timestamp: firebase.firestore.FieldValue.serverTimestamp()
                    }).catch(err => console.error('Error sending ICE candidate:', err));
            }
        };

        // Handle connection state changes
        peerConnection.onconnectionstatechange = () => {
            console.log('Connection state to', targetUserId, ':', peerConnection.connectionState);
            if (peerConnection.connectionState === 'connected') {
                console.log('Successfully connected to:', targetUserId);
                window.auth.showSuccess(`Подключен к участнику`);
            } else if (peerConnection.connectionState === 'failed' || 
                       peerConnection.connectionState === 'disconnected') {
                console.log('Connection failed to:', targetUserId);
            }
        };

        // Handle ICE connection state
        peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE connection state to', targetUserId, ':', peerConnection.iceConnectionState);
        };

        // Handle incoming stream
        peerConnection.ontrack = (event) => {
            console.log('Received remote stream from:', targetUserId);
            addRemoteAudio(targetUserId, event.streams[0]);
        };

        // Store connection
        peerConnections.set(targetUserId, peerConnection);

        return peerConnection;
    }

    // Create data channel for messaging (optional)
    function createDataChannel(peerConnection, targetUserId) {
        const dataChannel = peerConnection.createDataChannel('chat');
        
        dataChannel.onopen = () => {
            console.log('Data channel opened with:', targetUserId);
        };
        
        dataChannel.onmessage = (event) => {
            console.log('Received message via data channel:', event.data);
            // Handle message if needed
        };
        
        dataChannels.set(targetUserId, dataChannel);
        return dataChannel;
    }

    // Handle incoming offer
    async function handleOffer(fromUserId, offerObj) {
        console.log('Handling offer from:', fromUserId);
        
        try {
            const peerConnection = await createPeerConnection(fromUserId);
            
            // Handle data channel if needed
            peerConnection.ondatachannel = (event) => {
                const dataChannel = event.channel;
                dataChannels.set(fromUserId, dataChannel);
                
                dataChannel.onmessage = (e) => {
                    console.log('Received message:', e.data);
                };
            };
            
            // Set remote description
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offerObj));
            
            // Create answer
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            // Send answer via Firestore
            await db.collection('rooms').doc(currentRoom)
                .collection('signaling')
                .add({
                    from: userId,
                    target: fromUserId,
                    type: 'answer',
                    answer: answer.toJSON(),
                    timestamp: firebase.firestore.FieldValue.serverTimestamp()
                });
            
            console.log('Answer sent to:', fromUserId);
            
            // Add any pending ICE candidates
            const candidates = pendingCandidates.get(fromUserId);
            if (candidates) {
                for (const candidate of candidates) {
                    await peerConnection.addIceCandidate(candidate);
                }
                pendingCandidates.delete(fromUserId);
            }
            
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    }

    // Handle incoming answer
    async function handleAnswer(fromUserId, answerObj) {
        console.log('Handling answer from:', fromUserId);
        
        try {
            const peerConnection = peerConnections.get(fromUserId);
            if (!peerConnection) {
                console.error('No peer connection for:', fromUserId);
                return;
            }
            
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answerObj));
            console.log('Remote description set for:', fromUserId);
            
            // Add any pending ICE candidates
            const candidates = pendingCandidates.get(fromUserId);
            if (candidates) {
                for (const candidate of candidates) {
                    await peerConnection.addIceCandidate(candidate);
                }
                pendingCandidates.delete(fromUserId);
            }
            
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }

    // Initiate connection to a peer
    async function connectToPeer(targetUserId, targetDisplayName) {
        if (!currentRoom || !userId || targetUserId === userId) {
            console.log('Cannot connect to self or invalid room');
            return;
        }

        console.log('Initiating connection to:', targetUserId);

        try {
            // Create peer connection
            const peerConnection = await createPeerConnection(targetUserId);
            
            // Create data channel for messaging
            createDataChannel(peerConnection, targetUserId);
            
            // Create offer
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: false
            });
            
            await peerConnection.setLocalDescription(offer);
            
            // Send offer via Firestore
            await db.collection('rooms').doc(currentRoom)
                .collection('signaling')
                .add({
                    from: userId,
                    target: targetUserId,
                    type: 'offer',
                    offer: offer.toJSON(),
                    timestamp: firebase.firestore.FieldValue.serverTimestamp()
                });
            
            console.log('Offer sent to:', targetUserId);
            
        } catch (error) {
            console.error('Error connecting to peer:', error);
        }
    }

    // Add remote audio
    function addRemoteAudio(userId, stream) {
        // Remove existing audio if any
        const existingAudio = remoteAudioElements.get(userId);
        if (existingAudio) {
            existingAudio.remove();
        }

        const audio = document.createElement('audio');
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.id = `audio-${userId}`;
        audio.style.display = 'none'; // Hide audio element
        document.body.appendChild(audio);

        remoteAudioElements.set(userId, audio);
        console.log('Remote audio added for user:', userId);
    }

    // Update mic button state
    function updateMicButton() {
        if (micToggleButton) {
            micToggleButton.textContent = micEnabled ? '🎤 Микрофон включен' : '🔇 Микрофон выключен';
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

        // Update status in Firestore
        if (currentRoom && userId) {
            db.collection('rooms').doc(currentRoom).collection('participants')
                .doc(userId)
                .update({ 
                    muted: !micEnabled,
                    lastSeen: firebase.firestore.FieldValue.serverTimestamp()
                })
                .catch(err => console.error('Error updating mute status:', err));
        }
    }

    // Send chat message via Firestore
    function sendMessage() {
        const message = chatInput.value.trim();
        if (!message) return;

        // Display own message
        addMessage(userName, message);

        // Send to all via Firestore
        if (currentRoom && userId) {
            db.collection('rooms').doc(currentRoom).collection('messages').add({
                senderId: userId,
                senderName: userName,
                message: message,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            }).catch(err => console.error('Error sending message:', err));
        }

        chatInput.value = '';
    }

    // Add message to chat UI
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
        if (userId) {
            listenForSignaling();
        }
    }

    // Clean up
    function cleanup() {
        console.log('Cleaning up WebRTC connections');
        
        // Close all peer connections
        peerConnections.forEach((connection, userId) => {
            connection.close();
        });
        peerConnections.clear();
        
        // Clear data channels
        dataChannels.clear();
        
        // Remove remote audio elements
        remoteAudioElements.forEach((audio, userId) => {
            audio.pause();
            audio.srcObject = null;
            audio.remove();
        });
        remoteAudioElements.clear();
        
        // Stop local stream
        if (localStream) {
            localStream.getTracks().forEach(track => {
                track.stop();
            });
            localStream = null;
        }
        
        // Clear pending maps
        pendingCandidates.clear();
        pendingOffers.clear();
        
        currentRoom = null;
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
