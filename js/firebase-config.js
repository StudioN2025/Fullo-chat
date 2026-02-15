// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyDnFP2OVLCn37ZGiWvACP0Bs-B8GsezaaM",
    authDomain: "fullochat-9bede.firebaseapp.com",
    projectId: "fullochat-9bede",
    storageBucket: "fullochat-9bede.firebasestorage.app",
    messagingSenderId: "932442534036",
    appId: "1:932442534036:web:d2489aabd40aae14ba4481"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Initialize services
const auth = firebase.auth();
const db = firebase.firestore();

// Enable offline persistence
db.enablePersistence({ synchronizeTabs: true })
    .then(() => {
        console.log('Firestore persistence enabled with tab synchronization');
    })
    .catch((err) => {
        if (err.code == 'failed-precondition') {
            console.warn('Multiple tabs open, persistence enabled in one tab only');
        } else if (err.code == 'unimplemented') {
            console.warn('Browser doesn\'t support persistence');
        } else {
            console.error('Persistence error:', err);
        }
    });

// Make globally available
window.auth = auth;
window.db = db;

console.log('Firebase initialized successfully with project:', firebaseConfig.projectId);
