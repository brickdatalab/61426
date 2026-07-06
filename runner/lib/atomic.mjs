import fs from 'node:fs';

// Atomic write: write to a temp file, fsync, then rename over the target.
// Synchronous — callers are on a control/log path, not a hot loop.
export function writeAtomic(path, str) {
  const tmp = path + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, str);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path);
}

// JSON.parse of a file's contents, or null if missing/unparseable.
export function readJson(path) {
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
