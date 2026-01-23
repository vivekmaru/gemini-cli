const chatHistory = document.getElementById('chat-history');
const promptInput = document.getElementById('prompt-input');
const sendButton = document.getElementById('send-button');
const statusDiv = document.getElementById('status');

let ws;
let currentAssistantMessageDiv = null;

function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        statusDiv.textContent = 'Connected';
        statusDiv.className = 'status connected';
    };

    ws.onmessage = (event) => {
        const lines = event.data.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const message = JSON.parse(line);
                handleMessage(message);
            } catch (e) {
                console.error('Error parsing message:', e, line);
            }
        }
    };

    ws.onclose = () => {
        statusDiv.textContent = 'Disconnected. Reconnecting...';
        statusDiv.className = 'status disconnected';
        setTimeout(connect, 3000);
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
}

function handleMessage(message) {
    switch (message.type) {
        case 'init':
            console.log('Session initialized:', message);
            break;
        case 'message':
            if (message.role === 'user') {
                appendMessage('user', message.content);
            } else if (message.role === 'assistant') {
                if (message.delta) {
                    if (!currentAssistantMessageDiv) {
                        currentAssistantMessageDiv = appendMessage('assistant', '');
                    }
                    currentAssistantMessageDiv.textContent += message.content;
                    scrollToBottom();
                } else {
                     appendMessage('assistant', message.content);
                }
            }
            break;
        case 'tool_use':
            appendMessage('tool-use', `Tool Use: ${message.tool_name}\nParams: ${JSON.stringify(message.parameters, null, 2)}`);
            break;
        case 'tool_result':
             appendMessage('tool-result', `Tool Result: ${message.tool_id}\nStatus: ${message.status}\nOutput: ${message.output || JSON.stringify(message.error)}`);
            break;
        case 'error':
            appendMessage('error', `Error: ${message.message}`);
            break;
        case 'result':
            currentAssistantMessageDiv = null;
            sendButton.disabled = false;
            promptInput.disabled = false;
            promptInput.focus();
            break;
    }
}

function appendMessage(role, text) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.textContent = text;
    chatHistory.appendChild(div);
    scrollToBottom();
    return div;
}

function scrollToBottom() {
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

sendButton.addEventListener('click', sendMessage);
promptInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

function sendMessage() {
    const text = promptInput.value.trim();
    if (!text) return;

    if (ws.readyState !== WebSocket.OPEN) {
        alert('Not connected');
        return;
    }

    // appendMessage('user', text); // Server echoes user message
    ws.send(text);
    promptInput.value = '';
    sendButton.disabled = true;
    promptInput.disabled = true;
    currentAssistantMessageDiv = null;
}

connect();
