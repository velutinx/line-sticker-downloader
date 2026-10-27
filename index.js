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

// ---------------------------------------------------------------------------
// 1. SCRAPING / URL GENERATION
// ---------------------------------------------------------------------------

async function scrapeStickerData(context) {
  const { url: pageUrl } = context.config;

  const match = pageUrl.match(/\/(stickershop|emojishop)\/product\/([a-zA-Z0-9]+)/);
  if (!match) {
    throw new Error("Could not extract product type or ID from the provided URL.");
  }

  const shopType = match[1]; // 'stickershop' or 'emojishop'
  const productId = match[2];

  let packTitle = `${shopType === "emojishop" ? "LINE Emojis" : "LINE Stickers"} ${productId}`;
  let itemsData = [];

  // ---------- EMOJI PATH ----------
  if (shopType === "emojishop") {
    // Try to get a title from the HTML (optional)
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

    // Probe indices 1..200 until we hit consecutive 404s
    // URL patterns from: https://blog.zgqinc.gq/posts/l4n9e2/
    let consecutiveMisses = 0;
    for (let i = 1; i <= 200; i++) {
      const num = String(i).padStart(3, "0");
      const staticUrl = `https://stickershop.line-scdn.net/sticonshop/v1/sticon/${productId}/iPhone/${num}.png`;
      const animUrl = `https://stickershop.line-scdn.net/sticonshop/v1/sticon/${productId}/iPhone/${num}_animation.png`;

      // We don't know if the pack is animated until we fetch.
      // Store both candidates; the downloader will try them in order.
      itemsData.push({
        id: i,
        candidateUrls: [animUrl, staticUrl],
      });

      // Stop after 5 consecutive missing files (gives room for sparse indices)
      // A lightweight HEAD check is enough to decide whether to keep the entry.
      const ok = await probeUrl(animUrl) || await probeUrl(staticUrl);
      if (ok) {
        consecutiveMisses = 0;
      } else {
        consecutiveMisses++;
        itemsData.pop(); // remove the entry we just added
        if (consecutiveMisses >= 5) break;
      }
    }
  }

  // ---------- STICKER PATH ----------
  if (shopType === "stickershop" && itemsData.length === 0) {
    // Try HTML scraping first
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
            // Put animated first so the downloader prefers APNG when both exist
            candidateUrls: [
              u.replace("sticker@2x.png", "animation@2x.png"),
              u,
            ],
          }));
        }
      }
    } catch (_) {}

    // Fallback to metadata API
    if (itemsData.length === 0) {
      const metaUrls = [
        `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/iphone/productInfo.meta`,
        `https://stickershop.line-scdn.net/stickershop/v1/product/${productId}/PC/productInfo.meta`,
      ];

      let meta = null;
      for (const metaUrl of metaUrls) {
        try {
          const res = await fetch(metaUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0",
              Referer: "https://store.line.me/",
            },
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
          // Sticker URL patterns (both APNG and static)
          const candidates = [
            `https://stickershop.line-scdn.net/stickershop/v1/sticker/${item.id}/iPhone/animation@2x.png?v=2`,
            `https://stickershop.line-scdn.net/stickershop/v1/sticker/${item.id}/iPhone/sticker@2x.png?v=2`,
            `https://stickershop.line-scdn.net/stickershop/v1/sticker/${item.id}/ANDROID/sticker.png?v=2`,
          ];
          itemsData.push({ id: item.id, candidateUrls: candidates });
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

// ---------------------------------------------------------------------------
// 2. DOWNLOAD + CONVERSION
// ---------------------------------------------------------------------------

async function downloadAndProcessItem(item, destDir, index) {
  for (const url of item.candidateUrls) {
    let downloadedPath = null;
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

      // Use a neutral temp name; extension will be decided below
      const tempPath = path.join(destDir, `item-${index}.tmp`);
      fs.writeFileSync(tempPath, buffer);

      // Detect if the file is an APNG (animated) by checking the acTL chunk
      const isAnimated = isApng(buffer);

      if (isAnimated) {
        // Convert APNG → GIF, then delete the temp APNG
        const gifPath = path.join(destDir, `item-${index}.gif`);
        try { fs.chmodSync(apng2gifBinPath, 0o755); } catch (_) {}

        try {
          await execFileAsync(apng2gifBinPath, [tempPath, gifPath]);
          fs.unlinkSync(tempPath);
          return { success: true, type: "gif" };
        } catch (convErr) {
          console.error(`[Convert Failed] item-${index}:`, convErr.message);
          // If conversion fails, fall back to keeping the APNG as .png
          const pngPath = path.join(destDir, `item-${index}.png`);
          fs.renameSync(tempPath, pngPath);
          return { success: true, type: "png (conversion failed)" };
        }
      } else {
        // Static image → keep as .png
        const pngPath = path.join(destDir, `item-${index}.png`);
        fs.renameSync(tempPath, pngPath);
        return { success: true, type: "png" };
      }
    } catch (_) {
      // Try the next candidate URL
    }
  }

  return { success: false };
}

// Simple APNG detector: an APNG contains an `acTL` chunk before `IDAT`.
function isApng(buffer) {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length < 8) return false;
  const sig = buffer.slice(0, 8);
  if (!sig.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return false;
  }

  // Walk chunks looking for `acTL`
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IDAT") return false; // acTL must come before IDAT
    offset += 12 + length; // 4 len + 4 type + data + 4 CRC
  }
  return false;
}

// ---------------------------------------------------------------------------
// 3. MAIN DOWNLOAD FLOW
// ---------------------------------------------------------------------------

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
    let gifCount = 0;
    let pngCount = 0;

    for (let i = 0; i < itemsData.length; i++) {
      const result = await downloadAndProcessItem(itemsData[i], dest, i + 1);
      if (result.success) {
        downloadedCount++;
        if (result.type.startsWith("gif")) gifCount++;
        else pngCount++;
      }
      context.spinner.text = `Processed ${downloadedCount}/${itemsData.length} items...`;
      await sleep(120); // polite delay
    }

    spinner.succeed(
      chalk.green(
        `Successfully downloaded "${packTitle}" (${downloadedCount} items: ${gifCount} GIF, ${pngCount} PNG)`
      )
    );
    return { packTitle, count: downloadedCount };
  } catch (err) {
    if (context) context.spinner.fail(chalk.red(err.message));
    console.error("Error in downloadStickers:", err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 4. EXPRESS ROUTE
// ---------------------------------------------------------------------------

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
