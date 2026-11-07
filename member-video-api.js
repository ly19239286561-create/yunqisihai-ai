import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { MAX_WALLET_POINTS } from './credit-core.js';
import { RATE_POINTS_PER_SECOND, probeVideoDuration } from './video-billing.js';

const MAX_DIRECT_BYTES = 32 * 1024 * 1024;
const JOB_LIMIT = rateLimit({ windowMs: 60 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: '提交次数过多，请稍后再试。' } });
const UPLOAD_LIMIT = rateLimit({ windowMs: 60 * 60 * 1000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: '上传次数过多，请稍后再试。' } });
const RAW_VIDEO = express.raw({ type: ['video/mp4', 'video/webm'], limit: '32mb' });
const isJobId = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);
const httpsOnly = value => typeof value === 'string' && /^https:\/\//.test(value) ? value : null;

export function registerMemberVideoRoutes(app, { pool, schema, readCurrentUser, postGuard, getLanguages, heygen, safeError }) {
  let initPromise;
  async function ensureSchema() {
    await schema();
    if (!pool) throw new Error('NO_DATABASE');
    if (!initPromise) {
      initPromise = (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS yq_credit_wallets (
          member_id UUID PRIMARY KEY REFERENCES yq_members(id) ON DELETE CASCADE,
          balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(balance BETWEEN 0 AND ${MAX_WALLET_POINTS}),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await pool.query(`CREATE TABLE IF NOT EXISTS yq_credit_ledger (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          member_id UUID NOT NULL REFERENCES yq_members(id) ON DELETE CASCADE,
          order_id UUID,
          delta NUMERIC(14,2) NOT NULL CHECK(delta <> 0),
          balance_after NUMERIC(14,2) NOT NULL CHECK(balance_after BETWEEN 0 AND ${MAX_WALLET_POINTS}),
          note VARCHAR(200) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        // Upgrade existing integer wallets/ledger in place without changing values or deleting history.
        await pool.query('ALTER TABLE yq_credit_wallets ALTER COLUMN balance TYPE NUMERIC(14,2) USING balance::NUMERIC(14,2)');
        await pool.query('ALTER TABLE yq_credit_ledger ALTER COLUMN delta TYPE NUMERIC(14,2) USING delta::NUMERIC(14,2)');
        await pool.query('ALTER TABLE yq_credit_ledger ALTER COLUMN balance_after TYPE NUMERIC(14,2) USING balance_after::NUMERIC(14,2)');
        await pool.query(`CREATE TABLE IF NOT EXISTS yq_member_video_assets (
          asset_id VARCHAR(200) PRIMARY KEY,
          member_id UUID NOT NULL REFERENCES yq_members(id) ON DELETE CASCADE,
          duration_seconds DOUBLE PRECISION,
          billed_seconds INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await pool.query('ALTER TABLE yq_member_video_assets ADD COLUMN IF NOT EXISTS duration_seconds DOUBLE PRECISION');
        await pool.query('ALTER TABLE yq_member_video_assets ADD COLUMN IF NOT EXISTS billed_seconds INTEGER');
        await pool.query(`CREATE TABLE IF NOT EXISTS yq_member_video_jobs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(), member_id UUID NOT NULL REFERENCES yq_members(id) ON DELETE CASCADE,
          client_request_id UUID NOT NULL, task_id TEXT,
          name VARCHAR(120) NOT NULL DEFAULT '旅游视频', language VARCHAR(120) NOT NULL,
          mode VARCHAR(16) NOT NULL, cost_points NUMERIC(14,2) NOT NULL CHECK(cost_points > 0 AND cost_points <= 200000),
          duration_seconds INTEGER,
          status VARCHAR(16) NOT NULL DEFAULT 'submitting',
          video_url TEXT, caption_url TEXT, failure_message VARCHAR(300),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(member_id,client_request_id))`);
        await pool.query('ALTER TABLE yq_member_video_jobs ALTER COLUMN cost_points TYPE NUMERIC(14,2) USING cost_points::NUMERIC(14,2)');
        await pool.query('ALTER TABLE yq_member_video_jobs ADD COLUMN IF NOT EXISTS duration_seconds INTEGER');
        await pool.query('CREATE INDEX IF NOT EXISTS yq_member_video_jobs_user_recent ON yq_member_video_jobs(member_id,created_at DESC)');
      })().catch(error => { initPromise = null; throw error; });
    }
    await initPromise;
  }
  function failure(res, error) {
    console.error('Member video error:', error?.code || error?.message || error?.name || 'service');
    return res.status(503).json({ error: '视频服务暂时不可用，请稍后再试。' });
  }
  async function member(req, res, next) {
    try { const current = await readCurrentUser(req); if (!current) return res.status(401).json({ error: '请先登录会员账号。' }); req.member = current; next(); }
    catch (error) { failure(res, error); }
  }
  function checkOrigin(req) { const origin = req.get('origin'); return !!origin && origin === `${req.protocol}://${req.get('host')}`; }
  async function refundJob(jobId, reason) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT id,member_id,status,cost_points FROM yq_member_video_jobs WHERE id=$1 FOR UPDATE', [jobId]);
      const job = result.rows[0];
      if (!job || ['refunded','completed','failed'].includes(job.status)) { await client.query('COMMIT'); return false; }
      const wallet = await client.query('UPDATE yq_credit_wallets SET balance=balance+$2::numeric,updated_at=NOW() WHERE member_id=$1 RETURNING balance', [job.member_id,job.cost_points]);
      if (!wallet.rows.length) throw new Error('Missing credit wallet');
      await client.query('INSERT INTO yq_credit_ledger(member_id,delta,balance_after,note) VALUES ($1,$2,$3,$4)', [job.member_id,job.cost_points,wallet.rows[0].balance,'视频处理失败，自动退还积分']);
      await client.query("UPDATE yq_member_video_jobs SET status='refunded',failure_message=$2,updated_at=NOW() WHERE id=$1", [jobId,String(reason || '视频处理失败').slice(0,300)]);
      await client.query('COMMIT'); return true;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  }
  async function balanceFor(memberId) { const r=await pool.query('SELECT balance FROM yq_credit_wallets WHERE member_id=$1',[memberId]); return r.rows[0]?.balance ?? '0.00'; }
  app.get('/api/members/video-config',member,async(req,res)=>{
    try {
      await ensureSchema();
      const [langs,balance] = await Promise.all([getLanguages(),balanceFor(req.member.id)]);
      res.set('Cache-Control','no-store');
      res.json({languages:langs.languages,availableOnPlan:langs.availableOnPlan,pointsPerSecond:RATE_POINTS_PER_SECOND,balance,maxUploadBytes:MAX_DIRECT_BYTES,chargeUnit:'started-second'});
    } catch(error) { failure(res,error); }
  });
  app.post('/api/members/video-assets',member,UPLOAD_LIMIT,RAW_VIDEO,async(req,res)=>{
    if (!checkOrigin(req)) return res.status(403).json({ error:'请求来源不合法。' });
    const type = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['video/mp4','video/webm'].includes(type) || !Buffer.isBuffer(req.body) || !req.body.length || req.body.length > MAX_DIRECT_BYTES)
      return res.status(400).json({ error:'仅支持32MB以内的MP4或WEBM视频。' });
    try {
      await ensureSchema();
      // The backend, not the browser, measures the actual file duration with ffprobe.
      let media;
      try { media = await probeVideoDuration(req.body,type); }
      catch(error) { return res.status(400).json({ error:error instanceof RangeError?error.message:'无法读取视频时长，请转成标准MP4或WEBM格式重试。' }); }
      const balance = Number(await balanceFor(req.member.id));
      if (balance < Number(media.costPoints)) return res.status(402).json({ error:`此视频预计需要${media.costPoints}积分，当前余额不足。` });
      const form = new FormData();
      form.append('file',new Blob([req.body],{type}),type==='video/mp4'?'travel-video.mp4':'travel-video.webm');
      const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),120000);
      let upstream;
      try { upstream=await fetch('https://api.heygen.com/v3/assets',{method:'POST',headers:{'x-api-key':process.env.HEYGEN_API_KEY,'Accept':'application/json'},body:form,signal:abort.signal}); }
      finally { clearTimeout(timer); }
      const body=await upstream.text();let data;
      try { data=JSON.parse(body); } catch { data={message:body.slice(0,200)}; }
      if (!upstream.ok || data.error || (data.code && ![100,200].includes(Number(data.code)))) throw new Error(data.message || data.error?.message || '视频上传失败');
      const assetId=data.data?.asset_id;
      if(typeof assetId!=='string' || !/^[a-zA-Z0-9_-]{6,200}$/.test(assetId)) throw new Error('上传未返回有效素材编号');
      await pool.query('INSERT INTO yq_member_video_assets(asset_id,member_id,duration_seconds,billed_seconds) VALUES ($1,$2,$3,$4) ON CONFLICT(asset_id) DO UPDATE SET duration_seconds=EXCLUDED.duration_seconds,billed_seconds=EXCLUDED.billed_seconds WHERE yq_member_video_assets.member_id=EXCLUDED.member_id', [assetId,req.member.id,media.durationSeconds,media.billedSeconds]);
      res.json({assetId,durationSeconds:media.durationSeconds,billedSeconds:media.billedSeconds,costPoints:media.costPoints});
    } catch(error) { console.error('Member video upload error:',error?.code || error?.name || 'upstream'); res.status(502).json({error:'视频上传失败：'+safeError(error)}); }
  });
  app.post('/api/members/video-jobs',member,JOB_LIMIT,postGuard,async(req,res)=>{
    const {clientRequestId,assetId,language,mode,enableCaption,name} = req.body || {};
    if (!isJobId(clientRequestId)) return res.status(400).json({ error:'无效请求编号，请刷新页面重试。' });
    if (!['speed','precision','audio'].includes(mode)) return res.status(400).json({ error:'请选择翻译模式。' });
    if(typeof language!=='string' || language.length>120) return res.status(400).json({ error:'请选择语言。' });
    if(!assetId) return res.status(400).json({ error:'按秒计费需核实原片时长，请先上传本地视频。暂不支持视频直链计费。' });
    if(typeof assetId!=='string' || !/^[a-zA-Z0-9_-]{6,200}$/.test(assetId)) return res.status(400).json({error:'视频素材编号无效。'});
    try {
      await ensureSchema();
      const langs=await getLanguages();
      if(!langs.languages.includes(language)) return res.status(400).json({error:'不支持该目标语言。'});
      if(langs.availableOnPlan && !langs.availableOnPlan.includes(language)) return res.status(400).json({error:'当前套餐暂不支持所选语言。'});
      const video={type:'asset_id',asset_id:assetId};
      let jobId, existing, fee;
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const previous=await client.query('SELECT id,task_id,status,cost_points FROM yq_member_video_jobs WHERE member_id=$1 AND client_request_id=$2 FOR UPDATE',[req.member.id,clientRequestId]);
        if(previous.rows.length) { existing=previous.rows[0]; await client.query('COMMIT'); }
        else {
          const assets=await client.query('SELECT billed_seconds FROM yq_member_video_assets WHERE asset_id=$1 AND member_id=$2',[assetId,req.member.id]);
          const seconds=assets.rows[0]?.billed_seconds;
          if(!Number.isInteger(seconds) || seconds<1 || seconds>1800){await client.query('ROLLBACK');return res.status(400).json({error:'素材没有经过服务器时长校验，请重新上传视频。'});}
          fee=(seconds*RATE_POINTS_PER_SECOND).toFixed(2);
          await client.query('INSERT INTO yq_credit_wallets(member_id) VALUES ($1) ON CONFLICT(member_id) DO NOTHING',[req.member.id]);
          const wallet=await client.query('UPDATE yq_credit_wallets SET balance=balance-$2::numeric,updated_at=NOW() WHERE member_id=$1 AND balance >= $2::numeric RETURNING balance',[req.member.id,fee]);
          if(!wallet.rows.length){await client.query('ROLLBACK');return res.status(402).json({error:`积分不足，本次需${fee}积分。`});}
          const inserted=await client.query('INSERT INTO yq_member_video_jobs(member_id,client_request_id,name,language,mode,cost_points,duration_seconds) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',[req.member.id,clientRequestId,String(name || '旅游视频').slice(0,120),language,mode,fee,seconds]);
          jobId=inserted.rows[0].id;
          await client.query('INSERT INTO yq_credit_ledger(member_id,delta,balance_after,note) VALUES ($1,$2,$3,$4)',[req.member.id,`-${fee}`,wallet.rows[0].balance,`视频翻译 ${seconds}秒 · ${jobId.slice(0,8)}`]);
          await client.query('COMMIT');
        }
      } catch(e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
      finally { client.release(); }
      if(existing) return res.status(200).json({id:existing.id,taskId:existing.task_id,status:existing.status,costPoints:existing.cost_points,duplicate:true});
      try {
        const payload={video,output_languages:[language],mode:mode==='audio'?'speed':mode,translate_audio_only:mode==='audio',enable_caption:!!enableCaption,enable_speech_enhancement:true,enable_dynamic_duration:true};
        const result=await heygen('/v3/video-translations','POST',payload);
        const ids=result.data?.video_translation_ids || result.video_translation_ids;
        if(!Array.isArray(ids) || typeof ids[0]!=='string') throw new Error('任务编号未返回');
        await pool.query("UPDATE yq_member_video_jobs SET task_id=$2,status='submitted',updated_at=NOW() WHERE id=$1",[jobId,ids[0]]);
        return res.status(201).json({id:jobId,status:'submitted',costPoints:fee});
      } catch(error) {
        try { await refundJob(jobId,'任务提交失败'); } catch(refundError) { console.error('Refund issue:',refundError?.code || refundError?.name); }
        return res.status(502).json({error:'翻译任务提交失败：'+safeError(error)});
      }
    } catch(error) { failure(res,error); }
  });
  app.get('/api/members/video-jobs',member,async(req,res)=>{
    try {
      await ensureSchema();
      const r=await pool.query('SELECT id,name,language,mode,cost_points,duration_seconds,status,video_url,caption_url,failure_message,created_at FROM yq_member_video_jobs WHERE member_id=$1 ORDER BY created_at DESC LIMIT 50',[req.member.id]);
      res.set('Cache-Control','no-store');res.json({jobs:r.rows});
    } catch(error) {failure(res,error);}
  });
  app.get('/api/members/video-jobs/:id',member,async(req,res)=>{
    if(!isJobId(req.params.id)) return res.status(400).json({error:'无效作品编号。'});
    try {
      await ensureSchema();
      const record=await pool.query('SELECT id,task_id,status,video_url,caption_url,failure_message FROM yq_member_video_jobs WHERE id=$1 AND member_id=$2',[req.params.id,req.member.id]);
      const job=record.rows[0];if(!job)return res.status(404).json({error:'没有找到该作品。'});
      if(!job.task_id || ['completed','refunded'].includes(job.status)) return res.json({id:job.id,status:job.status,videoUrl:job.video_url,captionUrl:job.caption_url,failureMessage:job.failure_message});
      const upstream=await heygen(`/v3/video-translations/${encodeURIComponent(job.task_id)}`);
      const data=upstream.data || upstream;
      const current=String(data.status || 'processing').toLowerCase();
      if(['failed','error','cancelled'].includes(current)) {await refundJob(job.id,'翻译处理失败，积分已退回。');return res.json({id:job.id,status:'refunded',failureMessage:'翻译失败，积分已自动退回。'});}
      const newStatus=['completed','success'].includes(current) ? 'completed' : 'processing';
      const videoUrl=httpsOnly(data.video_url), captionUrl=httpsOnly(data.srt_caption_url);
      await pool.query('UPDATE yq_member_video_jobs SET status=$2,video_url=COALESCE($3,video_url),caption_url=COALESCE($4,caption_url),updated_at=NOW() WHERE id=$1',[job.id,newStatus,videoUrl,captionUrl]);
      return res.json({id:job.id,status:newStatus,videoUrl,captionUrl,failureMessage:null});
    } catch(error) {console.error('Member status failure:',error?.code || error?.name);res.status(502).json({error:'作品状态暂时无法查询，请稍后重试。'});}
  });
}
