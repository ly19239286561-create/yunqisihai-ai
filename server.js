import 'node:process';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
    mediaSrc: ["'self'", 'https:', 'blob:'], connectSrc: ["'self'", 'https:'],
    objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: null
  }
}}));
app.use(express.json({limit:'30kb'}));
app.use(cookieParser());

const KEY = process.env.HEYGEN_API_KEY?.trim();
const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim()?.toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || '';
const PROD = process.env.NODE_ENV === 'production';
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // R2上传上限1GB
const MAX_DIRECT_BYTES = 32 * 1024 * 1024; // HeyGen资产上传上限32MB
const FILE_TYPES = new Map([['video/mp4','.mp4'],['video/quicktime','.mov'],['video/webm','.webm']]);

if (!ADMIN_EMAIL || ADMIN_PASSWORD.length < 12 || SECRET.length < 32 || !KEY) {
  console.error('缺少 HEYGEN_API_KEY、ADMIN_EMAIL，或 ADMIN_PASSWORD（≥12）/SESSION_SECRET（≥32）未配置。');
  process.exit(1);
}

const r2Ready = ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET'].every(k=>!!process.env[k]);
const s3 = r2Ready ? new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}
}) : null;
const bucket = process.env.R2_BUCKET;

const limitLogin = rateLimit({windowMs:15*60*1000,limit:12,standardHeaders:'draft-7',legacyHeaders:false});
const limitSubmit = rateLimit({windowMs:60*60*1000,limit:30,standardHeaders:'draft-7',legacyHeaders:false});
const SIGN_DAYS = 1;
const now = ()=>Math.floor(Date.now()/1000);
const sign = v => crypto.createHmac('sha256',SECRET).update(v).digest('hex');
function validSession(req) {
  const token=req.cookies.yqsession;
  if(!token || typeof token!=='string')return false;
  const [exp,nonce,mac,...rest]=token.split('.');
  if(rest.length||!exp||!nonce||!mac||!/^[0-9]+$/.test(exp)||Number(exp)<=now())return false;
  const expected=sign(`${exp}.${nonce}`);
  const a=Buffer.from(expected,'hex'),b=Buffer.from(mac,'hex');
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}
function authorized(req,res,next){if(!validSession(req))return res.status(401).json({error:'请先登录工作台'});next();}
function safeError(err){
  const message = String(err?.message || err || '未知错误');
  return message.replaceAll(KEY || '\0','[API KEY]').slice(0,360);
}
function validVideoUrl(raw){
  if(typeof raw !== 'string' || raw.length>2048) return null;
  try{
    const u=new URL(raw);
    if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.includes('.'))return null;
    if(u.hostname==='localhost'||u.hostname.endsWith('.local')||u.hostname.endsWith('.internal'))return null;
    if(/^\d+(\.\d+){3}$/.test(u.hostname)||u.hostname.startsWith('['))return null;
    return u.toString();
  }catch{return null;}
}
async function heygen(path,method='GET',body){
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),30000);
  try{
    const response=await fetch(`https://api.heygen.com${path}`,{
      method,signal:ctrl.signal,
      headers:{'x-api-key':KEY,'Accept':'application/json',...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})
    });
    const text=await response.text();let json;
    try{json=JSON.parse(text);}catch{json={message:text.slice(0,300)};}
    if(!response.ok || (json.error && json.error!==null) || json.code && ![100,200].includes(Number(json.code))) {
      throw new Error(json.message || json.error?.message || json.error || `HeyGen HTTP ${response.status}`);
    }
    return json;
  }finally{clearTimeout(timer);}
}

app.get('/api/health',(_req,res)=>res.json({status:'ok'}));
app.get('/api/session',(req,res)=>res.json({loggedIn:validSession(req),uploadsEnabled:true,uploadMode:r2Ready?'r2':'heygen',maxDirectBytes:MAX_DIRECT_BYTES}));
app.post('/api/login',limitLogin,(req,res)=>{
  const {email,password}=req.body??{};
  const expected = crypto.scryptSync(ADMIN_PASSWORD,'yunqisihai-login',64);
  const actual = crypto.scryptSync(typeof password === 'string' ? password.slice(0,256) : '','yunqisihai-login',64);
  if(String(email||'').toLowerCase()!==ADMIN_EMAIL || !crypto.timingSafeEqual(expected,actual)) return res.status(401).json({error:'邮箱或密码不正确'});
  const exp=now()+SIGN_DAYS*86400, nonce=crypto.randomBytes(16).toString('hex');
  const v=`${exp}.${nonce}`;
  res.cookie('yqsession',`${v}.${sign(v)}`,{httpOnly:true,sameSite:'strict',secure:PROD,maxAge:SIGN_DAYS*86400000,path:'/'});
  res.json({ok:true});
});
app.post('/api/logout',authorized,(_req,res)=>{res.clearCookie('yqsession',{httpOnly:true,sameSite:'strict',secure:PROD,path:'/'});res.json({ok:true});});

// 小视频无需第三方对象存储，由受保护的后端转发到HeyGen（最大32MB）。
// Express raw仅接受明确的MP4/WEBM Content-Type，避免把API密钥暴露在浏览器。
const rawVideo = express.raw({type:['video/mp4','video/webm'],limit:'32mb'});
app.post('/api/uploads/heygen',authorized,limitSubmit,rawVideo,async(req,res)=>{
  try{
    const type=(req.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(!['video/mp4','video/webm'].includes(type)||!Buffer.isBuffer(req.body)||!req.body.length||req.body.length>MAX_DIRECT_BYTES){
      return res.status(400).json({error:'HeyGen直接上传仅支持32MB以内的MP4/WEBM视频'});
    }
    const form=new FormData();
    form.append('file',new Blob([req.body],{type}),type==='video/mp4'?'tour-video.mp4':'tour-video.webm');
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),120000);
    let response;
    try{
      response=await fetch('https://api.heygen.com/v3/assets',{
        method:'POST',headers:{'x-api-key':KEY,'Accept':'application/json'},body:form,signal:ctrl.signal
      });
    }finally{clearTimeout(timer);}
    const text=await response.text();
    let result;
    try{result=JSON.parse(text);}catch{result={message:text.slice(0,250)};}
    if(!response.ok||result.error||(result.code&&![100,200].includes(Number(result.code)))){
      throw new Error(result.message||result.error?.message||'HeyGen上传失败 '+response.status);
    }
    const assetId=result.data?.asset_id;
    if(typeof assetId!=='string'||!assetId)throw new Error('HeyGen未返回素材ID');
    res.json({assetId});
  }catch(e){res.status(502).json({error:'直传HeyGen失败：'+safeError(e)});}
});

// 浏览器使用 R2 签名 URL 直传，不经过本服务服务器转存视频。
app.post('/api/uploads/sign',authorized,limitSubmit,async(req,res)=>{
  try{
    if(!r2Ready)return res.status(400).json({error:'尚未配置 R2 存储，请先使用 HTTPS 视频直链'});
    const {type,size}=req.body??{};
    if(!FILE_TYPES.has(type)||!Number.isInteger(size)||size<=0||size>MAX_VIDEO_BYTES)return res.status(400).json({error:'仅支持 MP4/MOV/WEBM，文件需小于1GB'});
    const key=`videos/${crypto.randomUUID()}${FILE_TYPES.get(type)}`;
    const command=new PutObjectCommand({Bucket:bucket,Key:key,ContentType:type});
    const uploadUrl=await getSignedUrl(s3,command,{expiresIn:900});
    res.json({key,uploadUrl});
  }catch(e){res.status(502).json({error:'获取上传链接失败：'+safeError(e)});}
});

const LANGUAGES = new Set(['English (United States)','Korean','Japanese','French (France)','German (Germany)','Spanish (Spain)','Thai','Vietnamese','Chinese (Mandarin, Simplified)']);
app.post('/api/translate',authorized,limitSubmit,async(req,res)=>{
  try{
    const {assetId,fileKey,videoUrl,language,mode,enableCaption}=req.body??{};
    if(!LANGUAGES.has(language)||!['speed','precision','audio'].includes(mode))return res.status(400).json({error:'请选择有效的语言和翻译模式'});
    let video;
    if(assetId){
      if(typeof assetId!=='string'||!/^[-_a-zA-Z0-9]{6,200}$/.test(assetId))return res.status(400).json({error:'无效HeyGen素材ID'});
      video={type:'asset_id',asset_id:assetId};
    }else if(fileKey){
      if(!r2Ready)return res.status(400).json({error:'未配置上传存储'});
      if(typeof fileKey!=='string'||!/^videos\/[a-f0-9-]{36}\.(mp4|mov|webm)$/.test(fileKey))return res.status(400).json({error:'无效文件标识'});
      const obj=await s3.send(new HeadObjectCommand({Bucket:bucket,Key:fileKey}));
      if(!obj.ContentLength||obj.ContentLength>MAX_VIDEO_BYTES)return res.status(400).json({error:'上传文件大小异常'});
      const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket,Key:fileKey}),{expiresIn:3*3600});
      video={type:'url',url};
    }else{
      const url=validVideoUrl(videoUrl);
      if(!url)return res.status(400).json({error:'请填写可直接下载视频的 HTTPS 链接'});
      video={type:'url',url};
    }
    const request={video,output_languages:[language],mode:mode==='audio'?'speed':mode,
      translate_audio_only:mode==='audio',enable_caption:!!enableCaption,
      enable_speech_enhancement:true,enable_dynamic_duration:true};
    const result=await heygen('/v3/video-translations','POST',request);
    const ids=result.data?.video_translation_ids||result.video_translation_ids;
    if(!Array.isArray(ids)||!ids[0])throw new Error('HeyGen 未返回任务ID：'+JSON.stringify(result).slice(0,180));
    res.json({id:ids[0],status:'submitted'});
  }catch(e){res.status(502).json({error:'提交翻译失败：'+safeError(e)});}
});
app.get('/api/translate/:id',authorized,async(req,res)=>{
  try{
    if(!/^[a-zA-Z0-9_-]{5,120}$/.test(req.params.id))return res.status(400).json({error:'无效任务ID'});
    const result=await heygen(`/v3/video-translations/${encodeURIComponent(req.params.id)}`);
    const data=result.data||result;
    const safeUrl=x=>typeof x==='string' && /^https:\/\//.test(x) ? x : null;
    res.json({id:req.params.id,status:data.status||'unknown',videoUrl:safeUrl(data.video_url),captionUrl:safeUrl(data.srt_caption_url),failureMessage:data.failure_message||null});
  }catch(e){res.status(502).json({error:'查询任务失败：'+safeError(e)});}
});
app.use(express.static('public',{index:'index.html',dotfiles:'ignore',maxAge:'10m'}));
app.use((_req,res)=>res.status(404).json({error:'接口不存在'}));
const port=Number(process.env.PORT)||3000;
app.listen(port,()=>console.log(`云起四海工作台运行于 ${port} 端口；上传：${r2Ready?'R2':'HeyGen直接上传（32MB）'}`));
