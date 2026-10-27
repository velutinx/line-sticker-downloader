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

  const meta = await res.json();

  if (!meta.stickers || !Array.isArray(meta.stickers) || meta.stickers.length === 0) {
    throw new Error("No stickers found in the product metadata.");
  }

  const urls = [];
  let animatedCount = 0;

  for (let i = 0; i < meta.stickers.length; i++) {
    const sticker = meta.stickers[i];
    
    if (i === 0) {
      console.log("--- DEBUG: First Sticker JSON ---");
      console.log(JSON.stringify(sticker, null, 2));
      console.log("---------------------------------");
    }

    let suffix = "sticker@2x.png";
    
    if (sticker.stickerType === "ANIMATION" || sticker.stickerType === "SOUND") {
      suffix = "animation@2x.png";
      animatedCount++;
    }

    const stickerUrl = `https://stickershop.line-scdn.net/stickershop/v1/sticker/${sticker.id}/iPhone/${suffix}`;
    urls.push(stickerUrl);
    
    context.spinner.text = `Found ${urls.length}/${meta.stickers.length} stickers (${animatedCount} animated)...`;
  }

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
    
    // SEQUENTIAL DOWNLOAD to avoid rate limiting
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const fileDest = path.join(dest, `sticker-${i + 1}.png`);
      
      try {
        await downloadImage({
          url,
          dest: fileDest,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://store.line.me/"
          }
        });
        context.spinner.text = `Downloaded ${i + 1}/${urls.length}...`;
      } catch (err) {
        console.error(`[Download Failed] Sticker ${i + 1}:`, err.message);
      }
      
      // Small delay to prevent CDN rate limits
      await sleep(150); 
    }

    if (convertToGif) {
      context.spinner.text = `Converting stickers to GIF...`;
      
      // SEQUENTIAL CONVERSION
      for (let i = 0; i < urls.length; i++) {
        const pngPath = path.join(dest, `sticker-${i + 1}.png`);
        const gifPath = path.join(dest, `sticker-${i + 1}.gif`);
        
        if (!fs.existsSync(pngPath)) continue;

        try {
          // Ensure binary is executable
          try { fs.chmodSync(apng2gifBinPath, 0o755); } catch (e) {}
          
          const { stdout, stderr } = await execFileAsync(apng2gifBinPath, [pngPath, gifPath]);
          console.log(`[apng2gif] SUCCESS: sticker-${i + 1}.gif`);
        } catch (err) {
          // Static PNGs will fail here, which is expected.
          console.log(`[apng2gif] FAILED sticker-${i + 1}:`, err.message);
          if (err.stderr) console.log(`[apng2gif] STDERR:`, err.stderr);
        }
      }
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
