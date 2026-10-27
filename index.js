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

  // Try multiple common metadata endpoints for emojis/stickers
  const metaUrls = shopType === 'emojishop' ? [
    `https://stickershop.line-scdn.net/emojishop/v1/product/${productId}/PC/productInfo.meta`,
    `https://stickershop.line-scdn.net/emojishop/v1/product/${productId}/iphone/productInfo.meta`
  ] : [
    `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/iphone/productInfo.meta`,
    `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/PC/productInfo.meta`
  ];

  let meta = null;
  let metaRes = null;

  for (const metaUrl of metaUrls) {
    metaRes = await fetch(metaUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://store.line.me/"
      }
    });
    if (metaRes.ok) {
      meta = await metaRes.json();
      break;
    }
  }

  if (!meta) {
    throw new Error(`Failed to fetch metadata: HTTP ${metaRes ? metaRes.status : 404}`);
  }

  const itemsList = meta.stickers || meta.emojis;
  if (!itemsList || !Array.isArray(itemsList) || itemsList.length === 0) {
    throw new Error("No items found in the product metadata.");
  }

  let packTitle = meta.title?.en || meta.packageTitle?.en || `${shopType === 'emojishop' ? 'LINE Emojis' : 'LINE Stickers'} ${productId}`;
  
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

  const itemsData = [];
  for (let i = 0; i < itemsList.length; i++) {
    const item = itemsList[i];
    
    let candidateUrls = [];
    if (shopType === 'emojishop') {
      candidateUrls = [
        `https://stickershop.line-scdn.net/emojishop/v1/emoji/${item.id}/iPhone/png@2x.png?v=2`,
        `https://stickershop.line-scdn.net/emojishop/v1/emoji/${item.id}/iPhone/png.png?v=2`,
        `https://stickershop.line-scdn.net/emojishop/v1/emoji/${item.id}/ANDROID/png.png?v=2`,
        `https://stickershop.line-scdn.net/emojishop/v1/emoji/${item.id}/PC/png.png?v=2`
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
          fs.copyFileSync(pngDest, gifDest);
        } catch (e) {}
      }

      context.spinner.text = `Processed ${downloadedCount}/${itemsData.length} items...`;
      await sleep(100); 
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
    
    // Clean and split title at separators (—, |, –) to remove trailing website text
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
