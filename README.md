# 百炼智能体聊天网页

一个轻量全栈 Demo，提供：

- 百炼应用聊天接入
- 多轮对话
- SSE 流式响应
- 本地文件选择与上传
- 停止生成、重新回答、复制消息、新会话
- 临时会话，不做长期存储
- 桌面端与移动端适配

## 启动

```bash
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)

## 环境变量

参考 `.env.example`：

```env
PORT=3000
BAILIAN_API_KEY=
BAILIAN_APP_ID=
BAILIAN_WORKSPACE_ID=
BAILIAN_FILE_UPLOAD_MODEL=qwen-vl-plus
```

## 说明

- 聊天接口使用百炼应用 Completion API
- 多轮会话依赖百炼返回的 `session_id`
- 流式链路已接通 SSE
- 文件上传走更轻量的 `file_list` 方案
- 后端会先调用百炼上传策略接口，得到临时 `oss://` 文件地址，再把地址随会话一起传给应用
- 该方案只依赖 `BAILIAN_API_KEY`，更适合后续部署到 Vercel

## 目录

```text
public/
  index.html
  styles.css
  app.js
server.js
```
