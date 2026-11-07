云起四海 · 会员积分与订单系统（v1.2 内部测试版）

本升级不改变原 HeyGen 翻译工作台、管理员密码和会员密码。
新功能：
1. 会员登录后查看积分余额、积分申请订单和流水。
2. 会员提交积分申请；订单为“待审核”，不产生支付或自动加分。
3. 原管理员登录后，进入“积分审核后台”，人工批准/拒绝申请。
4. 审批通过时在数据库事务中增加余额并记账；已审核订单不能重复发积分。
5. 普通会员仍然无法使用 HeyGen 付费翻译接口，防止未经授权扣费。

Neon：本次已通过连接的 Neon 插件在 yunqisihai / production 创建并核验3张新表：
 yq_credit_wallets、yq_credit_orders、yq_credit_ledger。
原用户账户表 yq_members 及会话表没有修改或删除。

【上传只需一次】
1. 下载并解压本 ZIP。
2. 在 GitHub 仓库 ly19239286561-create/yunqisihai-ai 的根目录点击 Add file -> Upload files。
3. 把以下文件全部上传，已存在的同名文件直接替换：
   - server.js
   - member-api.js
   - members.html
   - members.css
   - members.js
   - package.json
   - credit-core.js
   - credit-api.js
   - credit-admin.html
   - credit-admin.css
   - credit-admin.js
   - credit-core.test.js
4. 点击 Commit changes。保留 public 文件夹、member-security.js、render.yaml 等原有文件。
5. Render 的自动部署完成后，无需修改任何环境变量（继续使用你已经配置成功的 DATABASE_URL）。

【测试顺序】
A. 打开 https://yunqisihai-ai.onrender.com/members.html
   用原会员账号登录，查看余额应为0，提交100点申请，订单应显示“等待审核”。
B. 访问 https://yunqisihai-ai.onrender.com/
   使用之前的管理员邮箱和密码登录原工作台。
C. 再打开 https://yunqisihai-ai.onrender.com/credit-admin.html
   找到会员刚提交的订单，点击“批准发放”。仅内部测试：这并不代表已收款。
D. 返回会员中心，点击“刷新”，余额应增加100点，订单为“已通过”，流水出现+100。
E. 不要重复点击审批；重复审批会被服务端拒绝以防重复加分。

安全说明：
- 此版本没有真实支付，也没有接入 HeyGen 按积分自动扣费。
- 对外正式经营之前，必须补充邮箱验证、找回密码、订单风控、支付回调与财务对账。
- 管理员只能通过已有的独立管理员登录身份审批。数据库连接串继续保存在 Render Environment，切勿上传到 GitHub 或发给他人。

基础验证：node --test member-security.test.js credit-core.test.js（7项通过），并已在 Neon 核实新表存在。真实线上业务流程需要在上传部署后进一步验收。
