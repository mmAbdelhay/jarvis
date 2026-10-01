import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { spawn } from 'child_process';
import path from 'path';

const mode = process.argv[2] || 'stills';
const FPS = 30;
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('PAGEERR', e.message)); page.on('console', m => console.log('CONSOLE', m.text()));
await page.goto('file://' + path.resolve('teaser.html') + '?capture=1');
await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode().catch(() => {}))); });

if (mode === 'stills') {
  const ts = process.argv.slice(3).map(Number);
  for (const t of ts) {
    await page.evaluate(t => render(t), t);
    await page.screenshot({ path: `still_${t}.png` });
  }
} else {
  const dur = await page.evaluate(() => DURATION);
  const n = Math.round(dur * FPS);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'video_silent.mp4'], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let i = 0; i < n; i++) {
    await page.evaluate(t => render(t), i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 90 === 0) console.log(`frame ${i}/${n}`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
}
await browser.close();
