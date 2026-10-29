#!/usr/bin/env node
// Turns a journey video into one contact sheet (a frame every N seconds, timestamped) so a
// reviewer can scan the whole flow as an image. Runs in the e2e container (Playwright's ffmpeg).
//   node scripts/m1/video-sheet.mjs <video.webm> <out.png> [secondsPerFrame]
import { spawnSync } from 'node:child_process';
import { existsSync, globSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '@playwright/test';

const [video, out, every = '3'] = process.argv.slice(2);
const ffmpeg = globSync('/ms-playwright/ffmpeg-*/ffmpeg-linux')[0];
if (!video || !out || !ffmpeg)
  throw new Error('usage: video-sheet.mjs <video> <out.png> [seconds]; needs Playwright ffmpeg');
const dir = mkdtempSync(join(tmpdir(), 'frames-'));
// The bundled ffmpeg has no fps filter, so seek to each timestamp and take one frame.
for (let index = 0; index < 120; index += 1) {
  const file = join(dir, `f${String(index).padStart(3, '0')}.png`);
  spawnSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(index * Number(every)),
    '-i',
    video,
    '-frames:v',
    '1',
    '-vf',
    'scale=480:-1',
    file,
  ]);
  if (!existsSync(file)) break;
}
const frames = readdirSync(dir)
  .filter((f) => f.endsWith('.png'))
  .sort();
const cells = frames
  .map(
    (f, i) =>
      `<figure><img src="data:image/png;base64,${readFileSync(join(dir, f)).toString('base64')}"><figcaption>${i * Number(every)} s</figcaption></figure>`,
  )
  .join('');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2000, height: 800 } });
await page.setContent(
  `<style>body{margin:8px;font:14px sans-serif;display:grid;grid-template-columns:repeat(4,480px);gap:8px}figure{margin:0}img{width:480px;border:1px solid #999}figcaption{text-align:center}</style>${cells}`,
);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
process.stdout.write(`${frames.length} frames -> ${out}\n`);
