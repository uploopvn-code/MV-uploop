// Seedvis capacity shared by every open window.
//
// The 48 slots are a property of the Seedvis ACCOUNT (16 generating + 32 waiting), not of a
// window, so each project's queue must draw from one pool. Every window is its own process,
// so the pool lives in the shared data folder: one file per slot, claimed with the O_EXCL
// flag ('wx'), which the OS makes atomic — two processes asking at the same instant cannot
// both win. A window that holds no slot simply waits and tries again; nothing is sent to
// Seedvis and nothing is billed.
//
// Crash safety has two layers: a window that closes cleanly calls releaseAll(), and a window
// that is killed leaves its slot files behind — those name the holder's pid, so the next
// acquire() reclaims any slot whose process is gone or whose lease has aged past TTL.
import fs from 'node:fs';
import path from 'node:path';
import { data, port } from './config.mjs';
import { pidAlive } from './projects.mjs';

const SLOT_DIR = path.join(data, 'seedvis-slots');
export const CAP = Math.max(1, Number(process.env.MV_SEEDVIS_CONCURRENCY) || 48);
// Longer than the longest generation a slot can cover, so a live job is never evicted.
const TTL = Math.max(60000, Number(process.env.MV_SEEDVIS_SLOT_TTL) || 2 * 60 * 60 * 1000);
const slotFile = i => path.join(SLOT_DIR, i + '.slot');
const mine = new Map(); // slot index → jobId

const readSlot = f => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
// A slot is free to take over when its file is unreadable, its holder is gone, or its lease
// has expired. Returns true when the stale file was removed.
function reclaim(f) {
  const s = readSlot(f);
  if (s && pidAlive(s.pid) && Date.now() - (s.at || 0) < TTL) return false;
  try {
    fs.unlinkSync(f);
  } catch {}
  return true;
}

// Takes one slot for `jobId`, or returns null when the account is full. Never throws: a
// filesystem problem must leave the job queued, not fail it.
export function acquire(jobId) {
  try {
    fs.mkdirSync(SLOT_DIR, { recursive: true });
    const body = JSON.stringify({ pid: process.pid, port, jobId, at: Date.now() });
    // Two passes: claim a free slot first, and only walk the slots again — reclaiming dead
    // ones — when the pool looks full, so the common case touches no extra files.
    for (const retry of [false, true])
      for (let i = 0; i < CAP; i++) {
        const f = slotFile(i);
        if (retry && !reclaim(f)) continue;
        try {
          fs.writeFileSync(f, body, { flag: 'wx' });
          mine.set(i, jobId);
          return i;
        } catch {
          // taken by another window (or by us); try the next one
        }
      }
  } catch {}
  return null;
}

export function release(slot) {
  if (slot === null || slot === undefined) return;
  mine.delete(slot);
  try {
    const s = readSlot(slotFile(slot));
    if (!s || s.pid === process.pid) fs.unlinkSync(slotFile(slot));
  } catch {}
}

// Closing a window hands its slots back at once instead of leaving them for the TTL.
export function releaseAll() {
  for (const slot of [...mine.keys()]) release(slot);
}

// How many slots the whole account has free right now — shown in the queue so a waiting job
// explains itself ("the account is full", not "this window is stuck").
export function freeSlots() {
  try {
    let used = 0;
    for (let i = 0; i < CAP; i++) {
      const s = readSlot(slotFile(i));
      if (s && pidAlive(s.pid) && Date.now() - (s.at || 0) < TTL) used++;
    }
    return CAP - used;
  } catch {
    return CAP;
  }
}
