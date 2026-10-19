---
marp: true
paginate: true
style: |
  section {font-size: 18pt;}
---

<style>
.columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2rem;
  align-items: start;
}
.flow {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 1rem;
  align-items: center;
  text-align: center;
}
.flow .node {
  border: 1px solid currentColor;
  border-radius: 0.5rem;
  padding: 0.75rem;
}
</style>

# Server-Sent Events

### HTTP server push with Node.js and Express

CSC 667/867 — Internet Applications

---

# The problem: how do clients learn about changes?

<div class="columns">
<div>
<h3>Polling</h3>
<p>Browser asks repeatedly:</p>
<pre>GET /status
GET /status
GET /status</pre>
<p>Many responses contain no new information.</p>
</div>
<div>
<h3>Server-Sent Events</h3>
<p>Browser opens one HTTP request:</p>
<pre>GET /events
  event 1
  event 2
  event 3</pre>
<p>Server pushes updates as they happen.</p>
</div>
</div>

---

# SSE: one-way streaming over HTTP

<div class="flow">
<div class="node"><strong>Browser</strong><p>EventSource</p><p>GET /events</p></div>
<div>⟷</div>
<div class="node"><strong>Express server</strong><p>Open HTTP response</p><p>Write events over time</p></div>
</div>

- Server → browser: **SSE stream**, kept open.
- Browser → server: **ordinary HTTP** requests, such as `POST`.
- No WebSocket upgrade; the response is `text/event-stream`.

---

# The SSE wire format

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
```

```text
retry: 2000

id: 41
event: notice
data: {"text":"Room 12 cleared"}

: heartbeat

```

**Each event ends with a blank line.** The stream remains open.

---

# The event fields

| Field | Meaning |
|---|---|
| `data:` | Message payload as text; JSON is common |
| `event:` | Named event; otherwise dispatches `message` |
| `id:` | Updates the client's last event ID |
| `retry:` | Browser reconnection delay in milliseconds |
| `:` | Comment; useful for keepalive heartbeats |

- Multiple `data:` lines form one payload, joined with newlines.
- Events must be UTF-8 text, separated by a blank line.

---

# Example: announcements to multiple browsers

<div class="flow">
<div class="node"><strong>Browser A</strong><p>GET /events</p><p>POST /announce</p></div>
<div>⇄</div>
<div class="node"><strong>Express</strong><p>Set of open responses</p><p>Broadcast to subscribers</p></div>
</div>

<div class="flow">
<div class="node"><strong>Browser B</strong><p>GET /events</p></div>
<div>←</div>
<div class="node"><strong>Same Express process</strong><p>Write to Browser B's response</p></div>
</div>

- The `POST` changes server-side state or triggers an event.
- Every connected SSE client receives the announcement.

---

# Express setup — `server.js`

```javascript
'use strict';

const express = require('express');
const path = require('node:path');

const app = express();
const clients = new Set();
let nextId = 0;

app.use(express.json({ limit: '1kb' }));
app.use(express.static(path.join(__dirname, 'public')));
```

Each client is represented by an **open HTTP response**.

---

# SSE endpoint — `server.js`

```javascript
app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  clients.add(res);

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});
```

**`res.write()` streams; `res.end()` would close the connection.**

---

# Publish and broadcast — `server.js`

```javascript
app.post('/announce', (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 200) {
    return res.status(400).json({ error: 'text must be 1-200 characters' });
  }

  const payload = `id: ${++nextId}\nevent: notice\ndata: ${JSON.stringify({ text })}\n\n`;
  for (const client of clients) {
    if (!client.write(payload)) client.end();
  }
  res.json({ id: nextId });
});

app.listen(3000, () => console.log('http://localhost:3000'));
```

`write()` returning `false` signals backpressure; this example closes slow streams.

---

# Browser page — `public/index.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Server-Sent Events Demo</title>
</head>
<body>
  <h1>Announcements</h1>
  <button id="send" disabled>Announce room clear</button>
  <ul id="feed"></ul>
  <script>
    // Client code on the next slide
  </script>
</body>
</html>
```

---

# Browser client — inside `<script>`

```javascript
const source = new EventSource('/events');
const sendButton = document.querySelector('#send');

source.onopen = () => { sendButton.disabled = false; };
source.onerror = () => { sendButton.disabled = true; };

source.addEventListener('notice', event => {
  const li = document.createElement('li');
  li.textContent = JSON.parse(event.data).text;
  document.querySelector('#feed').prepend(li);
});

sendButton.onclick = async () => {
  await fetch('/announce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Room 12 cleared' })
  });
};
```

---

# Run and verify

```bash
npm install express
node server.js
```

Open `http://localhost:3000` in **two browser tabs**; click the button in either.

Or use two terminals:

```bash
# Terminal A: observe the open event stream
curl -N http://localhost:3000/events

# Terminal B: publish an event
curl -X POST http://localhost:3000/announce \
  -H 'Content-Type: application/json' \
  -d '{"text":"Room 12 cleared"}'
```

Expected: Terminal A receives an `id`, `event: notice`, and `data:` payload.

---

# Disconnects and reconnection

- `EventSource` **automatically reconnects** after a dropped connection.
- `retry: 2000` requests a 2-second reconnect interval.
- The browser sends `Last-Event-ID` when reconnecting after an event with `id:`.
- `source.close()` stops reconnecting; HTTP `204` can tell the client to stop.
- On the server, `res.on('close')` removes the disconnected client.

**A new connection does not automatically receive missed events.**

---

# Delivery guarantees are an application decision

<div class="columns">
<div>
<h3>Demo behavior</h3>
<ul>
<li>Events exist only during delivery.</li>
<li>Disconnected clients miss broadcasts.</li>
<li>IDs identify events but do not enable replay alone.</li>
</ul>
</div>
<div>
<h3>For reliable catch-up</h3>
<ul>
<li>Store events in an ordered log.</li>
<li>Read <code>Last-Event-ID</code>.</li>
<li>Replay retained events after that ID.</li>
<li>Handle duplicates and gaps.</li>
</ul>
</div>
</div>

**SSE is a transport, not a durable message queue.**

---

# Operational requirements

- **Proxies:** disable response buffering; keep `proxy_read_timeout` above heartbeat interval.
- **Compression:** avoid buffered compression or flush each SSE chunk.
- **Backpressure:** bound memory; do not queue indefinitely for slow clients.
- **Security:** authenticate subscriptions and authorize each event stream.
- **Browser limits:** HTTP/1.1 commonly allows only six connections per origin; HTTP/2 multiplexes streams.
- **Authentication:** native `EventSource` cannot attach arbitrary authorization headers; cookies work with appropriate protections.

---

# Scale: one process to many

<div class="flow">
<div class="node"><strong>Express A</strong><p>Local SSE subscribers</p></div>
<div>← events →</div>
<div class="node"><strong>Redis Pub/Sub</strong><p>Cross-process notifications</p></div>
</div>

<div class="flow">
<div class="node"><strong>Express B</strong><p>Local SSE subscribers</p></div>
<div>← events ←</div>
<div class="node"><strong>Publishers</strong><p>Business logic</p></div>
</div>

- Redis is **not required** for SSE within one Node process.
- Redis Pub/Sub distributes events but **does not guarantee replay**.
- Durable replay requires retained history, such as a database or event log.

---

# Choosing a transport

| Approach | Direction | Good fit | Main cost |
|---|---|---|---|
| Polling | Client → server | Infrequent status checks | Repeated requests |
| SSE | Server → client | Notifications, live feeds, job progress | Long-lived connections |
| WebSocket | Both directions | Games, chat, collaborative editing | Connection and protocol management |

**Use SSE for server push; use WebSockets for frequent, bidirectional interaction.**

---

# Check for understanding

1. Why must the SSE response remain open?
2. Why is `res.write()` used instead of `res.send()`?
3. What happens if a client disconnects during three announcements?
4. What does `Last-Event-ID` make possible, and what else is required?
5. How can a browser send data *to* an SSE server?

**Core idea:** SSE uses an ordinary HTTP response as a long-lived event stream.

---

# References

1. [MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
2. [StackPractices: SSE with Node.js and Express](https://stackpractices.com/recipes/server-sent-events-node/)
3. [Stack Overflow: SSE in Express](https://stackoverflow.com/questions/34657222/how-to-use-server-sent-events-in-express-js)
4. [Baynes: Real-time Web Applications with SSE](https://blog.bayn.es/real-time-web-applications-with-server-sent-events-pt-1/)
5. [Express: Compression middleware and SSE](https://expressjs.com/en/resources/middleware/compression/)
