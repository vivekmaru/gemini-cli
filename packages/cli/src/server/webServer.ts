import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { getPty } from '@google/gemini-cli-core';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const indexHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Gemini CLI Web</title>
  <link rel="stylesheet" href="/xterm/xterm.css" />
  <script src="/xterm/xterm.js"></script>
  <script src="/xterm-addon-fit/xterm-addon-fit.js"></script>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    body { margin: 0; padding: 0; background: #000; height: 100vh; overflow: hidden; }
    #terminal { height: 100%; width: 100%; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <script>
    const socket = io();
    const term = new Terminal({
      cursorBlink: true,
      macOptionIsMeta: true,
      scrollback: 10000,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      theme: {
        background: '#000000',
        foreground: '#ffffff',
      }
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    window.addEventListener('resize', () => {
      fitAddon.fit();
      socket.emit('resize', { cols: term.cols, rows: term.rows });
    });

    term.onData(data => {
      socket.emit('input', data);
    });

    // Initial resize
    socket.emit('resize', { cols: term.cols, rows: term.rows });

    socket.on('output', data => {
      term.write(data);
    });

    socket.on('disconnect', () => {
      term.write('\\r\\n\\x1b[31mConnection lost.\\x1b[0m\\r\\n');
    });
  </script>
</body>
</html>
`;

export async function startWebServer(port: number, cmd: string, args: string[]) {
  const app = express();
  const server = createServer(app);
  const io = new Server(server);

  // Serve xterm assets
  try {
    const xtermPath = path.dirname(require.resolve('xterm/package.json'));
    const xtermAddonFitPath = path.dirname(require.resolve('xterm-addon-fit/package.json'));

    app.use('/xterm', express.static(path.join(xtermPath, 'lib'))); // .js
    app.use('/xterm', express.static(path.join(xtermPath, 'css'))); // .css
    app.use('/xterm-addon-fit', express.static(path.join(xtermAddonFitPath, 'lib'))); // .js
  } catch (e) {
    console.warn('Could not resolve xterm paths, frontend might not work:', e);
  }

  app.get('/', (req, res) => {
    res.send(indexHtml);
  });

  io.on('connection', async (socket) => {
    const ptyInfo = await getPty();
    if (!ptyInfo) {
      socket.emit(
        'output',
        'Error: node-pty not found. Cannot start terminal session.\\r\\n',
      );
      return;
    }

    const ptyProcess = ptyInfo.module.spawn(cmd, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env, COLORTERM: 'truecolor' },
    });

    const onDataDispose = ptyProcess.onData((data: string) => {
      socket.emit('output', data);
    });

    socket.on('input', (data: string) => {
      ptyProcess.write(data);
    });

    socket.on('resize', (size: { cols: number; rows: number }) => {
      if (
        size &&
        typeof size.cols === 'number' &&
        typeof size.rows === 'number'
      ) {
        ptyProcess.resize(size.cols, size.rows);
      }
    });

    socket.on('disconnect', () => {
      onDataDispose.dispose();
      ptyProcess.kill();
    });

    ptyProcess.onExit(() => {
        socket.disconnect();
    });
  });

  server.listen(port, () => {
    console.log(`Gemini CLI Web Server listening on http://localhost:${port}`);
  });
}
