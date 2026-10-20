const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

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
    const response = await fetch(targetUrl, {
      headers: { 'Referer': 'https://www.moviesnexus.fun/' }
    });
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

// SMART PUPPETEER API-INTERCEPT RESOLVER WITH CLICK SIMULATION
async function resolveViaPuppeteerIntercept(tmdbParam) {
  let browser;
  console.log(`\n[SmartResolver] Launching browser for target: ${tmdbParam}`);

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--allow-running-insecure-content',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 720 });

    return new Promise(async (resolve) => {
      let resolved = false;

      const timer = setTimeout(async () => {
        if (!resolved) {
          resolved = true;
          console.log(`[SmartResolver] ⚠️ Timeout reached (50s)`);
          if (browser) await browser.close().catch(() => {});
          resolve(null);
        }
      }, 50000);

      page.on('response', async (response) => {
        const url = response.url();
        try {
          if (url.includes('/api/extract') && response.status() === 200) {
            const data = await response.json();
            if (!resolved && data) {
              const streamUrl = data.url || (data.sources && data.sources[0] && (data.sources[0].file || data.sources[0].url));
              if (streamUrl) {
                resolved = true;
                console.log(`[SmartResolver] ✅ CAUGHT STREAM URL FROM API EXTRACT!`);
                clearTimeout(timer);
                setTimeout(async () => { if (browser) await browser.close().catch(() => {}); }, 1000);
                resolve(streamUrl);
              }
            }
          } else if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('google')) {
            if (!resolved) {
              resolved = true;
              console.log(`[SmartResolver] ✅ CAUGHT DIRECT MEDIA URL!`);
              clearTimeout(timer);
              setTimeout(async () => { if (browser) await browser.close().catch(() => {}); }, 1000);
              resolve(url);
            }
          }
        } catch (e) {}
      });

      try {
        const targetUrl = `https://www.moviesnexus.fun/${tmdbParam.startsWith('tv/') ? tmdbParam : 'movie/' + tmdbParam}`;
        console.log(`[SmartResolver] Navigating to: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        
        // Wait 4 seconds for scripts to mount, then simulate a click to trigger the extraction endpoint
        await new Promise(r => setTimeout(r, 4000));
        await page.evaluate(() => {
          document.body.click();
          const playBtn = document.querySelector('button, .play, .player, video');
          if (playBtn) playBtn.click();
        }).catch(() => {});

      } catch (err) {
        console.log(`[SmartResolver] Navigation notice: ${err.message}`);
      }
    });

  } catch (err) {
    console.error(`[SmartResolver] Browser Error: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

app.get('/resolve', async (req, res) => {
  const tmdbParam = req.query.tmdb || '550';
  console.log(`\n=========================================`);
  console.log(`[*] Request to resolve target: ${tmdbParam}`);
  
  try {
    const streamUrl = await resolveViaPuppeteerIntercept(tmdbParam);
    if (streamUrl) {
      res.json({ status: 'ok', streamUrl: `/proxy-stream?url=${encodeURIComponent(streamUrl)}` });
    } else {
      res.status(404).json({ status: 'error', message: 'Stream could not be extracted.' });
    }
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Cloud Server running on port ${PORT}`);
});
