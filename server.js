const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { connect } = require('puppeteer-real-browser');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Root health check
app.get('/', (req, res) => {
  res.send('PocketFlix Cinema Backend is Live & Running!');
});

// Socket.io for Room Codes
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

// HLS Proxy Route: Cleans audio tracks to fix drift
app.get('/proxy-stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing stream URL');

  try {
    const response = await fetch(targetUrl);
    let playlistText = await response.text();

    const lines = playlistText.split('\n');
    const sanitizedLines = lines.filter(line => {
      if (line.includes('TYPE="AUDIO"') || line.includes("TYPE='AUDIO'")) return false;
      return true;
    });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(sanitizedLines.join('\n'));
  } catch (err) {
    res.status(500).send('Failed to proxy stream');
  }
});

// Stream Sniffer (Explicitly maps Render's Chrome path)
async function sniffStream(tmdbId) {
  let browserInstance;
  try {
    const browserConfig = {
      headless: 'new',
      disableXvfb: true,
      turnstile: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ]
    };

    // If running on Render cloud, point directly to the installed Chrome binary
    if (process.env.CHROME_PATH) {
      browserConfig.executablePath = process.env.CHROME_PATH;
    }

    const { browser, page } = await connect(browserConfig);
    browserInstance = browser;

    await page.setViewport({ width: 800, height: 600 });
    await page.setRequestInterception(true);
    
    page.on('request', (req) => {
      const type = req.resourceType();
      const blockList = ['googlesyndication.com', 'google-analytics.com', 'doubleclick.net', 'popads.net'];
      if (['image', 'stylesheet', 'font'].includes(type) || blockList.some(domain => req.url().includes(domain))) {
        req.abort();
      } else {
        req.continue();
      }
    });

    return new Promise(async (resolve) => {
      let resolved = false;

      const timer = setTimeout(async () => {
        if (!resolved) {
          if (browserInstance) await browserInstance.close().catch(() => {});
          resolve(null);
        }
      }, 45000);

      page.on('response', async (response) => {
        const url = response.url();
        if ((url.includes('.m3u8') || url.includes('.mp4')) && !url.includes('google')) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            setTimeout(async () => { if (browserInstance) await browserInstance.close().catch(() => {}); }, 1500);
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
              const targets = document.querySelectorAll('button, .jw-display-icon-container, .vjs-big-play-button, #play, video');
              targets.forEach(t => t.click());
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
    if (browserInstance) await browserInstance.close().catch(() => {});
    throw err;
  }
}

// Click-to-Play Endpoint 
app.get('/resolve', async (req, res) => {
  const tmdbId = req.query.tmdb || '550';
  console.log(`[*] Manual click resolve for TMDB: ${tmdbId}`);
  
  try {
    const rawUrl = await sniffStream(tmdbId);
    if (rawUrl) {
      res.json({ status: 'ok', streamUrl: `/proxy-stream?url=${encodeURIComponent(rawUrl)}` });
    } else {
      res.status(404).json({ status: 'error', message: 'Stream not found or blocked by Cloudflare' });
    }
  } catch (err) {
    console.error(`[!] Backend Crash Prevented: ${err.message}`);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Voice Remote Command Endpoint
app.post('/api/voice-command', async (req, res) => {
  const { roomCode, text } = req.body;
  if (!roomCode || !text) return res.status(400).json({ error: 'Missing roomCode or text' });

  io.to(roomCode).emit('assistant_update', { message: `"${text}"`, status: 'processing' });
  res.json({ status: 'Processing started' });

  try {
    const aiResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer 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",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        temperature: 0.0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are a smart TV assistant. Intent MUST be: 'play_media', 'weather', or 'suggestion'. If play_media, extract 'title', 'season' (int/null), 'episode' (int/null). If suggestion, extract 'query'. Return strict JSON." },
          { role: "user", content: text }
        ]
      })
    });
    
    const aiData = await aiResp.json();
    const result = JSON.parse(aiData.choices[0].message.content);

    if (result.intent === 'weather') {
      io.to(roomCode).emit('execute_action', { action: 'weather' });
    } else if (result.intent === 'suggestion') {
      io.to(roomCode).emit('execute_action', { action: 'search', query: result.query });
    } else if (result.intent === 'play_media' && result.title) {
      io.to(roomCode).emit('assistant_update', { message: `Finding: ${result.title}`, status: 'loading' });
      
      const tmdbReq = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=3fd2be6f0c70a2a598f084ddfb75487c&query=${encodeURIComponent(result.title)}`);
      const tmdbData = await tmdbReq.json();
      
      if (tmdbData.results && tmdbData.results.length > 0) {
        const item = tmdbData.results[0];
        const isSeries = (item.media_type === 'tv' || item.first_air_date);
        const resolveParam = isSeries ? `${item.id}/${result.season || 1}/${result.episode || 1}` : item.id;
        
        io.to(roomCode).emit('assistant_update', { message: `Scraping stream...`, status: 'scraping' });
        
        const rawUrl = await sniffStream(resolveParam);
        if (rawUrl) {
          const proxyUrl = `/proxy-stream?url=${encodeURIComponent(rawUrl)}`;
          io.to(roomCode).emit('execute_action', { action: 'play', streamUrl: proxyUrl });
        } else {
          io.to(roomCode).emit('assistant_update', { message: `Stream not found.`, status: 'error' });
        }
      } else {
        io.to(roomCode).emit('assistant_update', { message: `Media not found on TMDB.`, status: 'error' });
      }
    }
  } catch (err) {
    io.to(roomCode).emit('assistant_update', { message: `Error processing command.`, status: 'error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Cloud Server running on port ${PORT}`);
});
