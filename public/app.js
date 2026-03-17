const state = {
  messages: [],
  sessionId: "",
  files: [],
  uploadedFileUrls: [],
  isStreaming: false,
  currentController: null,
  lastUserMessage: "",
};

const elements = {
  viewport: document.querySelector("#messageViewport"),
  composerForm: document.querySelector("#composerForm"),
  promptInput: document.querySelector("#promptInput"),
  sendBtn: document.querySelector("#sendBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  newChatBtn: document.querySelector("#newChatBtn"),
  retryBtn: document.querySelector("#retryBtn"),
  fileInput: document.querySelector("#fileInput"),
  attachmentList: document.querySelector("#attachmentList"),
  configStatus: document.querySelector("#configStatus"),
  template: document.querySelector("#messageTemplate"),
};

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMessageContent(content) {
  return escapeHtml(content).replace(/\n/g, "<br />");
}

function scrollToBottom() {
  elements.viewport.scrollTop = elements.viewport.scrollHeight;
}

function autoResizeTextarea() {
  elements.promptInput.style.height = "auto";
  elements.promptInput.style.height = `${Math.min(elements.promptInput.scrollHeight, 220)}px`;
}

function renderConfigStatus(config) {
  const isHealthy = Boolean(config.appConfigured);
  elements.configStatus.innerHTML = `<div>${isHealthy ? "连接正常" : "连接异常"}</div>`;
}

function createMessage(role, content, extraClass = "") {
  const node = elements.template.content.firstElementChild.cloneNode(true);
  node.classList.add(role);
  if (extraClass) {
    node.classList.add(extraClass);
  }
  node.querySelector(".message-role").textContent = role === "user" ? "用户" : "智能体";
  node.querySelector(".message-body").innerHTML = formatMessageContent(content);

  node.querySelector(".copy-button").addEventListener("click", async () => {
    const text = node.querySelector(".message-body").textContent || "";
    await navigator.clipboard.writeText(text);
  });

  elements.viewport.appendChild(node);
  scrollToBottom();
  return node;
}

function updateAttachmentList() {
  if (!state.files.length) {
    elements.attachmentList.classList.add("empty");
    elements.attachmentList.innerHTML = "<span>暂无附件</span>";
    return;
  }

  elements.attachmentList.classList.remove("empty");
  elements.attachmentList.innerHTML = "";
  state.files.forEach((file, index) => {
    const pill = document.createElement("div");
    pill.className = "attachment-pill";
    pill.innerHTML = `
      <span>${escapeHtml(file.name)} · ${(file.size / 1024 / 1024).toFixed(2)} MB</span>
      <button type="button" aria-label="删除附件">×</button>
    `;
    pill.querySelector("button").addEventListener("click", () => {
      state.files.splice(index, 1);
      updateAttachmentList();
    });
    elements.attachmentList.appendChild(pill);
  });
}

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    renderConfigStatus(data);
  } catch {
    elements.configStatus.textContent = "配置检测失败，请检查服务端。";
  }
}

async function uploadFilesIfNeeded() {
  if (!state.files.length) {
    return [];
  }

  const uploads = state.files.map(async (file) => {
    const formData = new FormData();
    formData.append("files", file);

    const res = await fetch("/api/files/upload", {
      method: "POST",
      body: formData,
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "文件上传失败");
    }

    return data.fileUrls || [];
  });

  const results = await Promise.all(uploads);
  return results.flat();
}

function setStreamingState(active) {
  state.isStreaming = active;
  elements.sendBtn.disabled = active;
  elements.stopBtn.disabled = !active;
  elements.retryBtn.disabled = active || !state.lastUserMessage;
  elements.promptInput.disabled = active;
}

function resetSession() {
  state.messages = [];
  state.sessionId = "";
  state.files = [];
  state.uploadedFileUrls = [];
  state.lastUserMessage = "";
  elements.viewport.innerHTML = `
    <div class="welcome-card">
      <p class="eyebrow">Session Zero</p>
      <h3>新会话已准备好</h3>
      <p>当前页面不做长期存储，新的对话上下文会从这里重新开始。</p>
      <div class="welcome-tags">
        <span>临时会话</span>
        <span>实时响应</span>
        <span>无本地持久化</span>
      </div>
    </div>
  `;
  updateAttachmentList();
}

async function streamChat() {
  const content = elements.promptInput.value.trim();
  if (!content || state.isStreaming) {
    return;
  }

  state.lastUserMessage = content;
  const filesSnapshot = [...state.files];
  const messageHistory = [...state.messages, { role: "user", content }];

  createMessage("user", content);
  state.messages = messageHistory;
  elements.promptInput.value = "";
  autoResizeTextarea();
  setStreamingState(true);

  let assistantText = "";
  const assistantNode = createMessage("assistant", "正在火速生成立项报告中...", "typing");
  const assistantBody = assistantNode.querySelector(".message-body");

  try {
    state.uploadedFileUrls = filesSnapshot.length ? await uploadFilesIfNeeded() : [];
    state.files = [];
    updateAttachmentList();

    const controller = new AbortController();
    state.currentController = controller;

    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: messageHistory,
        sessionId: state.sessionId,
        fileUrls: state.uploadedFileUrls,
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "会话请求失败");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const eventChunk of events) {
        const lines = eventChunk.split(/\r?\n/);
        let eventName = "message";
        const dataLines = [];

        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          }
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }

        if (!dataLines.length) {
          continue;
        }

        const payload = JSON.parse(dataLines.join("\n"));

        if (eventName === "error") {
          throw new Error(payload.error || "流式响应失败");
        }

        if (payload.sessionId) {
          state.sessionId = payload.sessionId;
        }

        if (typeof payload.text === "string" && payload.text) {
          assistantNode.classList.remove("typing");
          assistantText += payload.text;
          assistantBody.innerHTML = formatMessageContent(assistantText);
          scrollToBottom();
        }
      }
    }

    if (!assistantText.trim()) {
      assistantNode.classList.remove("typing");
      assistantText = "本次调用已完成，但百炼没有返回可显示文本。";
      assistantBody.innerHTML = formatMessageContent(assistantText);
    }

    state.messages.push({ role: "assistant", content: assistantText });
  } catch (error) {
    assistantNode.classList.remove("typing");
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `${assistantText || "本次生成"}已停止。`
        : error instanceof Error
          ? error.message
          : "请求失败，请稍后重试。";

    if (error instanceof Error && error.name === "AbortError" && assistantText) {
      assistantBody.innerHTML = formatMessageContent(assistantText);
      state.messages.push({ role: "assistant", content: assistantText });
    } else {
      assistantNode.classList.add("error");
      assistantBody.innerHTML = formatMessageContent(message);
    }
  } finally {
    state.currentController = null;
    setStreamingState(false);
  }
}

async function retryLastTurn() {
  if (!state.lastUserMessage || state.isStreaming) {
    return;
  }

  if (state.messages.at(-1)?.role === "assistant") {
    state.messages.pop();
  }

  elements.promptInput.value = state.lastUserMessage;
  autoResizeTextarea();
  await streamChat();
}

elements.composerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await streamChat();
});

elements.promptInput.addEventListener("input", autoResizeTextarea);
elements.promptInput.addEventListener("keydown", async (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    await streamChat();
  }
});

elements.stopBtn.addEventListener("click", () => {
  state.currentController?.abort();
});

elements.newChatBtn.addEventListener("click", resetSession);
elements.retryBtn.addEventListener("click", retryLastTurn);

elements.fileInput.addEventListener("change", (event) => {
  const input = event.currentTarget;
  state.files = [...state.files, ...Array.from(input.files || [])].slice(0, 6);
  input.value = "";
  updateAttachmentList();
});

loadConfig();
updateAttachmentList();
autoResizeTextarea();
setStreamingState(false);
