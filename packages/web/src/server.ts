import path from 'node:path';
import express from 'express';
import { connectToServer } from '@mcp-explorer/client';

// One client connection, made once at startup and reused for every HTTP
// request — mirrors how a real client (Claude Desktop, Cursor) keeps a
// single long-lived connection open rather than reconnecting per call.
const client = await connectToServer();

const app = express();
app.use(express.json());
app.use(express.static(path.resolve(import.meta.dirname, '../public')));

app.get('/api/tools', async (_req, res) => {
  const { tools } = await client.listTools();
  res.json(tools);
});

app.post('/api/call', async (req, res) => {
  const { name, arguments: args } = req.body;
  const result = await client.callTool({ name, arguments: args });
  res.json(result);
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`mcp-explorer web dashboard running at http://localhost:${PORT}`);
});
