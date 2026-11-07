# 云起四海 · AI 视频翻译正式接口版（内部运营试用）

这不是演示用的假按钮：在成功配置云服务器及 HeyGen API 后，点击“立即提交翻译”会发送 **真实的 HeyGen v3 视频翻译任务**，随后查询任务状态，完成后展示成片/字幕链接。

## 目前完成的功能
- 响应式中文网站，可在手机和电脑上使用
- **管理员登录（单管理员账户）**，访问受会话 Cookie 保护
- 从 **HTTPS 视频直链**提交真实翻译任务
- 通过 **Cloudflare R2（可选）**上传本地 MP4/MOV/WEBM 视频，浏览器安全直传对象存储；最多 1GB
- 提交 HeyGen v3 视频翻译 API：快速/精细口型同步、仅配音、语言选择、字幕
- 自动轮询完成状态，下载视频；当前设备保留任务记录（localStorage）
- API 密钥只放在服务器的环境变量中，**不会公开到浏览器/GitHub Pages**

## 开通前必须配置
1. **HeyGen API Key**：https://app.heygen.com/api ，确认拥有可用于 API 的有效额度/权限。
2. **支持 Node.js 的服务器/网站托管**：例如 Render Web Service、Railway 或自己的云服务器。GitHub Pages 只能托管静态网页，不能运行本项目的后端。
3. **部署平台环境变量**：`HEYGEN_API_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (≥12 位), `SESSION_SECRET` (≥32 位)。
4. 若要让客户直接上传本地视频，再配置 Cloudflare R2：`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`，并设置 R2 桶的 CORS：

```json
[
  {
    "AllowedOrigins": ["https://你的正式网站域名"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

## 在 GitHub → Render 上部署
1. 将本文件夹 **所有文件连同 `public` 文件夹** 提交到 GitHub 仓库 `yunqisihai-ai` 的根目录。`public` 文件夹内有 `index.html`、`style.css`、`app.js`。原来放在根目录的演示版 `index.html` 不再负责运行；建议删除旧文件，避免混淆。
2. 在 Render 创建 **Web Service**，连接 GitHub 仓库；Runtime 选 `Node`，Build Command `npm install`，Start Command `npm start`。可参考本仓库的 `render.yaml`。注意 Render 可能需要选用付费实例，套餐按当时页面为准。
3. 在 Render 的 Environment 中填写：
   - `NODE_ENV=production`
   - `HEYGEN_API_KEY=（HeyGen 后台生成）`
   - `ADMIN_EMAIL=你自己的邮箱`
   - `ADMIN_PASSWORD=设置至少12位的强密码`
   - `SESSION_SECRET=至少32位完全随机字符串`
   - 可选填上方 4 个 R2 变量。
4. 部署成功后使用 Render 提供的网址打开，先用管理员邮箱/密码登录。仅有 HeyGen API Key 还无法上传本地文件（需要 R2），但可以用公开 HTTPS 视频直链来测真实翻译。
5. **不要把 API Key、R2 密钥、管理员密码发到公开聊天、GitHub 仓库或写进网页**。

## 本地启动（Node 20+）
```
npm install
# 根据 .env.example 自行设置环境变量（应用不会自动读取 .env）
npm start
```
浏览器打开 `http://localhost:3000`。

## 尚未完成，不能作为开放收费会员网站上线
- 手机短信验证码注册、普通会员系统、会员充值和支付回调（需要短信服务和合规支付渠道）
- 服务端数据库/订单持久化、余额和成本核算、按真实翻译分钟结算、失败退款
- 多租户用户隔离、视频有效期与隐私删除、正式用户协议、合规资质审查
- 退款、限购、风控、发票和财务对账等运营能力

**特别注意：** 本版管理员可以实际消耗 HeyGen API 额度，不要向公网用户提供管理员账号密码。未经过 HeyGen 实际联网调用测试，需在你配置有效密钥后验证 API 响应、视频访问和成本。

## 官方文档
- https://developers.heygen.com/
- https://www.heygen.com/blog/heygen-api-guide
- https://github.com/heygen-com/skills/blob/master/heygen-translate/references/asset-routing.md
