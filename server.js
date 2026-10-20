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
  socket.on('join_room', (roomCode) => {
    socket.join(roomCode);
    if (roomCode && roomCode !== 'undefined') {
      console.log(`[+] Device joined Room: ${roomCode}`);
    }
  });
});

app.get('/proxy-stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing stream URL');

  try {
    const upstreamRes = await fetch(targetUrl, {
      headers: {
        'Referer': 'https://www.moviesnexus.fun/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!upstreamRes.ok) return res.status(upstreamRes.status).send('Failed to fetch stream chunk');

    const contentType = upstreamRes.headers.get('content-type') || 'application/vnd.apple.mpegurl';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');

    let bodyText = await upstreamRes.text();
    if (targetUrl.includes('.m3u8')) {
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      const lines = bodyText.split('\n');
      const rewrittenLines = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const absoluteChunkUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
          return `/proxy-stream?url=${encodeURIComponent(absoluteChunkUrl)}`;
        }
        return line;
      });
      res.send(rewrittenLines.join('\n'));
    } else {
      res.send(bodyText);
    }
  } catch (err) {
    res.status(500).send('Proxy error');
  }
});

async function resolveViaPuppeteerIntercept(tmdbParam) {
  let browser;
  console.log(`\n[SmartResolver] Launching aggressive headless browser for: ${tmdbParam}`);

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--allow-running-insecure-content',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1280,720',
        '--mute-audio',
        '--autoplay-policy=no-user-gesture-required'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 720 });

    return new Promise(async (resolve) => {
      let resolved = false;
      let clickInterval;

      // Centralized finish function to prevent memory leaks
      const finish = async (result) => {
        if (!resolved) {
          resolved = true;
          clearInterval(clickInterval);
          clearTimeout(timer);
          if (browser) setTimeout(() => browser.close().catch(()=>{}), 1000);
          resolve(result);
        }
      };

      const timer = setTimeout(() => {
        console.log(`[SmartResolver] ⚠️ Timeout reached (50s)`);
        finish(null);
      }, 50000);

      // Listen for the stream URL in the network traffic
      page.on('response', async (response) => {
        const url = response.url();
        try {
          if (url.includes('/api/extract') && response.status() === 200) {
            const data = await response.json();
            if (!resolved && data) {
              const streamUrl = data.url || (data.sources && data.sources[0] && (data.sources[0].file || data.sources[0].url));
              if (streamUrl) {
                console.log(`[SmartResolver] ✅ CAUGHT STREAM URL FROM API EXTRACT!`);
                finish(streamUrl);
              }
            }
          } 
          else if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('google') && !url.includes('empty')) {
            if (!resolved) {
              console.log(`[SmartResolver] ✅ CAUGHT DIRECT M3U8 URL!`);
              finish(url);
            }
          }
        } catch (e) {}
      });

      try {
        const targetUrl = `https://www.moviesnexus.fun/${tmdbParam.startsWith('tv/') ? tmdbParam : 'movie/' + tmdbParam}?autoPlay=1`;
        console.log(`[SmartResolver] Navigating to: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        console.log(`[SmartResolver] Page loaded. Starting aggressive click loop...`);

        // The Aggressive Click Loop
        clickInterval = setInterval(async () => {
          if (resolved) return;
          try {
            // Click the exact center of the screen to trigger native players
            await page.mouse.click(640, 360);
            
            // Dive into every single iframe and force play events
            const frames = page.frames();
            for (const frame of frames) {
              await frame.evaluate(() => {
                document.body.click();
                const btn = document.querySelector('.jw-icon-display, .play-button, button, video');
                if (btn) btn.click();
                const vid = document.querySelector('video');
                if (vid) vid.play().catch(()=>{});
              }).catch(()=>{});
            }
          } catch (e) {}
        }, 2500); // Fires every 2.5 seconds until the stream is caught

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
