//index.js

const path = require("path");
const fs = require("fs");

const express = require("express");
const cors = require("cors");
const archiver = require("archiver");

const chalk = require("chalk");
const makeDir = require("make-dir");
const ora = require("ora");

const { execFile } = require("child_process");
const util = require("util");
const execFileAsync = util.promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createContext(config) {
  const { url, dest = "stickers", convertToGif = false } = config;
  return {
    spinner: ora("Fetching sticker data..."),
    config: { url, dest, convertToGif },
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
    
    let isAnimated = false;
    let primarySuffix = "sticker@2x.png";
    
    if (sticker.stickerType === "ANIMATION" || sticker.stickerType === "SOUND" || sticker.animation) {
      primarySuffix = "animation@2x.png";
      isAnimated = true;
    }

    stickersData.push({
      id: sticker.id,
      primaryUrl: `https://stickershop.line-scdn.net/stickershop/v1/sticker/${sticker.id}/iPhone/${primarySuffix}?v=2`,
      fallbackUrl: `https://stickershop.line-scdn.net/stickershop/v1/sticker/${sticker.id}/iPhone/sticker@2x.png?v=2`,
      isAnimated
    });
  }

  return stickersData;
}

async function downloadSticker(item, destPath) {
  const urlsToTry = [item.primaryUrl];
  if (item.primaryUrl !== item.fallbackUrl) {
    urlsToTry.push(item.fallbackUrl);
  }

  for (const url of urlsToTry) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://store.line.me/"
          }
        });
        if (!res.ok) continue; // Try fallback URL or next attempt
        
        const arrayBuffer = await res.arrayBuffer();
        fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
        return true;
      } catch (err) {
        await sleep(500);
      }
    }
  }
  console.error(`[Download Failed] Sticker ID ${item.id}`);
  return false;
}

async function downloadStickers(config = {}) {
  let context;
  try {
    context = createContext(config);
    const { spinner, config: { dest, convertToGif } } = context;

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

      context.spinner.text = `Downloaded ${downloadedCount}/${stickerItems.length}...`;
      await sleep(150); 
    }

    if (convertToGif) {
      context.spinner.text = `Converting animated stickers to GIF...`;
      let successGifs = 0;

      for (let i = 0; i < stickerItems.length; i++) {
        const pngPath = path.join(dest, `sticker-${i + 1}.png`);
        const gifPath = path.join(dest, `sticker-${i + 1}.gif`);
        
        if (!fs.existsSync(pngPath)) continue;

        try {
          // Use system-installed 'apng2gif' command directly
          await execFileAsync("apng2gif", [pngPath, gifPath]);
          if (fs.existsSync(gifPath)) {
            successGifs++;
          }
        } catch (err) {
          // Static PNGs will fail conversion naturally, which is expected.
        }
      }
      console.log(`Converted ${successGifs} GIFs successfully.`);
    }

    spinner.succeed(chalk.green(`Saved stickers to ${dest}/`));
    return stickerItems.length;
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
    const { url, convertToGif = true } = req.body;
    if (!url) return res.status(400).json({ error: "Missing LINE sticker URL" });

    const folderName = `stickers-${Date.now()}`;
    const downloadPath = path.join(__dirname, "downloads", folderName);

    await downloadStickers({ url, dest: downloadPath, convertToGif });

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
