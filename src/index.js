const express = require('express');
const cors = require('cors');
const path = require('node:path');
const { spawn } = require('node:child_process');
const env = require('./config/env');
const { getDb } = require('./db/firebase');
const { logRequest } = require('./utils/terminalLogger');

// Route imports
const chatRoutes = require('./routes/chatRoutes');
const tryitRoutes = require('./routes/tryitRoutes');
const eventRoutes = require('./routes/eventRoutes');
const configRoutes = require('./routes/configRoutes');
const knowledgeRoutes = require('./routes/knowledgeRoutes');
const leadRoutes = require('./routes/leadRoutes');

const app = express();
const controlPanelPath = path.resolve(__dirname, '../public/control-panel.html');
const chatApiDocsPath = path.resolve(__dirname, '../public/chat-api.md');
const demoPagePath = path.resolve(__dirname, '../../bot/index.html');
const widgetScriptPath = path.resolve(__dirname, '../../bot/widget.js');

function openControlPanel(url) {
  const opener = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  const child = spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' });
  child.on('error', error => console.warn(`Could not open control panel automatically: ${error.message}`));
  child.unref();
}

// Initialize Firebase / local persistence
getDb();

// Middlewares
app.use(cors());
app.use(express.json({ limit: '14mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(logRequest);

// GET /health (Section 7.1)
app.get('/', (req, res) => res.redirect('/control-panel'));
app.get(['/control-panel', '/control-panel.html'], (req, res) => {
  res.sendFile(controlPanelPath);
});
app.get('/chat-api.md', (req, res) => {
  res.type('text/markdown').sendFile(chatApiDocsPath);
});
if (env.NODE_ENV !== 'production') {
  app.get(['/demo', '/demo/'], (req, res) => res.sendFile(demoPagePath));
  app.get('/widget.js', (req, res) => res.sendFile(widgetScriptPath));
}

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    service: 'GrapeLabs Omnichannel Bot Core'
  });
});

// API Routes
app.use('/', chatRoutes);
app.use('/', tryitRoutes);
app.use('/', eventRoutes);
app.use('/', configRoutes);
app.use('/', knowledgeRoutes);
app.use('/', leadRoutes);

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal Server Error'
  });
});

// Start Server
if (process.env.NODE_ENV !== 'test') {
  app.listen(env.PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🍇 GrapeLabs Bot API is running on port ${env.PORT}`);
    console.log(`🖥️  Control Panel:   http://localhost:${env.PORT}/control-panel`);
    console.log(`💓 Health Check:    http://localhost:${env.PORT}/health`);
    console.log(`======================================================\n`);
    if (env.AUTO_OPEN_CONTROL_PANEL && env.NODE_ENV !== 'production') {
      openControlPanel(`http://localhost:${env.PORT}/control-panel`);
    }
  });
}

module.exports = app;
