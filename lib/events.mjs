// Push channel (server-sent events): the UI holds one open connection and gets a line the moment
// something changes — a graph edit, or an image/video a worker just handed in — so it reloads on the
// change itself instead of waiting for its 4-second timer. Deliberately contentless: an event only
// says "something changed", and the client fetches the state it needs, so no payload can go stale.
// Nothing is queued or replayed; the UI keeps its slow poll as a safety net if an event is missed.
const clients = new Set();

// Tells every open client to reload. `reason` is for the dev console only.
export function notify(reason = 'change') {
  if (!clients.size) return;
  const line = `event: change\ndata: ${JSON.stringify({ reason, at: Date.now() })}\n\n`;
  for (const res of [...clients]) {
    try {
      res.write(line);
    } catch {
      clients.delete(res); // a window that went away between writes
    }
  }
}

export function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // This server sits behind nothing, but be explicit: a buffering proxy would hold events back.
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n'); // the browser reconnects on its own if the server restarts
  clients.add(res);
  // A comment line often enough that an idle connection is never taken for a dead one.
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clear();
    }
  }, 25000);
  const clear = () => {
    clearInterval(ping);
    clients.delete(res);
  };
  req.on('close', clear);
  req.on('error', clear);
  res.on('error', clear);
}

export const clientCount = () => clients.size;
