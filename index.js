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

async function scrapeStickerUrls(context) {
  const { url: pageUrl } = context.config;

  const productIdMatch = pageUrl.match(/\/product\/(\d+)/);
  if (!productIdMatch) {
    throw new Error("Could not extract product ID from the provided URL.");
  }
  const productId = productIdMatch[1];

  const metaUrl = `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/iphone/productInfo.meta`;
  
  const res = await fetch(metaUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": "https://store.line.me/"
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch metadata: HTTP ${res.status}`);
  }

  const meta = await res.json();

  if (!meta.stickers || !Array.isArray(meta.stickers) || meta.stickers.length === 0) {
    throw new Error("No stickers found in the product metadata.");
  }

  const stickersData = [];

  for (let i = 0; i < meta.stickers.length; i++) {
    const sticker = meta.stickers[i];
    
    // Generate all possible valid LINE CDN candidate URLs for this sticker ID
    const candidateUrls = [
      `https://stickershop.line-scdn.net/stickershop/v1/sticker/${sticker.id}/iPhone/animation@2x.png?v=2`,
      `https://stickershop.line-scdn.net/stickershop/v1/sticker/${sticker.id}/iPhone/sticker@2x.png?v=2`,
      `https://stickershop.line-scdn.net/stickershop/v1/sticker/${sticker.id}/ANDROID/sticker.png?v=2`,
      `https://stickershop.line-scdn.net/stickershop/v1/sticker/${sticker.id}/iPhone/popup_key@2x.png?v=2`
    ];

    stickersData.push({
      id: sticker.id,
      candidateUrls
    });
  }

  return stickersData;
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
      if (!res.ok) continue; // Try next URL candidate
      
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      // Ensure we didn't receive an empty or error stub
      if (buffer.length > 100) {
        fs.writeFileSync(destPath, buffer);
        return true;
      }
    } catch (err) {
      // Continue to next candidate
    }
  }
  console.error(`[Download Failed] All candidates failed for Sticker ID ${item.id}`);
  return false;
}

async function downloadStickers(config = {}) {
  let context;
  try {
    context = createContext(config);
    const { spinner, config: { dest } } = context;

    spinner.start();
    const stickerItems = await scrapeStickerUrls(context);
    await makeDir(dest);

    context.spinner.text = `Downloading ${stickerItems.length} stickers...`;
    
    let downloadedCount = 0;
    for (let i = 0; i < stickerItems.length; i++) {
      const item = stickerItems[i];
      const fileDest = path.join(dest, `sticker-${i + 1}.png`);
      
      const success = await downloadSticker(item, fileDest);
      if (success) downloadedCount++;

      context.spinner.text = `Downloaded ${downloadedCount}/${stickerItems.length} stickers...`;
      await sleep(100); 
    }

    spinner.succeed(chalk.green(`Successfully saved ${downloadedCount}/${stickerItems.length} stickers to ${dest}/`));
    return downloadedCount;
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

    const folderName = `stickers-${Date.now()}`;
    const downloadPath = path.join(__dirname, "downloads", folderName);

    await downloadStickers({ url, dest: downloadPath });

    const zipPath = `${downloadPath}.zip`;
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      res.download(zipPath, `${folderName}.zip`, (err) => {
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
