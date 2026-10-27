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

const apng2gifBinPath = require("apng2gif-bin");

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

  const shopType = match[1];
  const productId = match[2];

  let packTitle = `${shopType === "emojishop" ? "LINE Emojis" : "LINE Stickers"} ${productId}`;
  let itemsData = [];

  if (shopType === "emojishop") {
    try {
      const htmlRes = await fetch(pageUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (htmlRes.ok) {
        const htmlText = await htmlRes.text();
        const titleMatch = htmlText.match(/<p class="mdCMN08Ttl">([^<]+)<\/p>/) || htmlText.match(/<title>([^<]+)<\/title>/);
        if (titleMatch && titleMatch[1]) {
          let raw = titleMatch[1].split("—")[0].split("|")[0].split("–")[0].trim();
          if (raw) packTitle = raw;
        }
      }
    } catch (_) {}

    let consecutiveMisses = 0;
    for (let i = 1; i <= 200; i++) {
      const num = String(i).padStart(3, "0");
      const staticUrl = `https://stickershop.line-scdn.net/sticonshop/v1/sticon/${productId}/iPhone/${num}.png`;
      const animUrl = `https://stickershop.line-scdn.net/sticonshop/v1/sticon/${productId}/iPhone/${num}_animation.png`;

      const ok = (await probeUrl(animUrl)) || (await probeUrl(staticUrl));
      if (ok) {
        itemsData.push({ id: i, candidateUrls: [animUrl, staticUrl] });
        consecutiveMisses = 0;
      } else {
        consecutiveMisses++;
        if (consecutiveMisses >= 5) break;
      }
    }
  }

  if (shopType === "stickershop" && itemsData.length === 0) {
    try {
      const htmlRes = await fetch(pageUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        },
      });
      if (htmlRes.ok) {
        const htmlText = await htmlRes.text();

        const titleMatch = htmlText.match(/<p class="mdCMN08Ttl">([^<]+)<\/p>/) || htmlText.match(/<title>([^<]+)<\/title>/);
        if (titleMatch && titleMatch[1]) {
          let raw = titleMatch[1].split("—")[0].split("|")[0].split("–")[0].trim();
          if (raw) packTitle = raw;
        }

        const imageMatches = htmlText.matchAll(/https:\/\/[^\s"']+\/sticker\/[^\s"']+\.(?:png|gif)/g);
        const uniqueUrls = [...new Set([...imageMatches].map((m) => m[0]))];

        if (uniqueUrls.length > 0) {
          itemsData = uniqueUrls.map((u, idx) => ({
            id: idx + 1,
            candidateUrls: [u.replace("sticker@2x.png", "animation@2x.png"), u],
          }));
        }
      }
    } catch (_) {}

    if (itemsData.length === 0) {
      const metaUrls = [
        `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/iphone/productInfo.meta`,
        `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/PC/productInfo.meta`,
      ];

      let meta = null;
      for (const metaUrl of metaUrls) {
        try {
          const res = await fetch(metaUrl, {
            headers: { "User-Agent": "Mozilla/5.0", Referer: "https://store.line.me/" },
          });
          if (res.ok) {
            meta = await res.json();
            break;
          }
        } catch (_) {}
      }

      if (meta && (meta.stickers || meta.emojis)) {
        const list = meta.stickers || meta.emojis;
        if (meta.title?.en || meta.packageTitle?.en) {
          packTitle = meta.title?.en || meta.packageTitle?.en;
        }
        for (const item of list) {
          itemsData.push({
            id: item.id,
            candidateUrls: [
              `https://stickershop.line-scdn.net/stickershop/v1/sticker/${item.id}/iPhone/animation@2x.png?v=2`,
              `https://stickershop.line-scdn.net/stickershop/v1/sticker/${item.id}/iPhone/sticker@2x.png?v=2`,
              `https://stickershop.line-scdn.net/stickershop/v1/sticker/${item.id}/ANDROID/sticker.png?v=2`,
            ],
          });
        }
      }
    }
  }

  if (itemsData.length === 0) {
    throw new Error("Could not find any items or metadata for this product URL.");
  }

  return { packTitle, itemsData };
}

async function probeUrl(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://store.line.me/" },
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function downloadAndProcessItem(item, destDir, counters) {
  for (const url of item.candidateUrls) {
    let tempPath = null;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: "https://store.line.me/",
        },
      });
      if (!res.ok) continue;

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 50) continue;

      const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      tempPath = path.join(destDir, `tmp-${uid}.bin`);
      fs.writeFileSync(tempPath, buffer);

      const isAnimated = isApng(buffer);

      if (isAnimated) {
        try { fs.chmodSync(apng2gifBinPath, 0o755); } catch (_) {}

        const tempGif = path.join(destDir, `tmp-${uid}.gif`);
        try {
          await execFileAsync(apng2gifBinPath, [tempPath, tempGif]);
          counters.gif += 1;
          const finalGif = path.join(destDir, `sticker-${counters.gif}.gif`);
          fs.renameSync(tempGif, finalGif);
          fs.unlinkSync(tempPath);
          return { success: true, type: "gif" };
        } catch (convErr) {
          console.error(`[Convert Failed]:`, convErr.message);
          try { fs.unlinkSync(tempGif); } catch (_) {}
        }
      }

      counters.png += 1;
      const finalPng = path.join(destDir, `sticker-${counters.png}.png`);
      fs.renameSync(tempPath, finalPng);
      return { success: true, type: isAnimated ? "png-fallback" : "png" };
    } catch (_) {
      if (tempPath) try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }
  return { success: false };
}

function isApng(buffer) {
  if (buffer.length < 8) return false;
  const sig = buffer.slice(0, 8);
  if (!sig.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return false;
  }
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IDAT") return false;
    offset += 12 + length;
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

    const counters = { gif: 0, png: 0 };
    let downloadedCount = 0;

    for (let i = 0; i < itemsData.length; i++) {
      const result = await downloadAndProcessItem(itemsData[i], dest, counters);
      if (result.success) downloadedCount++;
      context.spinner.text = `Processed ${downloadedCount}/${itemsData.length} items...`;
      await sleep(120);
    }

    spinner.succeed(
      chalk.green(
        `Successfully downloaded "${packTitle}" (${downloadedCount} items: ${counters.gif} GIF, ${counters.png} PNG)`
      )
    );
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
    const safeTitle =
      cleanTitle
        .replace(/#/g, "No.")
        .replace(/[%^~\[\]]/g, "")
        .replace(/[\/\\?%*:|"<>]/g, "")
        .replace(/\s+/g, " ")
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
