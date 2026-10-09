/**
 * LSCORExAPI Main Application Entrypoint
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { router } from './routes/api.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Enable CORS & JSON parsing
app.use(cors());
app.use(express.json());

// Serve static interactive documentation & live console
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));

// Mount API routes
app.use('/', router);

// Explicit docs and root route
app.get(['/', '/docs'], (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Full API Documentation (pure reference for every endpoint)
app.get(['/documentation/api', '/documentation', '/api-docs'], (req, res) => {
  res.sendFile(path.join(publicDir, 'documentation.html'));
});

// Dedicated Match Scorecard & SSE Live Streaming Next Page
app.get(['/match', '/match/:id', '/score/:id'], (req, res) => {
  res.sendFile(path.join(publicDir, 'match.html'));
});

// Start HTTP server
const server = app.listen(PORT, HOST, () => {
  console.log(`⚡ LSCORExAPI listening on http://${HOST}:${PORT}`);
  console.log(`📖 Interactive API Docs & SSE Console: http://${HOST}:${PORT}/docs`);
});

// Process signal handling
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => process.exit(0));
});

export default app;
