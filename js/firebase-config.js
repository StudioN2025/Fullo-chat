// Firebase configuration
// ЗАМЕНИТЕ ЭТИ ЗНАЧЕНИЯ НА СВОИ ИЗ КОНСОЛИ FIREBASE
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

// Make globally available
window.auth = auth;
window.db = db;