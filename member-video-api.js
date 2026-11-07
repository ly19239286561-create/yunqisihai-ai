import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { MAX_WALLET_POINTS } from './credit-core.js';

// Pilot billing. Change MEMBER_TRANSLATION_POINTS_PER_JOB in Render before selling commercially.
const DEFAULT_COST = 10;
const envCost = Number(process.env.MEMBER_TRANSLATION_POINTS_PER_JOB);
const BASE_COST = Number.isSafeInteger(envCost) && envCost >= 1 && envCost <= 100000 ? envCost : DEFAULT_COST;
const MAX_DIRECT_BYTES = 32 * 1024 * 1024;
const JOB_LIMIT = rateLimit({windowMs: 60*60*1000,limit:12,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'提交次数过多，请稍后再试。'}});
const UPLOAD_LIMIT = rateLimit({windowMs: 60*60*1000,limit:15,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'上传次数过多，请稍后再试。'}});
const RAW_VIDEO = express.raw({type:['video/mp4','video/webm'],limit:'32mb'});
const isJobId = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);
const httpsOnly = value => typeof value === 'string' && /^https:\/\//.test(value) && value.length < 4000 ? value : null;
const costByMode = mode => mode==='precision' ? BASE_COST*2 : mode==='audio' ? Math.max(1,Math.ceil(BASE_COST/2)) : BASE_COST;

export function registerMemberVideoRoutes(app,{pool,schema,readCurrentUser,postGuard,getLanguages,heygen,validVideoUrl,safeError}) {
 let initPromise;
 async function ensureSchema(){
  await schema();
  if(!initPromise){
   initPromise=(async()=>{
    // The studio can be opened directly after member login, before visiting the credits screen.
    await pool.query(`CREATE TABLE IF NOT EXISTS yq_credit_wallets (
      member_id UUID PRIMARY KEY REFERENCES yq_members(id) ON DELETE CASCADE,
      balance INTEGER NOT NULL DEFAULT 0 CHECK(balance BETWEEN 0 AND ${MAX_WALLET_POINTS}),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS yq_credit_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      member_id UUID NOT NULL REFERENCES yq_members(id) ON DELETE CASCADE,
      requested_points INTEGER NOT NULL CHECK(requested_points BETWEEN 1 AND 100000),
      remark VARCHAR(200) NOT NULL DEFAULT '',
      status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      reviewed_by VARCHAR(254))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS yq_credit_ledger (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      member_id UUID NOT NULL REFERENCES yq_members(id) ON DELETE CASCADE,
      order_id UUID REFERENCES yq_credit_orders(id) ON DELETE RESTRICT,
      delta INTEGER NOT NULL CHECK(delta <> 0),
      balance_after INTEGER NOT NULL CHECK (balance_after BETWEEN 0 AND ${MAX_WALLET_POINTS}),
      note VARCHAR(200) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS yq_member_video_assets (
      asset_id VARCHAR(200) PRIMARY KEY,
      member_id UUID NOT NULL REFERENCES yq_members(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS yq_member_video_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      member_id UUID NOT NULL REFERENCES yq_members(id) ON DELETE CASCADE,
      client_request_id UUID NOT NULL,
      task_id TEXT,
      name VARCHAR(120) NOT NULL DEFAULT '旅游视频',
      language VARCHAR(120) NOT NULL,
      mode VARCHAR(16) NOT NULL,
      cost_points INTEGER NOT NULL CHECK(cost_points BETWEEN 1 AND 200000),
      status VARCHAR(16) NOT NULL DEFAULT 'submitting',
      video_url TEXT,
      caption_url TEXT,
      failure_message VARCHAR(300),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(member_id,client_request_id))`);
    await pool.query('CREATE INDEX IF NOT EXISTS yq_member_video_jobs_user_recent ON yq_member_video_jobs(member_id,created_at DESC)');
   })().catch(e=>{initPromise=null;throw e;});
  }
  await initPromise;
 }
 function failure(res,error){
  console.error('Member video error:',error?.code||error?.name||'video-service');
  if(error?.message==='NO_DATABASE')return res.status(503).json({error:'会员数据库尚未配置。'});
  res.status(503).json({error:'视频服务暂时不可用，请稍后再试。'});
 }
 async function member(req,res,next){
  try{const current=await readCurrentUser(req);if(!current)return res.status(401).json({error:'请先登录会员账号。'});req.member=current;next();}
  catch(error){failure(res,error);}
 }
 function checkOrigin(req){
  const origin=req.get('origin');
  return !!origin && origin===`${req.protocol}://${req.get('host')}`;
 }
 async function refundJob(jobId,reason){
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const result=await client.query('SELECT id,member_id,status,cost_points FROM yq_member_video_jobs WHERE id=$1 FOR UPDATE',[jobId]);
   const job=result.rows[0];
   if(!job || job.status==='failed' || job.status==='refunded' || job.status==='completed'){
    await client.query('COMMIT');return false;
   }
   const balance=await client.query('UPDATE yq_credit_wallets SET balance=balance+$2::int,updated_at=NOW() WHERE member_id=$1 RETURNING balance',[job.member_id,job.cost_points]);
   if(!balance.rows.length)throw new Error('Missing credit wallet for refund');
   await client.query('INSERT INTO yq_credit_ledger(member_id,delta,balance_after,note) VALUES ($1,$2,$3,$4)',
    [job.member_id,job.cost_points,balance.rows[0].balance,'视频处理失败，自动退还积分']);
   await client.query('UPDATE yq_member_video_jobs SET status=$2,failure_message=$3,updated_at=NOW() WHERE id=$1',
    [jobId,'refunded',String(reason||'视频处理失败').slice(0,300)]);
   await client.query('COMMIT');return true;
  }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}
  finally{client.release();}
 }
 async function balanceFor(memberId){
  const result=await pool.query('SELECT balance FROM yq_credit_wallets WHERE member_id=$1',[memberId]);
  return result.rows[0]?.balance??0;
 }
 app.get('/api/members/video-config',member,async(req,res)=>{
  try{
   await ensureSchema();
   const [langs,balance]=await Promise.all([getLanguages(),balanceFor(req.member.id)]);
   res.set('Cache-Control','no-store');
   res.json({languages:langs.languages,availableOnPlan:langs.availableOnPlan,pointsCost:{speed:costByMode('speed'),precision:costByMode('precision'),audio:costByMode('audio')},balance,maxUploadBytes:MAX_DIRECT_BYTES});
  }catch(error){failure(res,error);}
 });
 app.post('/api/members/video-assets',member,UPLOAD_LIMIT,RAW_VIDEO,async(req,res)=>{
  if(!checkOrigin(req))return res.status(403).json({error:'请求来源不合法。'});
  const type=String(req.get('content-type')||'').split(';')[0].trim().toLowerCase();
  if(!['video/mp4','video/webm'].includes(type)||!Buffer.isBuffer(req.body)||!req.body.length||req.body.length>MAX_DIRECT_BYTES)
   return res.status(400).json({error:'仅支持32MB以内的MP4或WEBM视频。'});
  try{
   await ensureSchema();
   const balance=await balanceFor(req.member.id);
   if(balance<Math.max(1,Math.ceil(BASE_COST/2)))return res.status(402).json({error:'积分不足，请先到积分中心申请积分。'});
   const form=new FormData();
   form.append('file',new Blob([req.body],{type}),type==='video/mp4'?'travel-video.mp4':'travel-video.webm');
   const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),120000);
   let upstream;
   try{upstream=await fetch('https://api.heygen.com/v3/assets',{
    method:'POST',headers:{'x-api-key':process.env.HEYGEN_API_KEY,'Accept':'application/json'},body:form,signal:abort.signal
   });}finally{clearTimeout(timer);}
   const body=await upstream.text();let data;
   try{data=JSON.parse(body);}catch{data={message:body.slice(0,200)};}
   if(!upstream.ok||data.error||(data.code&&![100,200].includes(Number(data.code))))throw new Error(data.message||data.error?.message||'上传服务器拒绝请求');
   const assetId=data.data?.asset_id;
   if(typeof assetId!=='string'||!/^[a-zA-Z0-9_-]{6,200}$/.test(assetId))throw new Error('服务器未返回有效素材编号');
   await pool.query('INSERT INTO yq_member_video_assets(asset_id,member_id) VALUES ($1,$2) ON CONFLICT (asset_id) DO NOTHING',[assetId,req.member.id]);
   res.json({assetId});
  }catch(error){console.error('Member upload:',error?.name||'upstream');res.status(502).json({error:'视频上传失败：'+safeError(error)});}
 });
 app.post('/api/members/video-jobs',member,JOB_LIMIT,postGuard,async(req,res)=>{
  const {clientRequestId,assetId,videoUrl,language,mode,enableCaption,name}=req.body||{};
  if(!isJobId(clientRequestId))return res.status(400).json({error:'无效请求编号，请刷新页面重试。'});
  if(!['speed','precision','audio'].includes(mode))return res.status(400).json({error:'请选择翻译模式。'});
  if(typeof language!=='string'||language.length>120)return res.status(400).json({error:'请选择语言。'});
  let video;
  try{
   await ensureSchema();
   const langs=await getLanguages();
   if(!langs.languages.includes(language))return res.status(400).json({error:'不支持该目标语言。'});
   if(langs.availableOnPlan&&!langs.availableOnPlan.includes(language))return res.status(400).json({error:'当前套餐暂不支持所选语言。'});
   if(assetId){
    if(typeof assetId!=='string'||!/^[a-zA-Z0-9_-]{6,200}$/.test(assetId))return res.status(400).json({error:'视频素材编号不正确。'});
    const owned=await pool.query('SELECT 1 FROM yq_member_video_assets WHERE asset_id=$1 AND member_id=$2',[assetId,req.member.id]);
    if(!owned.rowCount)return res.status(403).json({error:'视频素材不属于当前会员。'});
    video={type:'asset_id',asset_id:assetId};
   }else{
    const valid=validVideoUrl(videoUrl);
    if(!valid)return res.status(400).json({error:'请输入可直接下载的视频HTTPS链接。'});
    video={type:'url',url:valid};
   }
   const price=costByMode(mode);
   let jobId;
   let existing;
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    const previous=await client.query('SELECT id,task_id,status FROM yq_member_video_jobs WHERE member_id=$1 AND client_request_id=$2 FOR UPDATE',[req.member.id,clientRequestId]);
    if(previous.rows.length){existing=previous.rows[0];await client.query('COMMIT');}
    else{
     await client.query('INSERT INTO yq_credit_wallets(member_id) VALUES ($1) ON CONFLICT(member_id) DO NOTHING',[req.member.id]);
     const wallet=await client.query('UPDATE yq_credit_wallets SET balance=balance-$2::int,updated_at=NOW() WHERE member_id=$1 AND balance >= $2::int RETURNING balance',[req.member.id,price]);
     if(!wallet.rows.length){await client.query('ROLLBACK');return res.status(402).json({error:`积分不足。本次需要${price}积分，请先申请积分。`});}
     const inserted=await client.query('INSERT INTO yq_member_video_jobs(member_id,client_request_id,name,language,mode,cost_points) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [req.member.id,clientRequestId,String(name||'旅游视频').slice(0,120),language,mode,price]);
     jobId=inserted.rows[0].id;
     await client.query('INSERT INTO yq_credit_ledger(member_id,delta,balance_after,note) VALUES ($1,$2,$3,$4)',
      [req.member.id,-price,wallet.rows[0].balance,`视频翻译任务 ${jobId.slice(0,8)}`]);
     await client.query('COMMIT');
    }
   }catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}
   finally{client.release();}
   if(existing)return res.status(200).json({id:existing.id,taskId:existing.task_id,status:existing.status,duplicate:true});
   try{
    const params={video,output_languages:[language],mode:mode==='audio'?'speed':mode,
     translate_audio_only:mode==='audio',enable_caption:!!enableCaption,
     enable_speech_enhancement:true,enable_dynamic_duration:true};
    const result=await heygen('/v3/video-translations','POST',params);
    const ids=result.data?.video_translation_ids||result.video_translation_ids;
    if(!Array.isArray(ids)||typeof ids[0]!=='string')throw new Error('任务编号未返回');
    await pool.query("UPDATE yq_member_video_jobs SET task_id=$2,status='submitted',updated_at=NOW() WHERE id=$1",[jobId,ids[0]]);
    return res.status(201).json({id:jobId,status:'submitted',costPoints:price});
   }catch(error){
    try{await refundJob(jobId,'翻译提交失败');}
    catch(refundErr){console.error('Member video refund error:',refundErr?.code||refundErr?.name||'refund');}
    return res.status(502).json({error:'翻译任务提交失败：'+safeError(error)});
   }
  }catch(error){failure(res,error);}
 });
 app.get('/api/members/video-jobs',member,async(req,res)=>{
  try{
   await ensureSchema();
   const r=await pool.query('SELECT id,name,language,mode,cost_points,status,video_url,caption_url,failure_message,created_at FROM yq_member_video_jobs WHERE member_id=$1 ORDER BY created_at DESC LIMIT 50',[req.member.id]);
   res.set('Cache-Control','no-store');res.json({jobs:r.rows});
  }catch(error){failure(res,error);}
 });
 app.get('/api/members/video-jobs/:id',member,async(req,res)=>{
  if(!isJobId(req.params.id))return res.status(400).json({error:'无效作品编号。'});
  try{
   await ensureSchema();
   const record=await pool.query('SELECT id,task_id,status,video_url,caption_url,failure_message FROM yq_member_video_jobs WHERE id=$1 AND member_id=$2',[req.params.id,req.member.id]);
   const job=record.rows[0];if(!job)return res.status(404).json({error:'没有找到该作品。'});
   if(!job.task_id||['completed','refunded'].includes(job.status)){
    return res.json({id:job.id,status:job.status,videoUrl:job.video_url,captionUrl:job.caption_url,failureMessage:job.failure_message});
   }
   const result=await heygen(`/v3/video-translations/${encodeURIComponent(job.task_id)}`);
   const data=result.data||result;
   const current=String(data.status||'processing').toLowerCase();
   const completed=['completed','success'].includes(current);
   const failed=['failed','error','cancelled'].includes(current);
   if(failed){
    await refundJob(job.id,'翻译处理失败，已退还积分。');
    return res.json({id:job.id,status:'refunded',failureMessage:'翻译失败，积分已自动退回。'});
   }
   const newStatus=completed?'completed':'processing';
   const videoUrl=httpsOnly(data.video_url),captionUrl=httpsOnly(data.srt_caption_url);
   await pool.query('UPDATE yq_member_video_jobs SET status=$2,video_url=COALESCE($3,video_url),caption_url=COALESCE($4,caption_url),updated_at=NOW() WHERE id=$1',
    [job.id,newStatus,videoUrl,captionUrl]);
   res.json({id:job.id,status:newStatus,videoUrl,captionUrl,failureMessage:null});
  }catch(error){console.error('Member video status:',error?.code||error?.name||'upstream');res.status(502).json({error:'作品状态查询暂不可用，请稍后重试。'});}
 });
}
