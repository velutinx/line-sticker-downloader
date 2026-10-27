//index.js

const path = require("path");
const fs = require("fs");

const express = require("express");
const cors = require("cors");
const archiver = require("archiver");

const chalk = require("chalk");
const makeDir = require("make-dir");
const ora = require("ora");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createContext(config) {
  const { url, dest = "stickers" } = config;
  return {
    spinner: ora("Fetching sticker data..."),
    config: { url, dest },
  };
}

async function scrapeStickerData(context) {
  const { url: pageUrl } = context.config;

  const productIdMatch = pageUrl.match(/\/product\/(\d+)/);
  if (!productIdMatch) {
    throw new Error("Could not extract product ID from the provided URL.");
  }
  const productId = productIdMatch[1];

  // 1. Fetch metadata JSON for stickers
  const metaUrl = `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/iphone/productInfo.meta`;
  const metaRes = await fetch(metaUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": "https://store.line.me/"
    }
  });

  if (!metaRes.ok) {
    throw new Error(`Failed to fetch metadata: HTTP ${metaRes.status}`);
  }

  const meta = await metaRes.json();

  if (!meta.stickers || !Array.isArray(meta.stickers) || meta.stickers.length === 0) {
    throw new Error("No stickers found in the product metadata.");
  }

  // 2. Fetch the store HTML page to extract the clean pack title
  let packTitle = `line-stickers-${productId}`;
  try {
    const htmlRes = await fetch(pageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (htmlRes.ok) {
      const htmlText = await htmlRes.text();
      const titleMatch = htmlText.match(/<p class="mdCMN08Ttl">([^<]+)<\/p>/) || htmlText.match(/<title>([^<]+)<\/title>/);
      if (titleMatch && titleMatch[1]) {
        let rawTitle = titleMatch[1].split('—')[0].split('|')[0].trim();
        if (rawTitle) packTitle = rawTitle;
      }
    }
  } catch (e) {
    // Fallback to ID if HTML scrape fails
  }

  const stickersData = [];
  for (let i = 0; i < meta.stickers.length; i++) {
    const sticker = meta.stickers[i];
    const candidateUrls = [
      `https://stickershop.line-scdn.net/stickershop/v1/sticker/${sticker.id}/iPhone/animation@2x.png?v=2`,
      `https://stickershop.line-scdn.net/stickershop/v1/sticker/${sticker.id}/iPhone/sticker@2x.png?v=2`,
      `https://stickershop.line-scdn.net/stickershop/v1/sticker/${sticker.id}/ANDROID/sticker.png?v=2`
    ];

    stickersData.push({
      id: sticker.id,
      candidateUrls
    });
  }

  return { packTitle, stickersData };
}

async function downloadSticker(item, destPath) {
  for (const url of item.candidateUrls) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://store.line.me/"
        }
      });
      if (!res.ok) continue;
      
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      if (buffer.length > 100) {
        fs.writeFileSync(destPath, buffer);
        return true;
      }
    } catch (err) {}
  }
  return false;
}

async function downloadStickers(config = {}) {
  let context;
  try {
    context = createContext(config);
    const { spinner, config: { dest } } = context;

    spinner.start();
    const { packTitle, stickersData } = await scrapeStickerData(context);
    await makeDir(dest);

    context.spinner.text = `Downloading ${stickersData.length} stickers for "${packTitle}"...`;
    
    let downloadedCount = 0;
    for (let i = 0; i < stickersData.length; i++) {
      const item = stickersData[i];
      const pngDest = path.join(dest, `sticker-${i + 1}.png`);
      const gifDest = path.join(dest, `sticker-${i + 1}.gif`);
      
      const success = await downloadSticker(item, pngDest);
      if (success) {
        downloadedCount++;
        try {
          fs.copyFileSync(pngDest, gifDest);
        } catch (e) {}
      }

      context.spinner.text = `Processed ${downloadedCount}/${stickersData.length} stickers...`;
      await sleep(100); 
    }

    spinner.succeed(chalk.green(`Successfully downloaded "${packTitle}" (${downloadedCount} PNGs & GIFs)`));
    return { packTitle, count: downloadedCount };
  } catch (err) {
    if (context) context.spinner.fail(chalk.red(err.message));
    console.error("Error in downloadStickers:", err);
    throw err;
  }
}

app.post("/download", async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);

  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "Missing LINE sticker URL" });

    const tempFolderId = `stickers-${Date.now()}`;
    const downloadPath = path.join(__dirname, "downloads", tempFolderId);

    const { packTitle } = await downloadStickers({ url, dest: downloadPath });
    
    // Comprehensive filename sanitization for Windows/macOS/Linux
    const safeTitle = packTitle
      .replace(/#/g, 'No.')           // Replace # with 'No.'
      .replace(/[%^~\[\]]/g, '')     // Remove other risky characters
      .replace(/[\/\\?%*:|"<>]/g, '') // Remove Windows forbidden symbols
      .replace(/\s+/g, ' ')          // Collapse extra whitespace
      .trim() || "line-stickers";
      
    const zipFilename = `${safeTitle}.zip`;

    const zipPath = path.join(__dirname, "downloads", `${tempFolderId}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      res.download(zipPath, zipFilename, (err) => {
        if (err) console.error("send error:", err);
        try {
          fs.rmSync(downloadPath, { recursive: true, force: true });
          fs.rmSync(zipPath, { force: true });
        } catch (e) {}
      });
    });
    
    output.on("error", (err) => { 
      console.error("Output stream error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message }); 
    });
    
    archive.on("error", (err) => { 
      console.error("Archive error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message }); 
    });

    archive.pipe(output);
    archive.directory(downloadPath, false);
    
    await archive.finalize();

  } catch (err) {
    console.error("Error in /download route:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Unknown server error" });
    }
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
