//index.js

const path = require("path");
const fs = require("fs");

const express = require("express");
const cors = require("cors");
const archiver = require("archiver");

const chalk = require("chalk");
const makeDir = require("make-dir");
const ora = require("ora");
const AdmZip = require("adm-zip");
const apng = require("sharp-apng");

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

// Helper: Fetch title from the HTML page
async function getPackTitle(pageUrl) {
  try {
    const htmlRes = await fetch(pageUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (htmlRes.ok) {
      const htmlText = await htmlRes.text();
      const titleMatch = htmlText.match(/<p class="mdCMN08Ttl">([^<]+)<\/p>/) || htmlText.match(/<title>([^<]+)<\/title>/);
      if (titleMatch && titleMatch[1]) {
        let raw = titleMatch[1].split("—")[0].split("|")[0].split("–")[0].trim();
        if (raw) return raw;
      }
    }
  } catch (_) {}
  return null;
}

// Helper: Probe emoji URLs (Emojis do not have ZIPs)
async function probeUrl(url) {
  try {
    const res = await fetch(url, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0", Referer: "https://store.line.me/" } });
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function scrapeEmojiData(productId) {
  let itemsData = [];
  let consecutiveMisses = 0;
  for (let i = 1; i <= 200; i++) {
    const num = String(i).padStart(3, "0");
    const staticUrl = `https://stickershop.line-scdn.net/sticonshop/v1/sticon/${productId}/iPhone/${num}.png`;
    const animUrl = `https://stickershop.line-scdn.net/sticonshop/v1/sticon/${productId}/iPhone/${num}_animation.png`;

    const ok = (await probeUrl(animUrl)) || (await probeUrl(staticUrl));
    if (ok) {
      itemsData.push({ candidateUrls: [animUrl, staticUrl] });
      consecutiveMisses = 0;
    } else {
      consecutiveMisses++;
      if (consecutiveMisses >= 5) break;
    }
  }
  return itemsData;
}

async function downloadStickers(config = {}) {
  let context;
  try {
    context = createContext(config);
    const { spinner, config: { dest, url: pageUrl } } = context;
    spinner.start();

    const match = pageUrl.match(/\/(stickershop|emojishop)\/product\/([a-zA-Z0-9]+)/);
    if (!match) throw new Error("Could not extract product ID from URL.");
    
    const shopType = match[1];
    const productId = match[2];

    let packTitle = await getPackTitle(pageUrl) || `LINE Pack ${productId}`;
    await makeDir(dest);
    
    const counters = { gif: 0, png: 0 };
    let downloadedCount = 0;

    if (shopType === "emojishop") {
      // --- EMOJI PATH ---
      spinner.text = `Probing emoji URLs for "${packTitle}"...`;
      const itemsData = await scrapeEmojiData(productId);
      if (itemsData.length === 0) throw new Error("No emojis found for this pack.");

      spinner.text = `Downloading ${itemsData.length} emojis...`;
      for (let i = 0; i < itemsData.length; i++) {
        const item = itemsData[i];
        for (const url of item.candidateUrls) {
          try {
            const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://store.line.me/" } });
            if (!res.ok) continue;
            
            const buffer = Buffer.from(await res.arrayBuffer());
            if (buffer.length < 50) continue;
            
            const isAnimated = buffer.includes(Buffer.from("acTL"));
            if (isAnimated) {
              try {
                const image = await apng.sharpFromApng(buffer);
                const gifBuffer = await image.gif().toBuffer();
                counters.gif++;
                fs.writeFileSync(path.join(dest, `sticker-${counters.gif}.gif`), gifBuffer);
              } catch (e) {
                counters.png++;
                fs.writeFileSync(path.join(dest, `sticker-${counters.png}.png`), buffer);
              }
            } else {
              counters.png++;
              fs.writeFileSync(path.join(dest, `sticker-${counters.png}.png`), buffer);
            }
            downloadedCount++;
            break; // Move to next item
          } catch (_) {}
        }
        spinner.text = `Processed ${i + 1}/${itemsData.length}...`;
      }
    } else {
      // --- STICKER PATH (ZIP DOWNLOAD) ---
      spinner.text = `Downloading official ZIP for "${packTitle}"...`;
      
      const zipUrls = [
        `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/iphone/stickerpack@2x.zip`,
        `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/iphone/stickers@2x.zip`,
        `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/android/stickerpack.zip`,
        `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/android/stickers.zip`
      ];

      let zipBuffer = null;
      for (const url of zipUrls) {
        try {
          const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://store.line.me/" } });
          if (res.ok) {
            zipBuffer = Buffer.from(await res.arrayBuffer());
            break;
          }
        } catch (_) {}
      }

      if (!zipBuffer) {
        throw new Error("Could not download the official ZIP. The pack may be region-locked or unavailable.");
      }

      spinner.text = `Extracting and processing ZIP...`;
      const zip = new AdmZip(zipBuffer);
      
      // Filter out key images and system files
      const validEntries = zip.getEntries().filter(e => {
        const n = e.entryName;
        return n.endsWith('.png') && !n.includes('_key@2x') && !n.startsWith('tab_');
      });

      if (validEntries.length === 0) throw new Error("The ZIP did not contain any valid sticker images.");

      for (let i = 0; i < validEntries.length; i++) {
        const entry = validEntries[i];
        const buffer = entry.getData();
        const isAnimated = buffer.includes(Buffer.from("acTL"));

        if (isAnimated) {
          try {
            const image = await apng.sharpFromApng(buffer);
            const gifBuffer = await image.gif().toBuffer();
            counters.gif++;
            fs.writeFileSync(path.join(dest, `sticker-${counters.gif}.gif`), gifBuffer);
            downloadedCount++;
          } catch (e) {
            console.error(`[Convert Failed] ${entry.entryName}:`, e.message);
            counters.png++;
            fs.writeFileSync(path.join(dest, `sticker-${counters.png}.png`), buffer);
            downloadedCount++;
          }
        } else {
          counters.png++;
          fs.writeFileSync(path.join(dest, `sticker-${counters.png}.png`), buffer);
          downloadedCount++;
        }
        spinner.text = `Processed ${i + 1}/${validEntries.length}...`;
      }
    }

    spinner.succeed(chalk.green(`Successfully downloaded "${packTitle}" (${downloadedCount} items: ${counters.gif} GIF, ${counters.png} PNG)`));
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

    const cleanTitle = packTitle.split("—")[0].split("|")[0].split("–")[0].trim();
    const safeTitle = cleanTitle.replace(/#/g, "No.").replace(/[%^~\[\]]/g, "").replace(/[\/\\?%*:|"<>]/g, "").replace(/\s+/g, " ").trim() || "line-pack";
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
        } catch (_) {}
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
