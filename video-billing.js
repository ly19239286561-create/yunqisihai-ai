import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
try { ffprobePath = process.env.FFPROBE_PATH || require('ffprobe-static').path; } catch { /* local CLI fallback */ }
const execFileAsync = promisify(execFile);
export const RATE_CENTS_PER_SECOND = 65;
export const RATE_POINTS_PER_SECOND = 0.65;
export const MAX_DURATION_SECONDS = 1800;

export function billableSeconds(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_DURATION_SECONDS)
    throw new RangeError('仅支持时长大于0秒、且不超过30分钟的视频。');
  return Math.ceil(seconds);
}
export function billedPoints(seconds) {
  return (billableSeconds(seconds) * RATE_CENTS_PER_SECOND / 100).toFixed(2);
}
export async function probeVideoDuration(buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || !['video/mp4', 'video/webm'].includes(contentType))
    throw new RangeError('请上传MP4或WEBM格式视频。');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yq-video-'));
  const file = path.join(dir, contentType === 'video/mp4' ? 'video.mp4' : 'video.webm');
  try {
    await fs.writeFile(file, buffer, { flag: 'wx', mode: 0o600 });
    const { stdout } = await execFileAsync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=duration', '-of', 'json', file], { timeout: 14000, maxBuffer: 16384 });
    const data = JSON.parse(stdout);
    const durations = [data?.format?.duration, ...(data?.streams || []).map(s=>s.duration)]
      .map(Number).filter(s => Number.isFinite(s) && s > 0);
    if (!durations.length) throw new RangeError('无法核实视频时长，请使用带完整时长信息的视频文件。');
    const duration = Math.max(...durations);
    return { durationSeconds: duration, billedSeconds: billableSeconds(duration), costPoints: billedPoints(duration) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
