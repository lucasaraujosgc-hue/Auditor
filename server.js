import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // API to save backup
  app.post('/api/backup', (req, res) => {
    try {
      const backupDir = '/backup';
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      fs.writeFileSync(path.join(backupDir, 'database.json'), JSON.stringify(req.body));
      res.json({ success: true });
    } catch (error) {
      console.error('Error saving backup:', error);
      res.status(500).json({ error: 'Failed to save backup' });
    }
  });

  // API to load backup
  app.get('/api/backup', (req, res) => {
    try {
      const backupPath = '/backup/database.json';
      if (fs.existsSync(backupPath)) {
        const data = fs.readFileSync(backupPath, 'utf8');
        res.json(JSON.parse(data));
      } else {
        res.json(null);
      }
    } catch (error) {
      console.error('Error loading backup:', error);
      res.status(500).json({ error: 'Failed to load backup' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        allowedHosts: true
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

startServer();
