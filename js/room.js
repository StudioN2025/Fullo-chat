<!-- В конце файла index.html замените блок с дополнительной защитой на этот: -->
<script>
// Только реальное закрытие страницы
window.addEventListener('pagehide', function() {
    if (window.room && window.room.getCurrentRoom()) {
        console.log('Page hidden, leaving room');
        window.room.leaveRoom();
    }
});

window.addEventListener('beforeunload', function() {
    if (window.room && window.room.getCurrentRoom()) {
        console.log('Page unloading, leaving room');
        const roomId = window.room.getCurrentRoom();
        const user = firebase.auth().currentUser;
        if (roomId && user) {
            localStorage.setItem('lastRoom_' + user.uid, roomId);
        }
        window.room.leaveRoom();
    }
});

// Убрали visibilitychange - теперь при сворачивании не выходим

window.addEventListener('load', function() {
    const user = firebase.auth().currentUser;
    if (user) {
        const lastRoom = localStorage.getItem('lastRoom_' + user.uid);
        if (lastRoom) {
            localStorage.removeItem('lastRoom_' + user.uid);
            db.collection('rooms').doc(lastRoom).collection('participants').doc(user.uid).update({
                online: false,
                leftAt: firebase.firestore.FieldValue.serverTimestamp()
            }).catch(() => {});
        }
    }
});
</script>
