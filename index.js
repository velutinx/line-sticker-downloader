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
    spinner: ora("Fetching pack data..."),
    config: { url, dest },
  };
}

async function scrapeStickerData(context) {
  const { url: pageUrl } = context.config;

  const match = pageUrl.match(/\/(stickershop|emojishop)\/product\/([a-zA-Z0-9]+)/);
  if (!match) {
    throw new Error("Could not extract product type or ID from the provided URL.");
  }
  
  const shopType = match[1]; // 'stickershop' or 'emojishop'
  const productId = match[2];

  let packTitle = `${shopType === 'emojishop' ? 'LINE Emojis' : 'LINE Stickers'} ${productId}`;
  let itemsData = [];

  // 1. Try fetching official Metadata JSON first
  const metaUrls = shopType === 'emojishop' ? [
    `https://stickershop.line-scdn.net/emojishop/v1/product/${productId}/PC/productInfo.meta`,
    `https://stickershop.line-scdn.net/emojishop/v1/product/${productId}/iphone/productInfo.meta`,
    `https://stickershop.line-scdn.net/emojishop/v1/product/${productId}/ANDROID/productInfo.meta`
  ] : [
    `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/iphone/productInfo.meta`,
    `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/PC/productInfo.meta`
  ];

  let meta = null;
  for (const metaUrl of metaUrls) {
    try {
      const res = await fetch(metaUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://store.line.me/"
        }
      });
      if (res.ok) {
        meta = await res.json();
        break;
      }
    } catch (e) {}
  }

  // 2. Fetch HTML page to get the clean pack title
  try {
    const htmlRes = await fetch(pageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5"
      }
    });
    if (htmlRes.ok) {
      const htmlText = await htmlRes.text();
      const titleMatch = htmlText.match(/<p class="mdCMN08Ttl">([^<]+)<\/p>/) || htmlText.match(/<title>([^<]+)<\/title>/);
      if (titleMatch && titleMatch[1]) {
        let rawTitle = titleMatch[1].split('—')[0].split('|')[0].split('–')[0].trim();
        if (rawTitle) packTitle = rawTitle;
      }
    }
  } catch (e) {}

  // 3. Process items from Metadata JSON
  if (meta) {
    const itemsList = meta.stickers || meta.emojis;
    if (itemsList && Array.isArray(itemsList)) {
      if (meta.title?.en || meta.packageTitle?.en) {
        packTitle = meta.title?.en || meta.packageTitle?.en;
      }

      for (let i = 0; i < itemsList.length; i++) {
        const item = itemsList[i];
        let candidateUrls = [];
        if (shopType === 'emojishop') {
          candidateUrls = [
            `https://stickershop.line-scdn.net/emojishop/v1/emoji/${item.id}/iPhone/png@2x.png?v=2`,
            `https://stickershop.line-scdn.net/emojishop/v1/emoji/${item.id}/PC/png.png?v=2`,
            `https://stickershop.line-scdn.net/emojishop/v1/emoji/${item.id}/ANDROID/png.png?v=2`
          ];
        } else {
          candidateUrls = [
            `https://stickershop.line-scdn.net/stickershop/v1/sticker/${item.id}/iPhone/animation@2x.png?v=2`,
            `https://stickershop.line-scdn.net/stickershop/v1/sticker/${item.id}/iPhone/sticker@2x.png?v=2`,
            `https://stickershop.line-scdn.net/stickershop/v1/sticker/${item.id}/ANDROID/sticker.png?v=2`
          ];
        }

        itemsData.push({
          id: item.id,
          candidateUrls
        });
      }
    }
  }

  // 4. Fallback: Parse item IDs/URLs directly from HTML page source if metadata missed
  if (itemsData.length === 0) {
    try {
      const htmlRes = await fetch(pageUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
      });
      if (htmlRes.ok) {
        const htmlText = await htmlRes.text();
        const regex = shopType === 'emojishop' 
          ? /https:\/\/[^\s"']+\/emojishop\/v1\/emoji\/([a-zA-Z0-9]+)\/[^\s"']+\/png@2x\.png/g
          : /https:\/\/[^\s"']+\/stickershop\/v1\/sticker\/(\d+)\/[^\s"']+\/(?:animation|sticker)@2x\.png/g;
        
        const matches = [...htmlText.matchAll(regex)];
        let uniqueIds = [...new Set(matches.match ? matches.map(m => m[1]) : matches.map(m => m[1]))];

        // If regex didn't catch via group 1, try extracting any sticker/emoji ID pattern
        if (uniqueIds.length === 0) {
          const generalRegex = shopType === 'emojishop' 
            ? /emojishop\/v1\/emoji\/([a-zA-Z0-9]+)/g 
            : /stickershop\/v1\/sticker\/(\d+)/g;
          const genMatches = [...htmlText.matchAll(generalRegex)];
          uniqueIds = [...new Set(genMatches.map(m => m[1]))];
        }

        for (const id of uniqueIds) {
          const candidateUrls = shopType === 'emojishop' ? [
            `https://stickershop.line-scdn.net/emojishop/v1/emoji/${id}/iPhone/png@2x.png?v=2`,
            `https://stickershop.line-scdn.net/emojishop/v1/emoji/${id}/PC/png.png?v=2`,
            `https://stickershop.line-scdn.net/emojishop/v1/emoji/${id}/ANDROID/png.png?v=2`
          ] : [
            `https://stickershop.line-scdn.net/stickershop/v1/sticker/${id}/iPhone/animation@2x.png?v=2`,
            `https://stickershop.line-scdn.net/stickershop/v1/sticker/${id}/iPhone/sticker@2x.png?v=2`
          ];
          itemsData.push({ id, candidateUrls });
        }
      }
    } catch (e) {}
  }

  if (itemsData.length === 0) {
    throw new Error("Could not find any items or metadata for this product URL.");
  }

  return { packTitle, itemsData };
}

async function downloadItem(item, destPath) {
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
      
      if (buffer.length > 50) {
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
    const { packTitle, itemsData } = await scrapeStickerData(context);
    await makeDir(dest);

    context.spinner.text = `Downloading ${itemsData.length} items for "${packTitle}"...`;
    
    let downloadedCount = 0;
    for (let i = 0; i < itemsData.length; i++) {
      const item = itemsData[i];
      const pngDest = path.join(dest, `item-${i + 1}.png`);
      const gifDest = path.join(dest, `item-${i + 1}.gif`);
      
      const success = await downloadItem(item, pngDest);
      if (success) {
        downloadedCount++;
        try {
          fs.copyFileSync(pngDest, gifDest); // Save both PNG and GIF formats
        } catch (e) {}
      }

      context.spinner.text = `Processed ${downloadedCount}/${itemsData.length} items...`;
      await sleep(50); 
    }

    spinner.succeed(chalk.green(`Successfully downloaded "${packTitle}" (${downloadedCount} items)`));
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
    if (!url) return res.status(400).json({ error: "Missing LINE shop URL" });

    const tempFolderId = `pack-${Date.now()}`;
    const downloadPath = path.join(__dirname, "downloads", tempFolderId);

    const { packTitle } = await downloadStickers({ url, dest: downloadPath });
    
    const cleanTitle = packTitle.split('—')[0].split('|')[0].split('–')[0].trim();
    
    const safeTitle = cleanTitle
      .replace(/#/g, 'No.')
      .replace(/[%^~\[\]]/g, '')
      .replace(/[\/\\?%*:|"<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || "line-pack";
      
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
