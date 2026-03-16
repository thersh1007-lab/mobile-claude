// App version — must match server. If mismatch, auto-reload.
const CLIENT_VERSION = '1.5.1';

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true,
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  }
});

const $ = s => document.querySelector(s);
const msgContainer = $('#messages');
const input = $('#msg-input');
const sendBtn = $('#send-btn');
const micBtn = $('#mic-btn');
const statusDot = $('#status-dot');
const statusText = $('#status-text');
const settingsModal = $('#settings-modal');
const wsSelect = $('#workspace-select');
const uploadBtn = $('#upload-btn');
const fileInput = $('#file-input');
const scrollFab = $('#scroll-fab');
const autoApproveCb = $('#auto-approve-cb');

// ── Zoom ──
let zoom = parseFloat(localStorage.getItem('mc_zoom') || '1');
function applyZoom() {
  document.documentElement.style.setProperty('--zoom', zoom);
  localStorage.setItem('mc_zoom', zoom);
}
applyZoom();

$('#zoom-in').addEventListener('click', () => {
  zoom = Math.min(zoom + 0.1, 1.8);
  applyZoom();
});
$('#zoom-out').addEventListener('click', () => {
  zoom = Math.max(zoom - 0.1, 0.7);
  applyZoom();
});

let ws = null;
let serverUrl = localStorage.getItem('mc_url') || '';
let authToken = localStorage.getItem('mc_token') || '';
let connected = false;
let agentState = 'idle';
let currentMode = localStorage.getItem('mc_mode') || 'direct';
let reconnectAttempts = 0;
let reconnectTimer = null;
const modeToggle = $('#mode-toggle');

function updateModeUI() {
  if (currentMode === 'bridge') {
    modeToggle.textContent = 'CC';
    modeToggle.classList.add('bridge');
    modeToggle.title = 'Claude Code mode — tap to switch to Direct API';
  } else {
    modeToggle.textContent = 'API';
    modeToggle.classList.remove('bridge');
    modeToggle.title = 'Direct API mode — tap to switch to Claude Code';
  }
}
updateModeUI();

modeToggle.addEventListener('click', () => {
  vibrate(30);
  const newMode = currentMode === 'direct' ? 'bridge' : 'direct';
  // Update immediately — don't wait for server confirmation
  currentMode = newMode;
  localStorage.setItem('mc_mode', currentMode);
  updateModeUI();
  // Send to server (may fail on flaky connection, will retry on next reconnect)
  if (ws && connected) {
    ws.send(JSON.stringify({ type: 'set_mode', mode: newMode, token: authToken }));
  }
});

// Auto-approve settings
let autoApprove = JSON.parse(localStorage.getItem('mc_auto_approve') || '{"read_file":true,"list_directory":true,"search_files":true}');
autoApproveCb.checked = Object.values(autoApprove).some(v => v);

function saveAutoApprove() {
  localStorage.setItem('mc_auto_approve', JSON.stringify(autoApprove));
  autoApproveCb.checked = Object.values(autoApprove).some(v => v);
}

// Notification settings
let notifySettings = JSON.parse(localStorage.getItem('mc_notify') || '{"approval":true,"done":true,"vibrate":true}');

function saveNotifySettings() {
  localStorage.setItem('mc_notify', JSON.stringify(notifySettings));
}

// ── Audio Notifications ──
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function ensureAudio() {
  if (!audioCtx) audioCtx = new AudioCtx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playTone(freq, duration, type = 'sine') {
  try {
    ensureAudio();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = 0.15;
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch(e) {}
}

function playApprovalSound() {
  if (!notifySettings.approval) return;
  // Two rising tones — "attention needed"
  playTone(440, 0.15);
  setTimeout(() => playTone(660, 0.2), 150);
}

function playDoneSound() {
  if (!notifySettings.done) return;
  // Soft descending chime — "done"
  playTone(880, 0.1);
  setTimeout(() => playTone(660, 0.1), 100);
  setTimeout(() => playTone(440, 0.2), 200);
}

function playErrorSound() {
  // Low buzz
  playTone(200, 0.3, 'sawtooth');
}

function vibrate(pattern) {
  if (!notifySettings.vibrate) return;
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// ── Voice Input ──
let recognition = null;
let isRecording = false;

function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.continuous = false;
  r.interimResults = true;
  r.lang = 'en-US';

  r.onresult = (e) => {
    let final = '';
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const transcript = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        final += transcript;
      } else {
        interim += transcript;
      }
    }
    if (final) {
      input.value = (input.value ? input.value + ' ' : '') + final;
      input.dispatchEvent(new Event('input'));
    }
    // Show interim in placeholder
    if (interim) {
      input.placeholder = interim + '...';
    }
  };

  r.onend = () => {
    isRecording = false;
    micBtn.classList.remove('recording');
    input.placeholder = 'Message Claude...';
  };

  r.onerror = (e) => {
    console.error('Speech error:', e.error);
    isRecording = false;
    micBtn.classList.remove('recording');
    input.placeholder = 'Message Claude...';
    if (e.error === 'not-allowed') {
      addSystemMsg('Microphone permission denied');
    }
  };

  return r;
}

micBtn.addEventListener('click', () => {
  // Init audio context on first user interaction (required by browsers)
  ensureAudio();

  if (!recognition) {
    recognition = initSpeechRecognition();
    if (!recognition) {
      addSystemMsg('Voice input not supported in this browser');
      return;
    }
  }

  if (isRecording) {
    recognition.stop();
    isRecording = false;
    micBtn.classList.remove('recording');
  } else {
    recognition.start();
    isRecording = true;
    micBtn.classList.add('recording');
    vibrate(50);
    input.placeholder = 'Listening...';
  }
});

// ── Quick Actions ──
document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!connected) return;
    const cmd = btn.dataset.cmd;
    input.value = cmd;
    sendMessage();
    vibrate(30);
  });
});

// ── Voice Memo Mode ──
const vmModal = $('#voice-memo-modal');
const vmTranscript = $('#vm-transcript');
const vmRecordBtn = $('#vm-record-btn');
const vmSendBtn = $('#vm-send-btn');
const vmCancelBtn = $('#vm-cancel-btn');
const vmStatus = $('#vm-status');
let vmRecognition = null;
let vmIsRecording = false;

$('#voice-memo-btn').addEventListener('click', () => {
  vmTranscript.textContent = '';
  vmSendBtn.disabled = true;
  vmStatus.textContent = 'Tap Record to start';
  vmRecordBtn.textContent = '🎤 Record';
  vmRecordBtn.classList.remove('recording');
  vmModal.classList.add('open');
  ensureAudio();
});

vmCancelBtn.addEventListener('click', () => {
  if (vmRecognition && vmIsRecording) vmRecognition.stop();
  vmIsRecording = false;
  vmModal.classList.remove('open');
});

vmRecordBtn.addEventListener('click', () => {
  ensureAudio();
  if (!vmRecognition) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { vmStatus.textContent = 'Voice input not supported'; return; }
    vmRecognition = new SR();
    vmRecognition.continuous = true;
    vmRecognition.interimResults = true;
    vmRecognition.lang = 'en-US';

    vmRecognition.onresult = (e) => {
      let finalText = '';
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t + ' ';
        else interim = t;
      }
      if (finalText.trim()) {
        vmTranscript.textContent = finalText.trim();
        vmSendBtn.disabled = false;
      }
      vmStatus.textContent = interim ? '🔴 ' + interim : '🔴 Listening...';
    };

    vmRecognition.onend = () => {
      if (vmIsRecording) {
        // Auto-restart if still in recording mode (browser stops after silence)
        try { vmRecognition.start(); } catch(e) {}
      } else {
        vmRecordBtn.textContent = '🎤 Record';
        vmRecordBtn.classList.remove('recording');
        vmStatus.textContent = vmTranscript.textContent ? 'Review & edit, then tap Create Topic' : 'Tap Record to start';
      }
    };

    vmRecognition.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        vmStatus.textContent = 'Error: ' + e.error;
      }
    };
  }

  if (vmIsRecording) {
    vmIsRecording = false;
    vmRecognition.stop();
    vmRecordBtn.textContent = '🎤 Record';
    vmRecordBtn.classList.remove('recording');
    vibrate(50);
  } else {
    vmIsRecording = true;
    vmRecognition.start();
    vmRecordBtn.textContent = '⏹ Stop';
    vmRecordBtn.classList.add('recording');
    vmStatus.textContent = '🔴 Listening...';
    vibrate(50);
  }
});

vmSendBtn.addEventListener('click', () => {
  const text = vmTranscript.textContent.trim();
  if (!text || !ws || !connected) return;
  if (vmRecognition && vmIsRecording) {
    vmIsRecording = false;
    vmRecognition.stop();
  }
  vmSendBtn.disabled = true;
  vmSendBtn.textContent = '⏳ Processing...';
  vmStatus.textContent = 'Claude is creating your topic...';
  ws.send(JSON.stringify({ type: 'voice_memo', transcript: text, token: authToken }));
});

// Scroll FAB
msgContainer.addEventListener('scroll', () => {
  const atBottom = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight < 100;
  scrollFab.classList.toggle('visible', !atBottom);
});

scrollFab.addEventListener('click', () => {
  msgContainer.scrollTo({ top: msgContainer.scrollHeight, behavior: 'smooth' });
});

// Auto-resize textarea
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  sendBtn.disabled = !input.value.trim() || !connected;
});

// Send on Enter
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener('click', sendMessage);

// New Chat
$('#new-chat-btn').addEventListener('click', () => {
  if (!ws) return;
  msgContainer.innerHTML = '';
  localStorage.removeItem(HISTORY_KEY);
  sessionCost = 0;
  sessionStartTime = Date.now();
  updateCostDisplay();
  ws.send(JSON.stringify({ type: 'new_chat', token: authToken }));
  addSystemMsg('New conversation started' + (currentMode === 'bridge' ? ' (Claude Code)' : ''));
});

// Settings
$('#settings-btn').addEventListener('click', () => {
  $('#set-url').value = serverUrl;
  $('#set-token').value = authToken;
  $('#set-auto-read').checked = autoApprove.read_file !== false;
  $('#set-auto-list').checked = autoApprove.list_directory !== false;
  $('#set-auto-search').checked = autoApprove.search_files !== false;
  $('#set-sound-approval').checked = notifySettings.approval !== false;
  $('#set-sound-done').checked = notifySettings.done !== false;
  $('#set-vibrate').checked = notifySettings.vibrate !== false;
  settingsModal.classList.add('open');
});

$('#back-btn').addEventListener('click', () => settingsModal.classList.remove('open'));

// Features modal
$('#features-btn').addEventListener('click', () => {
  $('#features-modal').classList.add('open');
});

$('#features-back-btn').addEventListener('click', () => {
  $('#features-modal').classList.remove('open');
});

$('#save-settings').addEventListener('click', () => {
  serverUrl = $('#set-url').value.trim();
  authToken = $('#set-token').value.trim();
  localStorage.setItem('mc_url', serverUrl);
  localStorage.setItem('mc_token', authToken);

  autoApprove = {
    read_file: $('#set-auto-read').checked,
    list_directory: $('#set-auto-list').checked,
    search_files: $('#set-auto-search').checked,
  };
  saveAutoApprove();

  notifySettings = {
    approval: $('#set-sound-approval').checked,
    done: $('#set-sound-done').checked,
    vibrate: $('#set-vibrate').checked,
  };
  saveNotifySettings();

  settingsModal.classList.remove('open');
  connect();
});

function setStatus(state, text) {
  statusDot.className = state;
  statusText.textContent = text;
}

function scrollBottom() {
  setTimeout(() => {
    const atBottom = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight < 200;
    if (atBottom) msgContainer.scrollTo(0, msgContainer.scrollHeight);
  }, 50);
}

function addUserMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="msg-bubble">${escHtml(text)}</div>`;
  msgContainer.appendChild(div);
  msgContainer.scrollTo(0, msgContainer.scrollHeight);
}

function getOrCreateAssistantMsg() {
  const last = msgContainer.lastElementChild;
  if (last && last.dataset.streaming === 'true') return last.querySelector('.msg-bubble');
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.dataset.streaming = 'true';
  div.dataset.raw = '';
  div.innerHTML = `<div class="msg-bubble"></div>`;
  msgContainer.appendChild(div);
  scrollBottom();
  return div.querySelector('.msg-bubble');
}

function finalizeAssistantMsg() {
  const last = msgContainer.lastElementChild;
  if (last && last.dataset.streaming === 'true') {
    last.dataset.streaming = 'false';
    const raw = last.dataset.raw || '';
    if (raw) {
      const bubble = last.querySelector('.msg-bubble');
      bubble.innerHTML = marked.parse(raw);
      bubble.querySelectorAll('pre code').forEach(block => {
        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = 'Copy';
        btn.onclick = (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(block.textContent).then(() => {
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
          });
        };
        block.parentElement.style.position = 'relative';
        block.parentElement.appendChild(btn);
      });
    }
  }
}

function addToolRequest(id, name, inputData) {
  // Bridge mode: show tool calls as info-only (Claude Code executes internally)
  if (currentMode === 'bridge') {
    const icons = { Bash: '⟩', Read: '📄', Edit: '✏️', Write: '📝', Grep: '🔍', Glob: '📁', run_command: '⟩', read_file: '📄', edit_file: '✏️', write_file: '📝', search_files: '🔍', list_directory: '📁' };
    const div = document.createElement('div');
    div.className = 'tool-card resolved';
    div.innerHTML = `
      <div class="tool-header">
        <span>${icons[name] || '🔧'}</span>
        <span class="tool-name">${escHtml(name)}</span>
        <span class="tool-badge" style="background:#7c3aed;color:#fff">CC</span>
      </div>
      <div class="tool-params" style="max-height:60px;overflow:hidden">${escHtml(summarizeInput(name, inputData))}</div>
    `;
    msgContainer.appendChild(div);
    scrollBottom();
    return;
  }

  if (autoApprove[name]) {
    ws.send(JSON.stringify({ type: 'tool_decision', id, approved: true }));
    const div = document.createElement('div');
    div.className = 'tool-card resolved';
    div.innerHTML = `
      <div class="tool-header">
        <span class="tool-name">${escHtml(name)}</span>
        <span class="tool-badge approved">auto</span>
      </div>
      <div class="tool-params" style="max-height:40px;overflow:hidden">${escHtml(summarizeInput(name, inputData))}</div>
    `;
    msgContainer.appendChild(div);
    scrollBottom();
    return;
  }

  // Needs manual approval — alert the user
  playApprovalSound();
  vibrate([100, 50, 100]);

  const icons = { run_command: '⟩', read_file: '📄', edit_file: '✏️', write_file: '📝', search_files: '🔍', list_directory: '📁' };
  const div = document.createElement('div');
  div.className = 'tool-card';
  div.id = 'tool-' + id;
  // Build params display — use diff viewer for edits
  let paramsHtml;
  if ((name === 'edit_file' || name === 'Edit') && inputData.old_text && inputData.new_text) {
    paramsHtml = `<div class="tool-params" style="padding:0"><div style="padding:4px 12px;color:var(--text-muted);font-size:calc(11px * var(--zoom))">${escHtml(inputData.path || inputData.file_path || '')}</div>${renderDiff(inputData.old_text, inputData.new_text)}</div>`;
  } else if (name === 'write_file' || name === 'Write') {
    const content = inputData.content || '';
    const preview = content.length > 500 ? content.slice(0, 500) + '\n...' : content;
    paramsHtml = `<div class="tool-params"><strong>${escHtml(inputData.path || inputData.file_path || '')}</strong>\n${escHtml(preview)}</div>`;
  } else {
    paramsHtml = `<div class="tool-params">${escHtml(JSON.stringify(inputData, null, 2))}</div>`;
  }

  div.innerHTML = `
    <div class="tool-header">
      <span>${icons[name] || '🔧'}</span>
      <span class="tool-name">${escHtml(name)}</span>
    </div>
    ${paramsHtml}
    <div class="tool-buttons">
      <button class="tool-btn deny" onclick="toolDecision('${id}', false)">Deny</button>
      <button class="tool-btn approve" onclick="toolDecision('${id}', true)">Approve</button>
    </div>
  `;
  msgContainer.appendChild(div);
  msgContainer.scrollTo(0, msgContainer.scrollHeight);
}

function summarizeInput(name, input) {
  if (name === 'read_file' || name === 'Read') return input.path || input.file_path || '';
  if (name === 'list_directory') return input.path || '.';
  if (name === 'search_files' || name === 'Grep') return `"${input.pattern}" in ${input.path || '.'}`;
  if (name === 'Glob') return input.pattern || '';
  if (name === 'Bash') return input.command || '';
  if (name === 'Edit') return input.file_path || '';
  if (name === 'Write') return input.file_path || '';
  if (name === 'Agent') return input.description || input.prompt?.slice(0, 80) || '';
  return JSON.stringify(input).slice(0, 200);
}

function addToolResult(output, error) {
  const div = document.createElement('div');
  const isError = !!error;
  const text = error ? `Error: ${error}\n${output}` : output;
  const truncated = text.length > 300;
  div.className = `tool-result ${isError ? 'error' : 'success'} ${truncated ? 'collapsed' : ''}`;
  div.innerHTML = `<div class="tool-result-label">${isError ? 'Error' : 'Result'}${truncated ? ' (tap to expand)' : ''}</div>${escHtml(text)}`;
  if (truncated) {
    div.addEventListener('click', () => div.classList.toggle('collapsed'));
  }
  msgContainer.appendChild(div);
  scrollBottom();
}

function addSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.innerHTML = `<div class="msg-bubble" style="background:var(--surface-light);border:1px solid var(--border);color:var(--text-muted);font-size:12px;text-align:center;max-width:100%;margin:0 auto">${escHtml(text)}</div>`;
  msgContainer.appendChild(div);
  scrollBottom();
}

function addErrorMsg(text) {
  playErrorSound();
  vibrate(200);
  const div = document.createElement('div');
  div.className = 'msg error';
  div.innerHTML = `<div class="msg-bubble">${escHtml(text)}</div>`;
  msgContainer.appendChild(div);
  msgContainer.scrollTo(0, msgContainer.scrollHeight);
}

window.toolDecision = function(id, approved) {
  if (!ws) return;
  vibrate(30);
  ws.send(JSON.stringify({ type: 'tool_decision', id, approved }));
  const card = document.getElementById('tool-' + id);
  if (card) {
    card.classList.add('resolved');
    const btns = card.querySelector('.tool-buttons');
    if (btns) {
      btns.innerHTML = `<span class="tool-badge ${approved ? 'approved' : 'denied'}" style="margin:10px auto">${approved ? 'approved' : 'denied'}</span>`;
    }
  }
};

function sendMessage() {
  const text = input.value.trim();
  if (!text || !connected) return;
  addUserMsg(text);
  ws.send(JSON.stringify({ type: 'message', content: text, token: authToken }));
  input.value = '';
  input.style.height = 'auto';
  sendBtn.disabled = true;
}

// Workspace selector
wsSelect.addEventListener('change', () => {
  const val = wsSelect.value;
  if (!val || !ws) return;
  ws.send(JSON.stringify({ type: 'set_workspace', path: val, token: authToken }));
  localStorage.setItem('mc_workspace', val);
});

// Upload
uploadBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  if (!fileInput.files.length || !ws) return;
  for (const file of fileInput.files) {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      ws.send(JSON.stringify({ type: 'upload_file', filename: file.name, data: base64, token: authToken }));
    };
    reader.readAsDataURL(file);
  }
  fileInput.value = '';
});

function requestWorkspaces() {
  if (ws && connected) {
    ws.send(JSON.stringify({ type: 'list_workspaces', token: authToken }));
  }
}

function connect() {
  if (ws) { ws.close(); ws = null; }
  if (!serverUrl) {
    settingsModal.classList.add('open');
    return;
  }

  setStatus('', 'connecting...');
  ws = new WebSocket(serverUrl);

  ws.onopen = () => {
    connected = true;
    reconnectAttempts = 0;
    setStatus('connected', 'connected');
    sendBtn.disabled = !input.value.trim();
    wsSelect.disabled = false;
    requestWorkspaces();
    updateModeUI();
    ws.send(JSON.stringify({ type: 'set_mode', mode: currentMode, token: authToken }));
    showDashboard();
  };

  ws.onclose = (e) => {
    connected = false;
    sendBtn.disabled = true;
    wsSelect.disabled = true;
    // Smart reconnect with exponential backoff
    reconnectAttempts++;
    const delay = Math.min(2000 * Math.pow(1.5, reconnectAttempts - 1), 30000);
    const delaySec = Math.round(delay / 1000);
    setStatus('', 'reconnecting in ' + delaySec + 's...');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  };

  ws.onerror = () => {
    // onclose will fire after this — don't duplicate handling
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    switch (msg.type) {
      case 'text_delta': {
        const bubble = getOrCreateAssistantMsg();
        const parent = bubble.closest('.msg');
        parent.dataset.raw = (parent.dataset.raw || '') + msg.content;
        bubble.textContent = parent.dataset.raw;
        scrollBottom();
        break;
      }
      case 'text_done': {
        finalizeAssistantMsg();
        break;
      }
      case 'tool_request': {
        finalizeAssistantMsg();
        addToolRequest(msg.id, msg.name, msg.input);
        sendPushNotification('Approval Needed', `${msg.name}: ${summarizeInput(msg.name, msg.input).slice(0, 80)}`);
        break;
      }
      case 'tool_result': {
        addToolResult(msg.output, msg.error);
        break;
      }
      case 'error': {
        addErrorMsg(msg.message);
        break;
      }
      case 'workspaces': {
        wsSelect.innerHTML = '';
        const saved = localStorage.getItem('mc_workspace');
        msg.list.forEach(w => {
          const opt = document.createElement('option');
          opt.value = w.path;
          opt.textContent = w.name;
          if (w.path === msg.current || w.path === saved) opt.selected = true;
          wsSelect.appendChild(opt);
        });
        if (saved && saved !== msg.current) {
          ws.send(JSON.stringify({ type: 'set_workspace', path: saved, token: authToken }));
        }
        break;
      }
      case 'workspace_changed': {
        wsSelect.value = msg.path;
        addSystemMsg('Workspace: ' + msg.name);
        break;
      }
      case 'upload_complete': {
        addSystemMsg('Uploaded: ' + msg.filename);
        break;
      }
      case 'voice_memo_result': {
        if (msg.success) {
          addSystemMsg('Blog topic created: "' + msg.title + '" → topics/' + msg.filename + ' (cluster: ' + msg.cluster + ')');
          playDoneSound();
          vibrate([50, 30, 50]);
          vmModal.classList.remove('open');
        } else {
          addErrorMsg('Voice memo failed: ' + msg.error);
          playErrorSound();
          vmSendBtn.disabled = false;
          vmSendBtn.textContent = '📤 Create Topic';
          vmStatus.textContent = 'Failed — try again or edit transcript';
        }
        break;
      }
      case 'mode_changed': {
        const wasManualSwitch = currentMode !== msg.mode;
        currentMode = msg.mode;
        localStorage.setItem('mc_mode', currentMode);
        updateModeUI();
        if (wasManualSwitch) {
          msgContainer.innerHTML = '';
          addSystemMsg('Mode: ' + (currentMode === 'bridge' ? 'Claude Code Bridge' : 'Direct API'));
        }
        break;
      }
      case 'cost_update': {
        sessionCost += msg.cost_usd;
        updateCostDisplay();
        break;
      }
      case 'status': {
        agentState = msg.state;
        if (connected) {
          if (msg.state === 'thinking') setStatus('thinking', 'thinking...');
          else if (msg.state === 'awaiting_approval') setStatus('awaiting', 'waiting for approval');
          else {
            setStatus('connected', 'connected');
            // Play done sound when transitioning from thinking to idle
            if (msg.state === 'idle' && agentState !== 'idle') {
              playDoneSound();
              vibrate(50);
              sendPushNotification('Task Complete', 'Claude has finished processing');
            }
          }
        }
        sendBtn.disabled = msg.state === 'thinking' || !connected;
        break;
      }
      case 'cc_sessions': {
        renderSessionsList(msg.sessions);
        break;
      }
      case 'session_imported': {
        addSystemMsg('Imported session: ' + msg.conversation.messageCount + ' messages');
        break;
      }
      case 'conversation_loaded': {
        // Display imported conversation messages
        msgContainer.innerHTML = '';
        const conv = msg.conversation;
        for (const m of conv.messages || []) {
          if (m.role === 'user') {
            const div = document.createElement('div');
            div.className = 'msg user';
            div.innerHTML = '<div class="bubble user-bubble">' + escHtml(m.content) + '</div>';
            msgContainer.appendChild(div);
          } else if (m.role === 'assistant') {
            const div = document.createElement('div');
            div.className = 'msg assistant';
            div.innerHTML = '<div class="bubble assistant-bubble">' + marked.parse(m.content) + '</div>';
            msgContainer.appendChild(div);
          }
        }
        scrollBottom();
        $('#sessions-modal').classList.remove('open');
        $('#history-modal').classList.remove('open');
        playDoneSound();
        break;
      }
    }
  };
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Service Worker (PWA) ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => {
    console.log('SW registered');
  }).catch(e => console.warn('SW registration failed:', e));
}

// ── Push Notifications ──
async function requestPushPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function sendPushNotification(title, body) {
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return; // Don't notify if app is in foreground
  try {
    new Notification(title, { body, icon: '/icon.svg', vibrate: [100, 50, 100] });
  } catch(e) {
    // Fallback for mobile where Notification constructor may not work
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'show-notification', title, body });
    }
  }
}

// Request permission on first interaction
document.addEventListener('click', () => requestPushPermission(), { once: true });

// ── Session Cost Tracker ──
let sessionCost = 0;
let sessionStartTime = Date.now();

function updateCostDisplay() {
  let costEl = document.getElementById('cost-display');
  if (!costEl) {
    costEl = document.createElement('span');
    costEl.id = 'cost-display';
    costEl.style.cssText = 'color:var(--text-muted);font-size:calc(10px * var(--zoom));cursor:pointer;white-space:nowrap';
    costEl.title = 'Session API cost';
    costEl.addEventListener('click', () => {
      const elapsed = Math.floor((Date.now() - sessionStartTime) / 60000);
      addSystemMsg(`Session: $${sessionCost.toFixed(4)} | ${elapsed}min`);
    });
    const statusBar = document.getElementById('status-bar');
    if (statusBar) statusBar.insertBefore(costEl, statusBar.querySelector('.bar-btn'));
  }
  costEl.textContent = sessionCost > 0 ? `$${sessionCost.toFixed(4)}` : '';
}

// ── Conversation Persistence ──
const HISTORY_KEY = 'mc_chat_history';
const MAX_SAVED_MESSAGES = 100;

function saveConversation() {
  try {
    const msgs = [];
    msgContainer.querySelectorAll('.msg, .system-msg').forEach(el => {
      if (msgs.length >= MAX_SAVED_MESSAGES) return;
      msgs.push({ html: el.outerHTML });
    });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(msgs));
  } catch(e) {} // localStorage full — silently fail
}

function restoreConversation() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (saved.length === 0) return;
    // Add a session divider
    const divider = document.createElement('div');
    divider.className = 'system-msg';
    divider.style.borderTop = '1px solid var(--border)';
    divider.style.paddingTop = '8px';
    divider.style.marginTop = '8px';
    divider.textContent = 'Previous session';
    msgContainer.appendChild(divider);
    saved.forEach(m => {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = m.html;
      const el = wrapper.firstElementChild;
      if (el) {
        // Disable any old approval buttons
        el.querySelectorAll('.tool-btn').forEach(btn => { btn.disabled = true; btn.style.opacity = '0.3'; });
        msgContainer.appendChild(el);
      }
    });
    scrollBottom();
  } catch(e) {}
}

// Restore on load
restoreConversation();

// Save periodically and on page hide
setInterval(saveConversation, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveConversation();
});

// ── Diff Viewer for Edit Approvals ──
function renderDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  let html = '<div class="diff-view">';
  // Simple line-by-line diff
  const maxLines = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine !== undefined && (newLine === undefined || oldLine !== newLine)) {
      html += `<div class="diff-del">- ${escHtml(oldLine)}</div>`;
    }
    if (newLine !== undefined && (oldLine === undefined || oldLine !== newLine)) {
      html += `<div class="diff-add">+ ${escHtml(newLine)}</div>`;
    }
    if (oldLine !== undefined && newLine !== undefined && oldLine === newLine) {
      html += `<div class="diff-ctx">  ${escHtml(oldLine)}</div>`;
    }
  }
  html += '</div>';
  return html;
}

// ── Project Dashboard ──
async function showDashboard() {
  try {
    // Version check — auto-reload if client is stale
    const httpUrl = location.origin;
    try {
      const healthResp = await fetch(`${httpUrl}/health`);
      const health = await healthResp.json();
      if (health.version && health.version !== CLIENT_VERSION) {
        console.log('Version mismatch: client=' + CLIENT_VERSION + ' server=' + health.version + ' — reloading');
        // Clear SW cache and reload
        if ('caches' in window) {
          const keys = await caches.keys();
          for (const k of keys) await caches.delete(k);
        }
        window.location.reload(true);
        return;
      }
    } catch(e) { /* offline or health failed, continue */ }

    const resp = await fetch(`${httpUrl}/api/dashboard?token=${encodeURIComponent(authToken)}`);
    if (!resp.ok) return;
    const data = await resp.json();
    const card = document.createElement('div');
    card.className = 'dashboard-card';
    card.innerHTML = `
      <div class="dash-title">
        <span>${escHtml(data.workspace)}</span>
        <button class="dash-close" onclick="this.closest('.dashboard-card').remove()">&times;</button>
      </div>
      ${data.git.branch ? `<div class="dash-row"><span>Branch</span><span>${escHtml(data.git.branch)}</span></div>` : ''}
      <div class="dash-row"><span>Uptime</span><span>${Math.floor(data.uptime / 60)}m</span></div>
      ${data.git.status ? `<div class="dash-status">${escHtml(data.git.status)}</div>` : '<div style="color:var(--green);font-size:calc(11px * var(--zoom));margin-top:4px">Working tree clean</div>'}
    `;
    msgContainer.prepend(card);
  } catch(e) { console.warn('Dashboard fetch failed:', e); }
}

// ── File Browser ──
const fileDrawerHtml = `
<div id="file-drawer">
  <div id="file-drawer-header">
    <button id="fd-back">&larr;</button>
    <span id="file-drawer-path">.</span>
    <button id="fd-ask">Ask Claude</button>
    <button id="fd-close">&times;</button>
  </div>
  <div id="file-drawer-content"></div>
</div>`;
document.body.insertAdjacentHTML('beforeend', fileDrawerHtml);

let fdCurrentPath = '.';
let fdViewingFile = null;

async function fdNavigate(relPath) {
  const httpUrl = location.origin;
  try {
    const resp = await fetch(`${httpUrl}/api/files?token=${encodeURIComponent(authToken)}&path=${encodeURIComponent(relPath)}`);
    if (!resp.ok) throw new Error('Failed to load');
    const data = await resp.json();
    const content = document.getElementById('file-drawer-content');
    document.getElementById('file-drawer-path').textContent = relPath || '.';

    if (data.type === 'directory') {
      fdCurrentPath = relPath;
      fdViewingFile = null;
      content.innerHTML = data.items.map(item => `
        <div class="file-item" data-path="${escHtml(relPath === '.' ? item.name : relPath + '/' + item.name)}" data-type="${item.type}">
          <span class="fi-icon">${item.type === 'dir' ? '📁' : '📄'}</span>
          <span class="fi-name">${escHtml(item.name)}</span>
          ${item.size !== undefined ? `<span class="fi-size">${(item.size / 1024).toFixed(1)}k</span>` : ''}
        </div>
      `).join('');
      content.querySelectorAll('.file-item').forEach(el => {
        el.addEventListener('click', () => fdNavigate(el.dataset.path));
      });
    } else {
      fdViewingFile = relPath;
      content.innerHTML = `<div class="file-preview">${escHtml(data.content)}</div>`;
    }
  } catch(e) {
    document.getElementById('file-drawer-content').innerHTML = `<div style="padding:20px;color:var(--red)">${escHtml(String(e))}</div>`;
  }
}

$('#files-btn').addEventListener('click', () => {
  document.getElementById('file-drawer').classList.add('open');
  fdNavigate('.');
});

document.getElementById('fd-close').addEventListener('click', () => {
  document.getElementById('file-drawer').classList.remove('open');
});

document.getElementById('fd-back').addEventListener('click', () => {
  if (fdViewingFile) {
    fdNavigate(fdCurrentPath);
  } else if (fdCurrentPath !== '.') {
    const parent = fdCurrentPath.includes('/') ? fdCurrentPath.split('/').slice(0, -1).join('/') : '.';
    fdNavigate(parent);
  } else {
    document.getElementById('file-drawer').classList.remove('open');
  }
});

document.getElementById('fd-ask').addEventListener('click', () => {
  if (fdViewingFile && ws && connected) {
    document.getElementById('file-drawer').classList.remove('open');
    const input = document.getElementById('msg-input');
    input.value = `Read and explain the file ${fdViewingFile}`;
    input.focus();
  }
});

// ── Chat History ──
function loadHistory() {
  const modal = $('#history-modal');
  modal.classList.add('open');
  const list = $('#history-list');
  list.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px">Loading...</div>';

  const httpUrl = location.origin || serverUrl.replace('ws://', 'http://').replace('wss://', 'https://');
  fetch(httpUrl + '/api/conversations?token=' + encodeURIComponent(authToken))
    .then(r => r.json())
    .then(d => {
      const convs = d.conversations || [];
      if (convs.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px">No saved conversations yet.</div>';
        return;
      }
      list.innerHTML = '';
      for (const c of convs) {
        const card = document.createElement('div');
        card.className = 'session-card';
        const mode = c.mode === 'bridge' ? 'CC' : 'API';
        const modeColor = c.mode === 'bridge' ? 'var(--accent-blue)' : 'var(--accent-gold)';
        const ago = timeAgo(new Date(c.updated));
        card.innerHTML =
          '<div class="sc-project"><span style="color:' + modeColor + '">' + mode + '</span> ' + escHtml(c.workspace.split(/[/\\]/).pop() || 'unknown') + '</div>' +
          '<div class="sc-preview">' + escHtml(c.preview) + '</div>' +
          '<div class="sc-meta">' + c.messageCount + ' messages · ' + ago + '</div>';
        card.addEventListener('click', () => {
          card.classList.add('importing');
          card.querySelector('.sc-meta').textContent = 'Loading...';
          if (ws && connected) {
            ws.send(JSON.stringify({ type: 'load_conversation', id: c.id, token: authToken }));
          }
        });
        list.appendChild(card);
      }
    })
    .catch(() => {
      list.innerHTML = '<div style="color:var(--red);text-align:center;padding:20px">Failed to load history.</div>';
    });
}

$('#history-back-btn').addEventListener('click', () => {
  $('#history-modal').classList.remove('open');
});

// ── Sessions Import ──
function loadSessions() {
  $('#sessions-list').innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px">Loading sessions...</div>';
  if (ws && connected) {
    ws.send(JSON.stringify({ type: 'list_cc_sessions', token: authToken }));
  } else {
    // Fallback: try REST API
    const httpUrl = serverUrl.replace('ws://', 'http://').replace('wss://', 'https://');
    fetch(httpUrl.replace(/\/$/, '') + '/api/sessions?token=' + encodeURIComponent(authToken))
      .then(r => r.json())
      .then(d => renderSessionsList(d.sessions))
      .catch(() => {
        $('#sessions-list').innerHTML = '<div style="color:var(--red);text-align:center;padding:20px">Failed to load sessions. Connect first.</div>';
      });
  }
}

$('#sessions-btn').addEventListener('click', () => {
  $('#sessions-modal').classList.add('open');
  loadSessions();
});

// Clear cache button in settings
$('#clear-cache-btn').addEventListener('click', async () => {
  const btn = $('#clear-cache-btn');
  btn.textContent = 'Clearing...';
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
    btn.textContent = 'Done! Reloading...';
    setTimeout(() => window.location.reload(true), 500);
  } catch(e) {
    btn.textContent = 'Error: ' + e.message;
  }
});

$('#sessions-back-btn').addEventListener('click', () => {
  $('#sessions-modal').classList.remove('open');
});

let allSessions = [];

function renderSessionsList(sessions) {
  allSessions = sessions || [];
  filterAndDisplaySessions();
}

// Filter change handler
document.addEventListener('change', function(e) {
  if (e.target && e.target.id === 'sessions-filter') filterAndDisplaySessions();
});

function filterAndDisplaySessions() {
  const list = $('#sessions-list');
  const filter = ($('#sessions-filter') || {}).value || 'all';
  const currentWs = (wsSelect && wsSelect.value) ? wsSelect.value.replace(/\\/g, '/').toLowerCase() : '';

  let filtered = allSessions;
  if (filter === 'current' && currentWs) {
    filtered = allSessions.filter(s => {
      const sp = (s.projectPath || '').replace(/\\/g, '/').toLowerCase();
      return sp.includes(currentWs.split('/').pop()) || currentWs.includes(sp.split('/').pop());
    });
  } else if (filter === 'recent') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    filtered = allSessions.filter(s => new Date(s.timestamp) >= today);
  }

  if (!filtered || filtered.length === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px">No sessions found.</div>';
    return;
  }
  list.innerHTML = '';
  // Show up to 50
  for (const s of filtered.slice(0, 50)) {
    const card = document.createElement('div');
    card.className = 'session-card';
    const ago = timeAgo(new Date(s.timestamp));
    // Show full project path for clarity
    const projectDisplay = (s.projectPath || s.project || '').replace(/\\/g, '/').split('/').slice(-2).join('/');
    card.innerHTML =
      '<div class="sc-project">' + escHtml(projectDisplay) + '</div>' +
      '<div class="sc-preview">' + escHtml(s.firstMessage) + '</div>' +
      '<div class="sc-meta">' + s.messageCount + ' messages · ' + ago + '</div>';
    card.addEventListener('click', () => {
      card.classList.add('importing');
      card.querySelector('.sc-meta').textContent = 'Importing...';
      if (ws && connected) {
        ws.send(JSON.stringify({ type: 'import_cc_session', sessionId: s.sessionId, token: authToken }));
      }
    });
    list.appendChild(card);
  }
}

function timeAgo(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  return days + 'd ago';
}

// ── First-run Onboarding ──
const onboardingModal = $('#onboarding-modal');

async function checkSetupAndConnect() {
  try {
    const resp = await fetch('/api/setup/status');
    const data = await resp.json();

    if (!data.configured) {
      // Show onboarding wizard instead of settings
      onboardingModal.classList.add('open');
      initOnboarding(data);
      return;
    }

    // Already configured — normal flow
    if (serverUrl) {
      connect();
    } else {
      settingsModal.classList.add('open');
    }
  } catch (e) {
    // Fetch failed (e.g. loading from file:// or different origin) — fall back to old behavior
    if (serverUrl) connect();
    else settingsModal.classList.add('open');
  }
}

function initOnboarding(statusData) {
  const goBtn = $('#setup-go-btn');
  const statusEl = $('#setup-status');
  const step1 = $('#setup-step-1');
  const step2 = $('#setup-step-2');
  const apiKeyInput = $('#setup-api-key');
  const openaiKeyInput = $('#setup-openai-key');

  goBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey || !apiKey.startsWith('sk-')) {
      statusEl.textContent = 'Enter a valid API key (starts with sk-)';
      statusEl.style.color = 'var(--red)';
      return;
    }

    goBtn.disabled = true;
    goBtn.textContent = 'Setting up...';
    statusEl.textContent = '';

    try {
      const body = { apiKey };
      const openaiKey = openaiKeyInput.value.trim();
      if (openaiKey && openaiKey.startsWith('sk-')) {
        body.openaiKey = openaiKey;
      }

      const resp = await fetch('/api/setup/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const result = await resp.json();

      if (!resp.ok) {
        throw new Error(result.error || 'Setup failed');
      }

      // Success — save connection settings
      const wsUrl = result.wsUrl;
      const token = result.token;

      localStorage.setItem('mc_url', wsUrl);
      localStorage.setItem('mc_token', token);
      serverUrl = wsUrl;
      authToken = token;

      // Update settings form fields too
      $('#set-url').value = wsUrl;
      $('#set-token').value = token;

      // Show step 2
      step1.style.display = 'none';
      step2.style.display = 'block';
      $('#setup-token-display').textContent = token;

    } catch (err) {
      goBtn.disabled = false;
      goBtn.textContent = 'Set Up';
      statusEl.textContent = err.message;
      statusEl.style.color = 'var(--red)';
    }
  });

  // Allow Enter key on API key input to trigger setup
  apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goBtn.click();
  });
  openaiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goBtn.click();
  });

  // Copy token button
  $('#setup-copy-btn').addEventListener('click', () => {
    const token = $('#setup-token-display').textContent;
    navigator.clipboard.writeText(token).then(() => {
      $('#setup-copy-btn').textContent = 'Copied!';
      $('#setup-copy-btn').style.color = 'var(--green)';
      $('#setup-copy-btn').style.borderColor = 'var(--green)';
      setTimeout(() => {
        $('#setup-copy-btn').textContent = 'Copy Token';
        $('#setup-copy-btn').style.color = '';
        $('#setup-copy-btn').style.borderColor = '';
      }, 2000);
    });
  });

  // Connect now button
  $('#setup-connect-btn').addEventListener('click', () => {
    onboardingModal.classList.remove('open');
    connect();
  });
}

// Auto-connect (with setup check)
checkSetupAndConnect();