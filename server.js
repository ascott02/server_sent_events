
'use strict';

const express = require('express');
const path = require('node:path');

const app = express();
const clients = new Set();
let nextId = 0;

app.use(express.json({ limit: '1kb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
