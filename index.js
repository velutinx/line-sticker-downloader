//index.js

const path = require("path");
const fs = require("fs");

const express = require("express");
const cors = require("cors");
const archiver = require("archiver");

const chalk = require("chalk");
const makeDir = require("make-dir");
const downloadImage = require("image-downloader").image;
const ora = require("ora");

const { execFile } = require("child_process");
const util = require("util");
const execFileAsync = util.promisify(execFile);

const apng2gifBinPath = require("apng2gif-bin");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

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
  console.log(`Fetching metadata from: ${metaUrl}`);

  const res = await fetch(metaUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json",
      "Referer": "https://store.line.me/"
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch metadata: HTTP ${res.status} ${res.statusText}`);
  }

  const rawText = await res.text();
  let meta;
  try {
    meta = JSON.parse(rawText);
  } catch (e) {
    // If LINE returns HTML, this will catch it and log the first 200 chars
    throw new Error(`LINE API did not return JSON. Response starts with: ${rawText.substring(0, 200)}`);
  }

  if (!meta.stickers || !Array.isArray(meta.stickers) || meta.stickers.length === 0) {
    throw new Error("No stickers found in the product metadata.");
  }

  const urls = [];
  let animatedCount = 0;

  for (let i = 0; i < meta.stickers.length; i++) {
    const sticker = meta.stickers[i];
    let suffix = "sticker@2x.png";
    
    if (sticker.stickerType === "ANIMATION" || sticker.stickerType === "SOUND") {
      suffix = "animation@2x.png";
      animatedCount++;
    }

    const stickerUrl = `https://stickershop.line-scdn.net/stickershop/v1/sticker/${sticker.id}/iPhone/${suffix}`;
    urls.push(stickerUrl);
    
    context.spinner.text = `Found ${urls.length}/${meta.stickers.length} stickers (${animatedCount} animated)...`;
  }

  console.log(`Successfully scraped ${urls.length} URLs (${animatedCount} animated).`);
  return urls;
}

async function downloadStickers(config = {}) {
  let context;
  try {
    context = createContext(config);
    const { spinner, config: { dest, convertToGif } } = context;

    spinner.start();
    const urls = await scrapeStickerUrls(context);
    await makeDir(dest);

    context.spinner.text = `Downloading ${urls.length} stickers...`;
    
    // Use allSettled so one failed download doesn't kill the whole process
    const downloadResults = await Promise.allSettled(
      urls.map((url, i) =>
        downloadImage({ url, dest: path.join(dest, `sticker-${i + 1}.png`) })
      )
    );

    let successCount = 0;
    downloadResults.forEach((result, i) => {
      if (result.status === "fulfilled") {
        successCount++;
      } else {
        console.error(`[Download Failed] Sticker ${i + 1}:`, result.reason?.message || result.reason);
      }
    });
    console.log(`Downloaded ${successCount}/${urls.length} files.`);

    if (convertToGif) {
      try {
        fs.accessSync(apng2gifBinPath, fs.constants.X_OK);
        console.log(`[apng2gif] Binary is executable.`);
      } catch (err) {
        console.error(`[apng2gif] Binary is NOT executable:`, err.message);
        try { fs.chmodSync(apng2gifBinPath, 0o755); } catch (e) {}
      }

      context.spinner.text = `Converting stickers to GIF...`;
      
      await Promise.allSettled(
        urls.map(async (url, i) => {
          const pngPath = path.join(dest, `sticker-${i + 1}.png`);
          const gifPath = path.join(dest, `sticker-${i + 1}.gif`);
          
          // Only attempt conversion if the PNG actually downloaded
          if (!fs.existsSync(pngPath)) return;

          try {
            await execFileAsync(apng2gifBinPath, [pngPath, gifPath]);
            console.log(`[apng2gif] Success: sticker-${i + 1}.gif`);
          } catch (err) {
            // Static PNGs will fail here, which is expected. 
            console.log(`[apng2gif] Skipped (likely static): sticker-${i + 1}`);
          }
        })
      );
    }

    spinner.succeed(chalk.green(`Saved stickers to ${dest}/`));
    return urls.length;
  } catch (err) {
    if (context) context.spinner.fail(chalk.red(err.message));
    console.error("Error in downloadStickers:", err);
    throw err;
  }
}

app.post("/download", async (req, res) => {
  try {
    const { url, convertToGif = false } = req.body;
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
        fs.rmSync(downloadPath, { recursive: true, force: true });
        fs.rmSync(zipPath, { force: true });
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
    
    // Catch errors during finalize
    archive.finalize().catch(err => {
      console.error("Finalize error:", err);
      if (!res.headersSent) res.status(500).json({ error: "Failed to create zip." });
    });

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
