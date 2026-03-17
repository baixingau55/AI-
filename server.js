import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 6,
  },
});

const PORT = Number(process.env.PORT || 3000);
const BAILIAN_API_KEY = process.env.BAILIAN_API_KEY;
const BAILIAN_APP_ID = process.env.BAILIAN_APP_ID;
const BAILIAN_APP_URL = "https://dashscope.aliyuncs.com/api/v1/apps";
const BAILIAN_WORKSPACE_ID = process.env.BAILIAN_WORKSPACE_ID;
const BAILIAN_UPLOAD_POLICY_URL = "https://dashscope.aliyuncs.com/api/v1/uploads";
const BAILIAN_FILE_UPLOAD_MODEL = process.env.BAILIAN_FILE_UPLOAD_MODEL || "qwen-vl-plus";

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function requireChatConfig(res) {
  if (!BAILIAN_API_KEY || !BAILIAN_APP_ID) {
    res.status(500).json({
      error: "Missing BAILIAN_API_KEY or BAILIAN_APP_ID in environment variables.",
    });
    return false;
  }
  return true;
}

function hasUploadConfig() {
  return Boolean(BAILIAN_API_KEY);
}

function requireUploadConfig(res) {
  if (!hasUploadConfig()) {
    res.status(501).json({
      error: "File upload requires a valid BAILIAN_API_KEY.",
    });
    return false;
  }
  return true;
}

function formatDetailedError(error) {
  if (!error || typeof error !== "object") {
    return "Unknown error";
  }

  const anyError = error;
  const parts = [];

  if (anyError.message) {
    parts.push(String(anyError.message));
  }
  if (anyError.code) {
    parts.push(`code=${String(anyError.code)}`);
  }
  if (anyError.statusCode) {
    parts.push(`statusCode=${String(anyError.statusCode)}`);
  }
  if (anyError.requestId) {
    parts.push(`requestId=${String(anyError.requestId)}`);
  }
  if (anyError.data && typeof anyError.data === "object") {
    if (anyError.data.Code) {
      parts.push(`data.Code=${String(anyError.data.Code)}`);
    }
    if (anyError.data.Message) {
      parts.push(`data.Message=${String(anyError.data.Message)}`);
    }
    if (anyError.data.RequestId) {
      parts.push(`data.RequestId=${String(anyError.data.RequestId)}`);
    }
    if (anyError.data.Recommend) {
      parts.push(`data.Recommend=${String(anyError.data.Recommend)}`);
    }
  }

  return parts.join(" | ") || "Unknown error";
}

function buildHistory(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  const normalized = messages.filter(
    (item) => item && typeof item.content === "string" && item.content.trim()
  );
  const history = [];

  for (let index = 0; index < normalized.length - 1; index += 2) {
    const userMessage = normalized[index];
    const assistantMessage = normalized[index + 1];

    if (userMessage?.role !== "user" || assistantMessage?.role !== "assistant") {
      continue;
    }

    history.push({
      user: userMessage.content.trim(),
      bot: assistantMessage.content.trim(),
    });
  }

  return history;
}

function buildInput(messages, sessionId) {
  const normalized = Array.isArray(messages)
    ? messages.filter((item) => item && typeof item.content === "string" && item.content.trim())
    : [];
  const latest = normalized.at(-1);

  if (!latest || latest.role !== "user") {
    return null;
  }

  return {
    prompt: latest.content.trim(),
    ...(sessionId ? { session_id: sessionId } : { history: buildHistory(normalized.slice(0, -1)) }),
  };
}

function bailianHeaders({ hasOssFile = false } = {}) {
  return {
    Authorization: `Bearer ${BAILIAN_API_KEY}`,
    "Content-Type": "application/json",
    ...(process.env.BAILIAN_WORKSPACE_ID
      ? { "X-DashScope-WorkSpace": process.env.BAILIAN_WORKSPACE_ID }
      : {}),
    ...(hasOssFile ? { "X-DashScope-OssResourceResolve": "enable" } : {}),
  };
}

app.get("/api/config", (_req, res) => {
  res.json({
    appConfigured: Boolean(BAILIAN_API_KEY && BAILIAN_APP_ID),
    uploadConfigured: hasUploadConfig(),
    appId: BAILIAN_APP_ID || "",
    workspaceId: BAILIAN_WORKSPACE_ID || "",
    uploadModel: BAILIAN_FILE_UPLOAD_MODEL,
  });
});

app.post("/api/chat", async (req, res) => {
  if (!requireChatConfig(res)) {
    return;
  }

  const { messages = [], sessionId = "", fileUrls = [] } = req.body || {};
  const input = buildInput(messages, sessionId);
  const hasOssFile = Array.isArray(fileUrls) && fileUrls.some((item) => String(item).startsWith("oss://"));

  if (!input?.prompt) {
    res.status(400).json({ error: "No messages provided." });
    return;
  }

  const payload = {
    input: {
      ...input,
      ...(Array.isArray(fileUrls) && fileUrls.length ? { file_list: fileUrls } : {}),
    },
    parameters: {
      incremental_output: false,
    },
    debug: {},
  };

  try {
    const upstream = await fetch(`${BAILIAN_APP_URL}/${BAILIAN_APP_ID}/completion`, {
      method: "POST",
      headers: bailianHeaders({ hasOssFile }),
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      res.status(upstream.status).json(data);
      return;
    }

    const text =
      data?.output?.text ||
      data?.output?.finish_reason ||
      data?.output?.choices?.[0]?.message?.content?.[0]?.text ||
      "";

    res.json({
      sessionId: data?.output?.session_id || sessionId || "",
      requestId: data?.request_id || "",
      text,
      raw: data,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Chat request failed.",
    });
  }
});

app.post("/api/chat/stream", async (req, res) => {
  if (!requireChatConfig(res)) {
    return;
  }

  const { messages = [], sessionId = "", fileUrls = [] } = req.body || {};
  const input = buildInput(messages, sessionId);
  const hasOssFile = Array.isArray(fileUrls) && fileUrls.some((item) => String(item).startsWith("oss://"));

  if (!input?.prompt) {
    res.status(400).json({ error: "No messages provided." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  res.on("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  const payload = {
    input: {
      ...input,
      ...(Array.isArray(fileUrls) && fileUrls.length ? { file_list: fileUrls } : {}),
    },
    parameters: {
      incremental_output: true,
      flow_stream_mode: "agent_format",
    },
    debug: {},
  };

  try {
    const upstream = await fetch(`${BAILIAN_APP_URL}/${BAILIAN_APP_ID}/completion`, {
      method: "POST",
      headers: {
        ...bailianHeaders({ hasOssFile }),
        "X-DashScope-SSE": "enable",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const errorText = await upstream.text();
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ error: errorText || "Upstream stream failed." })}\n\n`);
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";

      for (const chunk of chunks) {
        const lines = chunk.split(/\r?\n/);
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

        const dataText = dataLines.join("\n");
        if (dataText === "[DONE]") {
          res.write("event: done\n");
          res.write("data: {}\n\n");
          continue;
        }

        try {
          const parsed = JSON.parse(dataText);
          const text =
            parsed?.output?.text ||
            parsed?.output?.choices?.[0]?.message?.content?.[0]?.text ||
            "";
          const envelope = {
            event: eventName,
            sessionId: parsed?.output?.session_id || sessionId || "",
            requestId: parsed?.request_id || "",
            text,
            raw: parsed,
          };
          res.write(`event: ${eventName}\n`);
          res.write(`data: ${JSON.stringify(envelope)}\n\n`);
        } catch {
          res.write("event: chunk\n");
          res.write(`data: ${JSON.stringify({ text: dataText })}\n\n`);
        }
      }
    }

    res.write("event: done\n");
    res.write("data: {}\n\n");
    res.end();
  } catch (error) {
    if (!res.writableEnded) {
      res.write("event: error\n");
      res.write(
        `data: ${JSON.stringify({
          error: error instanceof Error ? error.message : "Streaming failed.",
        })}\n\n`
      );
      res.end();
    }
  }
});

async function getUploadPolicy() {
  const response = await fetch(
    `${BAILIAN_UPLOAD_POLICY_URL}?action=getPolicy&model=${encodeURIComponent(BAILIAN_FILE_UPLOAD_MODEL)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${BAILIAN_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || data?.code || "Failed to get DashScope upload policy.");
  }
  if (!data?.data?.upload_host || !data?.data?.upload_dir) {
    throw new Error("Upload policy response is missing upload_host or upload_dir.");
  }
  return data.data;
}

async function uploadFileToDashScopeTemp(file) {
  const policy = await getUploadPolicy();
  const key = `${policy.upload_dir}/${file.originalname}`;
  const formData = new FormData();

  formData.append("OSSAccessKeyId", policy.oss_access_key_id);
  formData.append("Signature", policy.signature);
  formData.append("policy", policy.policy);
  formData.append("x-oss-object-acl", policy.x_oss_object_acl);
  formData.append("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite);
  formData.append("key", key);
  formData.append("success_action_status", "200");
  formData.append("file", new Blob([file.buffer], { type: file.mimetype || "application/octet-stream" }), file.originalname);

  const uploadResponse = await fetch(policy.upload_host, {
    method: "POST",
    body: formData,
  });

  if (!uploadResponse.ok) {
    const body = await uploadResponse.text().catch(() => "");
    throw new Error(`Temporary upload failed: ${uploadResponse.status} ${body}`.trim());
  }

  return {
    fileName: file.originalname,
    fileUrl: `oss://${key}`,
    expiresInSeconds: Number(policy.expire_in_seconds || 0),
    maxFileSizeMb: Number(policy.max_file_size_mb || 10),
  };
}

app.post("/api/files/upload", upload.array("files", 6), async (req, res) => {
  if (!requireUploadConfig(res)) {
    return;
  }

  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) {
    res.status(400).json({ error: "No files uploaded." });
    return;
  }

  try {
    const uploaded = [];
    for (const file of files) {
      uploaded.push(await uploadFileToDashScopeTemp(file));
    }

    res.json({
      fileUrls: uploaded.map((item) => item.fileUrl),
      files: uploaded,
    });
  } catch (error) {
    res.status(500).json({
      error: formatDetailedError(error),
    });
  }
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Bailian agent chat is running at http://localhost:${PORT}`);
});
