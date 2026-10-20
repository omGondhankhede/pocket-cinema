const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// Import Puppeteer Extra and the Stealth Plugin
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
  console.log(`[Puppeteer] Starting extraction for TMDB: ${tmdbId}`);
  
  try {
    console.log(`[Puppeteer] Launching browser...`);
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security', // Helps bypass iframe cross-origin blocks
        '--disable-features=IsolateOrigins,site-per-process' // Allows clicking inside embedded players
      ]
    });

    console.log(`[Puppeteer] Browser launched. Opening new page...`);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 720 });
    await page.setRequestInterception(true);
    
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Log any internal page errors
    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`[Page Console Error] ${msg.text()}`);
    });

    return new Promise(async (resolve) => {
      let resolved = false;

      const timer = setTimeout(async () => {
        if (!resolved) {
          console.log(`[Puppeteer] ⚠️ Timeout reached (45s). Current URL: ${page.url()}`);
          const title = await page.title().catch(() => 'Unknown');
          console.log(`[Puppeteer] ⚠️ Page title at timeout: "${title}"`);
          if (browser) await browser.close().catch(() => {});
          resolve({ error: `Timeout. Page title was: ${title}` });
        }
      }, 45000);

      page.on('response', async (response) => {
        const url = response.url();
        if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('google')) {
          if (!resolved) {
            resolved = true;
            console.log(`[Puppeteer] ✅ STREAM FOUND! URL: ${url.substring(0, 60)}...`);
            clearTimeout(timer);
            setTimeout(async () => { if (browser) await browser.close().catch(() => {}); }, 1500);
            resolve({ url: url });
          }
        }
      });

      try {
        const targetUrl = `https://www.moviesnexus.fun/movie/${tmdbId}`;
        console.log(`[Puppeteer] Navigating to: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        const title = await page.title();
        console.log(`[Puppeteer] Page loaded successfully. Title: "${title}"`);
        
        if (title.toLowerCase().includes('just a moment') || title.toLowerCase().includes('cloudflare')) {
          console.log(`[Puppeteer] ❌ BLOCKED BY CLOUDFLARE.`);
        }

        console.log(`[Puppeteer] Waiting 6 seconds for video players and iframes to load...`);
        await new Promise(r => setTimeout(r, 6000));
        
        const frames = page.frames();
        console.log(`[Puppeteer] Found ${frames.length} frames on the page. Injecting play clicks...`);
        
        let clicks = 0;
        for (const frame of frames) {
          try {
            const clicked = await frame.evaluate(() => {
              let count = 0;
              const targets = document.querySelectorAll('button, .jw-display-icon-container, .vjs-big-play-button, #play, video, .play-button');
              targets.forEach(t => { t.click(); count++; });
              const v = document.querySelector('video');
              if (v) { v.play().catch(() => {}); count++; }
              return count;
            });
            clicks += clicked;
          } catch (e) {
            // Ignore individual frame security errors
          }
        }
        console.log(`[Puppeteer] Performed ${clicks} interaction attempts across all frames. Waiting for video network traffic...`);

      } catch (err) {
        console.log(`[Puppeteer] ❌ Navigation/Execution Error: ${err.message}`);
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          if (browser) await browser.close().catch(() => {});
          resolve({ error: err.message });
        }
      }
    });
  } catch (err) {
    console.log(`[Puppeteer] ❌ Browser Launch Error: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return { error: err.message };
  }
}

app.get('/resolve', async (req, res) => {
  const tmdbId = req.query.tmdb || '550';
  console.log(`\n=========================================`);
  console.log(`[*] Manual click resolve for TMDB: ${tmdbId}`);
  
  try {
    const result = await sniffStream(tmdbId);
    if (result && result.url) {
      console.log(`[*] Successfully resolving stream to frontend.`);
      res.json({ status: 'ok', streamUrl: `/proxy-stream?url=${encodeURIComponent(result.url)}` });
    } else {
      const reason = result?.error || 'Unknown extraction failure';
      console.log(`[!] Resolve Failed: ${reason}`);
      res.status(404).json({ status: 'error', message: reason });
    }
  } catch (err) {
    console.error(`[!] Backend Crash Prevented: ${err.message}`);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Cloud Server running on port ${PORT}`);
});
