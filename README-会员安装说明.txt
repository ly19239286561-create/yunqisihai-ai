云起四海会员版 v1.1（在原网站上增加会员注册，保留 HeyGen 翻译功能）

本升级使用 Neon PostgreSQL 数据库的普通 SQL 接口，不需要 Neon CLI、Neon Auth、Replit 或 Supabase。
免费数据库在 Neon 保有免费额度的情况下可测试。

【操作】
1. 先在 GitHub 仓库 ly19239286561-create/yunqisihai-ai 做好备份（例如下载 ZIP）。
2. 解压此补丁包，把以下7个必需文件上传到 GitHub 仓库根目录（根目录即 package.json 所在目录）：
   - server.js（覆盖原来的）
   - package.json（覆盖原来的）
   - member-api.js（新文件）
   - member-security.js（新文件）
   - members.html（新文件）
   - members.css（新文件）
   - members.js（新文件）
   （另附 member-security.test.js 是自测文件，可选；README 也不需要上传。原有 render.yaml、public 文件夹保持不变。）
3. 在 Neon 控制台打开原 yunqisihai 项目，点击左侧 Connect / 连接，选择 production 分支，复制数据库连接字符串。
   注意：连接字符串含数据库密码，是机密。不要发聊天、不放到 GitHub。
4. 在 Render 的 yunqisihai-ai Web Service 中打开 Environment，新增环境变量：
   Key: DATABASE_URL
   Value: Neon 复制的完整连接字符串（postgresql://...），保留 sslmode=require。
   保存后，触发部署 / 等待自动部署。原来的 HEYGEN_API_KEY、ADMIN_EMAIL、ADMIN_PASSWORD、SESSION_SECRET 均保持不变。
5. 打开： https://yunqisihai-ai.onrender.com/members.html
   点击“注册会员”，填昵称、邮箱、12位以上密码，提交。
   注册成功页面将自动请求 /api/members/me，并显示当前邮箱、姓名及会员 ID。
6. 退出，重新登录，看是否显示同一会员。如果成功，证明数据库用户和会话有效。
7. 管理员工作台仍在首页。注册会员不会获得管理员权限，也不能直接调用付费的 HeyGen 翻译 API。

【重要提醒】
- 该版本用于真实数据库的内部会员注册测试，不提供邮箱验证、找回密码或正式支付。
- 开放付费用户前，须补齐邮箱验证、密码重置、隐私政策、用户协议、余额扣费与订单隔离等。
- 仅在 Render 中保存 DATABASE_URL，绝不要贴到聊天或者 GitHub 文件里。
- 如果启用公网注册，请使用强密码；请勿利用未验证邮箱作为身份所有权凭证。
- 原网站管理员仍只能由原 ADMIN_EMAIL / ADMIN_PASSWORD 登录。

【为什么这次不再用 Neon CLI】
你的 Neon 数据库已经创建。普通 PostgreSQL 标准连接是 Neon 官方支持的方案；这版避免多一步托管 Auth SDK/CLI、重新搭建站点和额外托管平台。

【开发侧自测】
node --check server.js
node --check member-api.js
node --test member-security.test.js

说明：本包已通过基础语法和密码哈希测试；正式联网注册需完成上述 DATABASE_URL 配置后，才能由你和我共同验收，不能提前声称已成功创建真实用户。
