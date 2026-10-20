async function resolveViaPuppeteerIntercept(tmdbParam) {
  let browser;
  console.log(`\n[SmartResolver] Launching Stealth/Anti-Bot browser for: ${tmdbParam}`);

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
    await page.setBypassCSP(true); 
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 720 });

    // 🔥 NEUTRALIZE THE DEVTOOLS DETECTOR BEFORE IT LOADS 🔥
    await page.evaluateOnNewDocument(() => {
      window.__DISABLE_DEVTOOL_HOOK__ = true;
      Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
      Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight });
      window.console.clear = () => {}; // Stop them from clearing our logs
    });

    return new Promise(async (resolve) => {
      let resolved = false;
      let clickInterval;

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
        console.log(`[SmartResolver] Page loaded. Bypassing devtools detection...`);

        clickInterval = setInterval(async () => {
          if (resolved) return;
          try {
            await page.mouse.click(640, 360);
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
        }, 2000); 

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
