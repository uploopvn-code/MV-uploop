// Job history housekeeping.
//
// A project keeps every job it ever ran, and a job's payload carries the full prompt and the
// reference list it was sent with — about 4 KB each. On a long film that history, not the
// graph, is what makes project.json big: measured in a real 243-node project here, jobs were
// 1.97 MB of a 2.29 MB file (1.1 MB of it prompt text alone) while the nodes were 219 KB.
// Every save() rewrites that whole file.
//
// Once a job has settled, its prompt and references are dead weight: the only reader of them
// (madeFromCurrentInputs, for "were these still the shot's current inputs?") looks at a node's
// newest job, and the videos the old ones produced are their own nodes. So strip the heavy
// fields from old settled jobs, and cap how many of those are kept at all.

// Statuses a job never leaves. Anything else — queued, running, needs_review,
// script_completed, or a status added later — is still live and is left untouched.
const SETTLED = ['completed', 'failed', 'cancelled', 'stopped', 'done', 'retried', 'blocked'];
export const isSettled = j => SETTLED.includes(j?.status);
// The payload fields that only matter while a job is in flight.
const HEAVY = ['prompt', 'references', 'timing'];
// How many jobs a project keeps at all. Generous: the queue panel is also a work log.
export const JOB_HISTORY = 400;

// A settled job the uncertainty machinery still compares against the prompt it was sent with:
// a Seedvis render that may have been paid for but never came back (lib/auto.mjs: uncertainJobs
// → madeFromCurrentInputs, the `unsent` branch), or one queued to be re-checked. That can be an
// older job of the node, so these keep their payload whatever their status says.
//
// A job with remote tracking (j.remote.id / pollUrl) is deliberately NOT here: uncertainJobs
// reports those from j.remote alone and never looks at their prompt — and Seedvis jobs all
// carry j.remote, so protecting it would exempt almost every job from compaction.
const stillWatched = j => !!(j.maybeSent || j.conflict || j.recheck || j.recover || j.late);

// The jobs that must stay whole: anything still live or still watched, plus the newest job of
// each node AND KIND. Per kind, because that comparison is per kind — madeFromCurrentInputs
// checks a job against prompts(n)[j.kind] — so a node's last image job still has to be
// readable after a video job ran on the same node.
function keepWhole(jobs) {
  const whole = new Set();
  const newest = new Map();
  for (const j of jobs) {
    if (!isSettled(j) || stillWatched(j)) whole.add(j);
    // jobs are appended in order, so the last one seen for a key is the newest
    newest.set(j.nodeId + '\u0000' + j.kind, j);
  }
  for (const j of newest.values()) whole.add(j);
  return whole;
}

// Trims d.jobs in place. Returns what it did, for the tests and the startup log.
export function compactJobs(d) {
  const jobs = d?.jobs;
  if (!Array.isArray(jobs) || !jobs.length) return { stripped: 0, dropped: 0 };
  const whole = keepWhole(jobs);
  let stripped = 0;
  for (const j of jobs) {
    if (whole.has(j) || !j.payload) continue;
    const had = HEAVY.filter(k => k in j.payload);
    if (!had.length) continue;
    for (const k of had) delete j.payload[k];
    stripped++;
  }
  let dropped = 0;
  if (jobs.length > JOB_HISTORY) {
    let over = jobs.length - JOB_HISTORY;
    d.jobs = jobs.filter(j => {
      if (over <= 0 || whole.has(j)) return true;
      over--;
      dropped++;
      return false;
    });
  }
  return { stripped, dropped };
}
