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
  const {
    url,
    dest = "stickers",
    convertToGif = false,
  } = config;

  return {
    spinner: ora("Fetching sticker data..."),
    config: { url, dest, convertToGif },
  };
}

async function scrapeStickerUrls(context) {
  const { url: pageUrl } = context.config;

  // Extract the product ID from the URL (e.g., https://store.line.me/stickershop/product/37295/en)
  const productIdMatch = pageUrl.match(/\/product\/(\d+)/);
  if (!productIdMatch) {
    throw new Error("Could not extract product ID from the provided URL.");
  }
  const productId = productIdMatch[1];

  // Fetch the JSON metadata directly from LINE's CDN
  const metaUrl = `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/iphone/productInfo.meta`;
  
  const res = await fetch(metaUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch sticker metadata (HTTP ${res.status}). Check the URL.`);
  }

  const meta = await res.json();
  
  if (!meta.stickers || meta.stickers.length === 0) {
    throw new Error("No stickers found in the product metadata.");
  }

  const urls = [];
  let animatedCount = 0;

  for (let i = 0; i < meta.stickers.length; i++) {
    const sticker = meta.stickers[i];
    let suffix = "sticker@2x.png";
    
    // Check if the sticker is animated or has sound (which are APNGs)
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

    await Promise.all(
      urls.map((url, i) =>
        downloadImage({ url, dest: path.join(dest, `sticker-${i + 1}.png`) })
      )
    );

    if (convertToGif) {
      try {
        fs.accessSync(apng2gifBinPath, fs.constants.X_OK);
        console.log(`[apng2gif] Binary is executable.`);
      } catch (err) {
        console.error(`[apng2gif] Binary is NOT executable:`, err.message);
        try { fs.chmodSync(apng2gifBinPath, 0o755); } catch (e) {}
      }

      context.spinner.text = `Converting ${urls.length} stickers to GIF...`;
      await Promise.all(
        urls.map(async (url, i) => {
          const pngPath = path.join(dest, `sticker-${i + 1}.png`);
          const gifPath = path.join(dest, `sticker-${i + 1}.gif`);
          try {
            await execFileAsync(apng2gifBinPath, [pngPath, gifPath]);
            console.log(`[apng2gif] Success: ${pngPath} -> ${gifPath}`);
          } catch (err) {
            // Static PNGs might fail to convert to GIF, which is normal. 
            // We log it but don't crash the whole process.
            console.error(`[apng2gif] Notice: ${pngPath} is likely static.`, err.message);
          }
        })
      );
    }

    spinner.succeed(chalk.green(`Saved stickers to ${dest}/`));
    return urls.length;
  } catch (err) {
    if (context) context.spinner.fail(chalk.red(err.message));
    console.error(err.stack);
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
    output.on("error", (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
    archive.on("error", (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); });

    archive.pipe(output);
    archive.directory(downloadPath, false);
    archive.finalize();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
