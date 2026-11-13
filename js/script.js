const chatWindow = document.getElementById('chatWindow');
const chatForm = document.getElementById('chatForm');
const messageInput = document.getElementById('messageInput');
const resetButton = document.getElementById('resetChat');

function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function scrollToBottom() {
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function addMessage(role, text, extraClass = '') {
    const article = document.createElement('article');
    article.className = `message ${role} ${extraClass}`.trim();
    const isError = extraClass.includes('error');
    const avatar = isError ? '!' : (role === 'user' ? 'You' : 'HT');
    const sender = isError ? 'System notice' : (role === 'user' ? 'You' : 'Hobse TripMate');

    article.innerHTML = `
        <div class="avatar">${avatar}</div>
        <div class="message-body">
            <div class="message-name">${sender}</div>
            <div class="bubble">${escapeHtml(text)}</div>
        </div>
    `;
    chatWindow.appendChild(article);
    scrollToBottom();
    return article;
}

function removeWelcomeState() {
    const welcomeState = document.getElementById('welcomeState');
    if (welcomeState) {
        welcomeState.remove();
    }
}

async function postChat(payload) {
    const response = await fetch('chat.php', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Something went wrong.');
    }

    return data;
}

chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const message = messageInput.value.trim();
    if (!message) {
        return;
    }

    removeWelcomeState();
    addMessage('user', message);
    messageInput.value = '';
    messageInput.focus();

    const typing = addMessage('assistant', 'Hobse TripMate is checking the best travel questions...', 'typing');
    chatForm.querySelector('button').disabled = true;

    try {
        const data = await postChat({ message });
        typing.remove();
        addMessage('assistant', data.reply);
    } catch (error) {
        typing.remove();
        addMessage('assistant', error.message, 'error');
    } finally {
        chatForm.querySelector('button').disabled = false;
    }
});

resetButton.addEventListener('click', async () => {
    resetButton.disabled = true;

    try {
        await postChat({ action: 'reset' });
        window.location.reload();
    } catch (error) {
        addMessage('assistant', error.message, 'error');
    } finally {
        resetButton.disabled = false;
    }
});

document.addEventListener('click', (event) => {
    const routeButton = event.target.closest('[data-route]');
    if (!routeButton) {
        return;
    }

    messageInput.value = routeButton.dataset.route;
    messageInput.focus();
});
