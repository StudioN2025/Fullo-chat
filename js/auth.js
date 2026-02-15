// Auth Module
window.auth = (function() {
    // State
    let currentUser = null;
    let isAuthModeLogin = true;
    let userDisplayName = '';

    // DOM Elements
    const authContainer = document.getElementById('authContainer');
    const profileContainer = document.getElementById('profileContainer');
    const roomContainer = document.getElementById('roomContainer');
    const activeRoomContainer = document.getElementById('activeRoomContainer');
    const authTitle = document.getElementById('authTitle');
    const authButton = document.getElementById('authButton');
    const switchAuthButton = document.getElementById('switchAuthButton');
    const switchAuthText = document.getElementById('switchAuthText');
    const errorMessage = document.getElementById('errorMessage');
    const successMessage = document.getElementById('successMessage');
    const displayNameSpan = document.getElementById('displayName');
    const activeDisplayNameSpan = document.getElementById('activeDisplayName');
    const emailInput = document.getElementById('emailInput');
    const passwordInput = document.getElementById('passwordInput');
    const profileNameInput = document.getElementById('profileNameInput');

    // Initialize auth state observer
    firebase.auth().onAuthStateChanged(async (user) => {
        if (user) {
            currentUser = user;
            const userDoc = await db.collection('users').doc(user.uid).get();
            
            if (userDoc.exists && userDoc.data().profileCompleted) {
                userDisplayName = userDoc.data().displayName;
                showRoomContainer(userDisplayName);
            } else {
                showProfileContainer();
            }
        } else {
            showAuthContainer();
        }
    });

    // Show functions
    function showAuthContainer() {
        authContainer.classList.remove('hidden');
        profileContainer.classList.add('hidden');
        roomContainer.classList.add('hidden');
        activeRoomContainer.classList.add('hidden');
        clearMessages();
    }

    function showProfileContainer() {
        authContainer.classList.add('hidden');
        profileContainer.classList.remove('hidden');
        roomContainer.classList.add('hidden');
        activeRoomContainer.classList.add('hidden');
        clearMessages();
        
        // Pre-fill name from email if available
        if (currentUser && currentUser.email) {
            const defaultName = currentUser.email.split('@')[0];
            profileNameInput.value = defaultName;
        }
    }

    function showRoomContainer(displayName) {
        authContainer.classList.add('hidden');
        profileContainer.classList.add('hidden');
        roomContainer.classList.remove('hidden');
        activeRoomContainer.classList.add('hidden');
        
        displayNameSpan.textContent = `Привет, ${displayName}!`;
        activeDisplayNameSpan.textContent = displayName;
        userDisplayName = displayName;
        clearMessages();
    }

    function showActiveRoom() {
        authContainer.classList.add('hidden');
        profileContainer.classList.add('hidden');
        roomContainer.classList.add('hidden');
        activeRoomContainer.classList.remove('hidden');
    }

    function clearMessages() {
        errorMessage.textContent = '';
        successMessage.textContent = '';
    }

    function showError(text) {
        errorMessage.textContent = text;
        successMessage.textContent = '';
        if (window.showNotification) {
            window.showNotification(text, 'error');
        }
    }

    function showSuccess(text) {
        successMessage.textContent = text;
        errorMessage.textContent = '';
        if (window.showNotification) {
            window.showNotification(text, 'success');
        }
    }

    // Switch between login and signup
    function switchAuthMode() {
        isAuthModeLogin = !isAuthModeLogin;
        if (isAuthModeLogin) {
            authTitle.textContent = 'Вход в FulloChat';
            authButton.textContent = 'Войти';
            switchAuthButton.textContent = 'Создать аккаунт';
            switchAuthText.textContent = 'Нет аккаунта? Зарегистрируйтесь';
        } else {
            authTitle.textContent = 'Регистрация в FulloChat';
            authButton.textContent = 'Зарегистрироваться';
            switchAuthButton.textContent = 'Войти';
            switchAuthText.textContent = 'Уже есть аккаунт? Войдите';
        }
        clearMessages();
    }

    // Handle authentication
    async function handleAuth() {
        const email = emailInput.value.trim();
        const password = passwordInput.value;

        if (!email || !password) {
            showError('Пожалуйста, заполните все поля');
            return;
        }

        if (password.length < 6) {
            showError('Пароль должен содержать минимум 6 символов');
            return;
        }

        try {
            if (isAuthModeLogin) {
                await firebase.auth().signInWithEmailAndPassword(email, password);
                showSuccess('Вход выполнен успешно!');
            } else {
                await firebase.auth().createUserWithEmailAndPassword(email, password);
                showSuccess('Регистрация успешна! Заполните профиль.');
            }
        } catch (error) {
            handleAuthError(error);
        }
    }

    function handleAuthError(error) {
        switch (error.code) {
            case 'auth/invalid-email':
                showError('Неверный формат email');
                break;
            case 'auth/user-disabled':
                showError('Пользователь заблокирован');
                break;
            case 'auth/user-not-found':
                showError('Пользователь не найден');
                break;
            case 'auth/wrong-password':
                showError('Неверный пароль');
                break;
            case 'auth/email-already-in-use':
                showError('Email уже используется');
                break;
            case 'auth/weak-password':
                showError('Слишком простой пароль');
                break;
            default:
                showError('Ошибка: ' + error.message);
        }
    }

    // Save profile
    async function saveProfile() {
        const displayName = profileNameInput.value.trim();
        
        if (!displayName) {
            showError('Пожалуйста, введите ваше имя');
            return;
        }

        if (displayName.length > 30) {
            showError('Имя не должно превышать 30 символов');
            return;
        }

        try {
            await db.collection('users').doc(currentUser.uid).set({
                displayName: displayName,
                email: currentUser.email,
                profileCompleted: true,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            userDisplayName = displayName;
            showRoomContainer(displayName);
            showSuccess('Профиль сохранен!');
        } catch (error) {
            showError('Ошибка сохранения профиля: ' + error.message);
        }
    }

    // Logout
    async function logout() {
        try {
            // Leave room if in one
            if (window.room && window.room.getCurrentRoom()) {
                await window.room.leaveRoom();
            }
            
            // Clean up peer connections
            if (window.peer) {
                window.peer.cleanup();
            }
            
            await firebase.auth().signOut();
            showSuccess('Выход выполнен');
        } catch (error) {
            showError('Ошибка выхода: ' + error.message);
        }
    }

    // Public API
    return {
        handleAuth,
        switchAuthMode,
        saveProfile,
        logout,
        showError,
        showSuccess,
        showActiveRoom,
        getCurrentUser: () => currentUser,
        getUserDisplayName: () => userDisplayName
    };
})();
