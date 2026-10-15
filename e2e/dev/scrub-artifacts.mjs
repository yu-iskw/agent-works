import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;

const REDACTION_PATTERNS = [
  [/(["']authorization["']\s*:\s*["'])[^"']*["']/gi, '$1[REDACTED]"'],
  [/(["']x-goog-iap-jwt-assertion["']\s*:\s*["'])[^"']*["']/gi, '$1[REDACTED]"'],
  [
    /(["']name["']\s*:\s*["'](?:authorization|x-goog-iap-jwt-assertion)["']\s*,\s*["']value["']\s*:\s*["'])[^"']*["']/gi,
    '$1[REDACTED]"',
  ],
  [/(\bauthorization\s*:\s*bearer\s+)\S+/gi, '$1[REDACTED]'],
  [/(\bauthorization\s*:\s*)(?!\[REDACTED\])[^\r\n"']+/gi, '$1[REDACTED]'],
  [/(\bx-goog-iap-jwt-assertion\s*:\s*)(?!\[REDACTED\])[^\r\n"']+/gi, '$1[REDACTED]'],
  [/(\bbearer\s+)eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, '$1[REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
];

const LEAK_PATTERNS = [
  /\bbearer\s+eyJ[A-Za-z0-9_-]+/i,
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /["']authorization["']\s*:\s*["'](?!\[REDACTED\])[^"']+["']/i,
  /["']x-goog-iap-jwt-assertion["']\s*:\s*["'](?!\[REDACTED\])[^"']+["']/i,
];

const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true });

function secretsFromEnv(env = process.env) {
  const values = [];
  for (const key of ['AW_DEV_ID_TOKEN_A', 'AW_DEV_ID_TOKEN_B']) {
    const raw = env[key];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      values.push(raw.trim());
    }
  }
  return values;
}

export function scrubText(text, secrets = []) {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    out = out.replaceAll(secret, '[REDACTED_TOKEN]');
    const urlEncoded = encodeURIComponent(secret);
    if (urlEncoded !== secret) {
      out = out.replaceAll(urlEncoded, '[REDACTED_TOKEN]');
    }
  }
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function scrubBuffer(buffer, secrets = []) {
  let decoded;
  try {
    decoded = utf8FatalDecoder.decode(buffer);
  } catch {
    return buffer;
  }
  const scrubbed = scrubText(decoded, secrets);
  return scrubbed === decoded ? buffer : Buffer.from(scrubbed, 'utf8');
}

function findEocdOffset(buffer) {
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIR_SIG) {
      return offset;
    }
  }
  throw new Error('Invalid or unsupported ZIP archive: missing End of Central Directory');
}

export function readZipBuffer(buffer) {
  const eocdOffset = findEocdOffset(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (cdOffset === 0xffffffff || totalEntries === 0xffff) {
    throw new Error('ZIP64 archives are not supported by scrub-artifacts');
  }

  const entries = [];
  let pos = cdOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(pos) !== CENTRAL_DIR_HEADER_SIG) {
      throw new Error('Invalid Central Directory header in ZIP archive');
    }
    const method = buffer.readUInt16LE(pos + 10);
    const modTime = buffer.readUInt16LE(pos + 12);
    const modDate = buffer.readUInt16LE(pos + 14);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localHeaderOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');

    if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIG) {
      throw new Error(`Invalid Local File Header for entry ${name}`);
    }
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      data = inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} in ${name}`);
    }

    entries.push({ name, method, modTime, modDate, data });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawData = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const method = entry.method === 8 ? 8 : 0;
    const compressed = method === 8 ? deflateRawSync(rawData) : rawData;
    const entryCrc = crc32(rawData) >>> 0;
    const modTime = entry.modTime ?? 0;
    const modDate = entry.modDate ?? 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(modTime, 10);
    localHeader.writeUInt16LE(modDate, 12);
    localHeader.writeUInt32LE(entryCrc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIR_HEADER_SIG, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(modTime, 12);
    centralHeader.writeUInt16LE(modDate, 14);
    centralHeader.writeUInt32LE(entryCrc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);

    centralParts.push(centralHeader, nameBuf);
    localOffset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIR_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

function listFilesRecursive(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results.sort((a, b) => a.localeCompare(b));
}

function assertBufferClean(buffer, label, secrets) {
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    const utf8Bytes = Buffer.from(secret, 'utf8');
    const utf16Bytes = Buffer.from(secret, 'utf16le');
    if (buffer.includes(utf8Bytes) || buffer.includes(utf16Bytes)) {
      throw new Error(`Unredacted secret token detected in ${label}`);
    }
  }
  const text = buffer.toString('utf8');
  for (const pattern of LEAK_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Unredacted JWT or auth header detected in ${label}`);
    }
  }
}

export function verifyArtifactsClean(rootDir, secrets = []) {
  for (const filePath of listFilesRecursive(rootDir)) {
    const raw = readFileSync(filePath);
    assertBufferClean(raw, filePath, secrets);
    if (extname(filePath).toLowerCase() === '.zip') {
      const entries = readZipBuffer(raw);
      for (const entry of entries) {
        assertBufferClean(entry.data, `${filePath}#${entry.name}`, secrets);
      }
    }
  }
}

export function scrubArtifactsDirectory(rootDir, options = {}) {
  const secrets = options.secrets ?? secretsFromEnv(options.env ?? process.env);
  let filesScanned = 0;
  let zipArchivesScrubbed = 0;

  for (const filePath of listFilesRecursive(rootDir)) {
    filesScanned += 1;
    const raw = readFileSync(filePath);
    if (extname(filePath).toLowerCase() === '.zip') {
      const entries = readZipBuffer(raw);
      const scrubbedEntries = entries.map((entry) => ({
        ...entry,
        data: scrubBuffer(entry.data, secrets),
      }));
      writeFileSync(filePath, createZipBuffer(scrubbedEntries));
      zipArchivesScrubbed += 1;
    } else {
      const scrubbed = scrubBuffer(raw, secrets);
      if (scrubbed !== raw) {
        writeFileSync(filePath, scrubbed);
      }
    }
  }

  verifyArtifactsClean(rootDir, secrets);
  return { filesScanned, zipArchivesScrubbed };
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  const targetDir = resolve(process.argv[2] ?? 'e2e/artifacts');
  try {
    const stat = statSync(targetDir, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) {
      process.stderr.write(`Artifact directory not found: ${targetDir}\n`);
      process.exit(1);
    }
    const { filesScanned, zipArchivesScrubbed } = scrubArtifactsDirectory(targetDir);
    process.stdout.write(
      `Scrubbed ${filesScanned} artifact file(s) (${zipArchivesScrubbed} zip archive(s)).\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Artifact scrubbing failed';
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
