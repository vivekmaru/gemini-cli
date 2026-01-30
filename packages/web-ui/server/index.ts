import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { WorktreeManager } from './git.js';
import { GeminiService } from './gemini.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Only enable CORS in development
if (process.env.NODE_ENV !== 'production') {
    app.use(cors({ origin: 'http://localhost:5173' }));
}

app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: process.env.NODE_ENV !== 'production' ? {
    origin: 'http://localhost:5173',
  } : undefined,
});

const projectRoot = process.cwd();
const gitManager = new WorktreeManager(projectRoot);
const geminiService = new GeminiService(projectRoot);

// API Routes
app.get('/api/worktrees', async (_req, res) => {
  try {
    const worktrees = await gitManager.listWorktrees();
    res.json(worktrees);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/worktrees', async (req, res) => {
  const { branch, path: relativePath } = req.body;
  try {
    const worktree = await gitManager.createWorktree(branch, relativePath);
    res.json(worktree);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/diff', async (req, res) => {
    const { path: worktreePath } = req.query;
    if (typeof worktreePath !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }
    try {
        const diff = await gitManager.getDiff(worktreePath);
        res.json({ diff });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

app.post('/api/context', async (req, res) => {
    const { path } = req.body;
    if (typeof path !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }
    try {
        await geminiService.switchContext(path);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

// Socket.io for Chat
io.on('connection', (socket) => {
  console.log('Client connected');

  socket.on('sendMessage', async (message) => {
    try {
      await geminiService.sendMessage(message, (chunk) => {
          socket.emit('messageChunk', chunk);
      });
      socket.emit('messageDone');
    } catch (error) {
      socket.emit('error', String(error));
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Serve frontend in production
const clientDist = path.join(__dirname, '../client');
app.use(express.static(clientDist));

// Handle SPA routing
app.get('*', (req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(clientDist, 'index.html'));
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
