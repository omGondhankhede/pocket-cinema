const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('PocketFlix Cinema Backend is Live & Running!');
});

io.on('connection', (socket) => {
  console.log(`[+] TV Connected: ${socket.id}`);
  socket.on('join_room', (roomCode) => {
    socket.join(roomCode);
    console.log(`[+] TV ${socket.id} joined Room: ${roomCode}`);
  });
  socket.on('disconnect', () => {
    console.log(`[-] TV Disconnected: ${socket.id}`);
  });
});

app.get('/proxy-stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing stream URL');

  try {
    const response = await fetch(targetUrl);
    let playlistText = await response.text();
    const lines = playlistText.split('\n');
    const sanitizedLines = lines.filter(line => !line.includes('TYPE="AUDIO"') && !line.includes("TYPE='AUDIO'"));
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(sanitizedLines.join('\n'));
  } catch (err) {
    res.status(500).send('Failed to proxy stream');
  }
});

async function sniffStream(tmdbId) {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH || '/opt/render/project/puppeteer/chrome/linux-155.0.8059.79/chrome-linux64/chrome',
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    await page.setRequestInterception(true);
    
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    return new Promise(async (resolve) => {
      let resolved = false;
      const timer = setTimeout(async () => {
        if (!resolved) {
          if (browser) await browser.close().catch(() => {});
          resolve(null);
        }
      }, 45000);

      page.on('response', async (response) => {
        const url = response.url();
        if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('google')) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            setTimeout(async () => { if (browser) await browser.close().catch(() => {}); }, 1500);
            resolve(url);
          }
        }
      });

      try {
        await page.goto(`https://www.moviesnexus.fun/movie/${tmdbId}`, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 6000));
        
        const frames = page.frames();
        for (const frame of frames) {
          try {
            await frame.evaluate(() => {
              document.querySelectorAll('button, .jw-display-icon-container, .vjs-big-play-button, #play, video').forEach(t => t.click());
              const v = document.querySelector('video');
              if (v) v.play().catch(() => {});
            });
          } catch (e) {}
        }
      } catch (err) {
        console.log(`[!] Page Error: ${err.message}`);
      }
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}

app.get('/resolve', async (req, res) => {
  const tmdbId = req.query.tmdb || '550';
  console.log(`[*] Manual click resolve for TMDB: ${tmdbId}`);
  
  try {
    const rawUrl = await sniffStream(tmdbId);
    if (rawUrl) {
      res.json({ status: 'ok', streamUrl: `/proxy-stream?url=${encodeURIComponent(rawUrl)}` });
    } else {
      res.status(404).json({ status: 'error', message: 'Stream not found' });
    }
  } catch (err) {
    console.error(`[!] Backend Crash Prevented: ${err.message}`);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Cloud Server running on port ${PORT}`);
});
