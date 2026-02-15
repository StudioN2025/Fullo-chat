// Native WebRTC Peer Module
window.peer = (function() {
    let localStream = null;
    let peerConnections = new Map();
    let remoteAudioElements = new Map();
    let micEnabled = true;
    let currentRoom = null;
    let userName = '';
    let userId = null;
    let pendingCandidates = new Map();

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
            
            listenForSignaling();
            
            return userId;
        } catch (error) {
            console.error('Error accessing microphone:', error);
            window.auth.showError('Ошибка доступа к микрофону: ' + error.message);
            return null;
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
            .onSnapshot((snapshot) => {
                snapshot.docChanges().forEach((change) => {
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
            .onSnapshot((snapshot) => {
                snapshot.docChanges().forEach((change) => {
                    if (change.type === 'added') {
                        const data = change.doc.data();
                        handleIceCandidate(data);
                        change.doc.ref.delete().catch(console.error);
                    }
                });
            });
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
            
            if (peerConnection && peerConnection.remoteDescription) {
                await peerConnection.addIceCandidate(candidate);
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
        
        // Add local stream
        if (localStream) {
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
                console.log('Added track:', track.kind);
            });
        }

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
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
                    }).catch(err => console.error('Error sending ICE candidate:', err));
            }
        };

        // Handle connection state
        pc.onconnectionstatechange = () => {
            console.log('Connection state to', targetUserId, ':', pc.connectionState);
            if (pc.connectionState === 'connected') {
                console.log('Successfully connected to:', targetUserId);
                window.auth.showSuccess(`Подключен к участнику`);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                console.log('Connection lost to:', targetUserId);
            }
        };

        // Handle ICE connection state
        pc.oniceconnectionstatechange = () => {
            console.log('ICE connection state to', targetUserId, ':', pc.iceConnectionState);
        };

        // Handle remote stream
        pc.ontrack = (event) => {
            console.log('Received remote stream from:', targetUserId);
            
            const audio = document.createElement('audio');
            audio.srcObject = event.streams[0];
            audio.autoplay = true;
            audio.id = `audio-${targetUserId}`;
            audio.style.display = 'none';
            document.body.appendChild(audio);
            
            const oldAudio = remoteAudioElements.get(targetUserId);
            if (oldAudio) oldAudio.remove();
            remoteAudioElements.set(targetUserId, audio);
            
            audio.play().catch(e => console.log('Audio play error:', e));
            
            console.log('Remote audio added for user:', targetUserId);
        };

        peerConnections.set(targetUserId, pc);
        return pc;
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
            const pc = peerConnections.get(fromUserId);
            if (!pc) {
                console.error('No peer connection for:', fromUserId);
                return;
            }
            
            await pc.setRemoteDescription(new RTCSessionDescription(answerObj));
            console.log('Remote description set from answer');
            
            const candidates = pendingCandidates.get(fromUserId);
            if (candidates) {
                for (const candidate of candidates) {
                    await pc.addIceCandidate(candidate);
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
                offerToReceiveVideo: false
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

    function updateMicButton() {
        if (micToggleButton) {
            micToggleButton.textContent = micEnabled ? '🎤 Микрофон включен' : '🔇 Микрофон выключен';
            micToggleButton.classList.toggle('muted', !micEnabled);
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
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            }).catch(console.error);
        }

        chatInput.value = '';
    }

    function addMessage(sender, message, isOwn = false) {
        if (!chatMessages) return;
        
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message';
        if (isOwn) {
            messageDiv.classList.add('own-message');
        }
        messageDiv.innerHTML = `<span class="message-sender">${sender}:</span> <span class="message-text">${message}</span>`;
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function setCurrentRoom(roomId) {
        currentRoom = roomId;
        if (userId) {
            listenForSignaling();
        }
    }

    function closeConnection(userId) {
        const pc = peerConnections.get(userId);
        if (pc) {
            pc.close();
            peerConnections.delete(userId);
        }
        const audio = remoteAudioElements.get(userId);
        if (audio) {
            audio.pause();
            audio.srcObject = null;
            audio.remove();
            remoteAudioElements.delete(userId);
        }
        console.log('Closed connection to user:', userId);
    }

    function cleanup() {
        console.log('Cleaning up WebRTC connections');
        
        peerConnections.forEach((pc, userId) => {
            pc.close();
        });
        peerConnections.clear();
        
        remoteAudioElements.forEach((audio, userId) => {
            audio.pause();
            audio.srcObject = null;
            audio.remove();
        });
        remoteAudioElements.clear();
        
        if (localStream) {
            localStream.getTracks().forEach(track => {
                track.stop();
            });
            localStream = null;
        }
        
        pendingCandidates.clear();
        currentRoom = null;
        userId = null;
    }

    // Public API
    return {
        init,
        connectToPeer,
        toggleMic,
        sendMessage,
        addMessage,
        setCurrentRoom,
        closeConnection,
        cleanup,
        isMicEnabled: () => micEnabled
    };
})();
