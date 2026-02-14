// Firebase configuration
// Импортируем функции из SDK (для модульной версии, но мы используем compat версию)
const firebaseConfig = {
    apiKey: "AIzaSyDnFP2OVLCn37ZGiWvACP0Bs-B8GsezaaM",
    authDomain: "fullochat-9bede.firebaseapp.com",
    projectId: "fullochat-9bede",
    storageBucket: "fullochat-9bede.firebasestorage.app",
    messagingSenderId: "932442534036",
    appId: "1:932442534036:web:d2489aabd40aae14ba4481"
};

// Initialize Firebase (используем compat версию, которая уже загружена в index.html)
firebase.initializeApp(firebaseConfig);

// Initialize services
const auth = firebase.auth();
const db = firebase.firestore();

// Enable offline persistence for better performance
db.enablePersistence()
    .then(() => {
        console.log('Firestore persistence enabled');
    })
    .catch((err) => {
        if (err.code == 'failed-precondition') {
            console.log('Multiple tabs open, persistence enabled in one tab only');
        } else if (err.code == 'unimplemented') {
            console.log('Browser doesn\'t support persistence');
        }
    });

// Make globally available
window.auth = auth;
window.db = db;

console.log('Firebase initialized successfully with project:', firebaseConfig.projectId);
