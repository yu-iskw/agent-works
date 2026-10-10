import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { appendResult } from '../results.mjs';

export default class ArtifactsReporter {
  constructor() {
    this.missingEvidence = false;
  }

  onTestEnd(test, result) {
    const id = test.title;
    const dir = join('e2e/artifacts', id);
    mkdirSync(dir, { recursive: true });
    const copied = { png: false, trace: false, video: false };
    for (const attachment of result.attachments) {
      if (typeof attachment.path !== 'string') continue;
      const kind = attachmentKind(attachment);
      if (kind === 'png' && !copied.png) {
        copyFileSync(attachment.path, join(dir, `${id.replaceAll('.', '-')}.png`));
        copied.png = true;
        continue;
      }
      if (kind === 'trace' && !copied.trace) {
        copyFileSync(attachment.path, join(dir, 'trace.zip'));
        copied.trace = true;
        continue;
      }
      if (kind === 'video' && !copied.video) {
        copyFileSync(attachment.path, join(dir, 'video.webm'));
        copied.video = true;
        continue;
      }
      copyFileSync(attachment.path, join(dir, attachment.name.replaceAll('/', '-')));
    }
    const complete = copied.png && copied.trace && copied.video;
    if (result.status === 'passed' && !complete) this.missingEvidence = true;
    appendResult({
      id,
      status: result.status === 'passed' && complete ? 'passed' : 'failed',
      ...metrics(result),
    });
  }

  onEnd() {
    if (this.missingEvidence) throw new Error('missing playwright evidence');
  }
}

function attachmentKind(attachment) {
  if (attachment.name === 'screenshot' || attachment.contentType === 'image/png') return 'png';
  if (attachment.name === 'trace' || attachment.path.endsWith('trace.zip')) return 'trace';
  if (attachment.name === 'video' || attachment.contentType === 'video/webm') return 'video';
  return 'other';
}

function metrics(result) {
  const attachment = result.attachments.find((item) => item.name === 'metrics.json');
  if (attachment?.body === undefined) return {};
  const parsed = JSON.parse(Buffer.from(attachment.body).toString('utf8'));
  return {
    ...(Array.isArray(parsed.durationsMs) ? { durationsMs: parsed.durationsMs } : {}),
    ...(typeof parsed.p95Ms === 'number' ? { p95Ms: parsed.p95Ms } : {}),
  };
}
