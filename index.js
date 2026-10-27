//index.js

const path = require("path");
const fs = require("fs");

const express = require("express");
const cors = require("cors");
const archiver = require("archiver");

const chalk = require("chalk");
const puppeteer = require("puppeteer");
const makeDir = require("make-dir");
const downloadImage = require("image-downloader").image;
const ora = require("ora");

const { execFile } = require("child_process");
const util = require("util");
const execFileAsync = util.promisify(execFile);

const apng2gifBinPath = require("apng2gif-bin");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function createContext(config) {
  const {
    url,
    dest = "stickers",
    animatedWaitDelay = 3000,
    convertToGif = false,
  } = config;

  return {
    spinner: ora("Downloading stickers..."),
    config: { url, dest, animatedWaitDelay, convertToGif },
  };
}

async function scrapeStickerUrls(context) {
  const { url: pageUrl, animatedWaitDelay } = context.config;

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
      "--disable-accelerated-2d-canvas",
      "--disable-web-security",
    ],
  });

  const page = await browser.newPage();
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 90000 });

  try {
    await page.waitForSelector('ul > li [style^="background-image"]', { timeout: 90000 });
  } catch (e) {
    console.log("Timed out waiting for stickers to render.");
  }

  const elementHandles = await page.$$('ul > li [style^="background-image"]');
  if (elementHandles.length === 0) {
    throw new Error("Could not find any stickers on the specified page");
  }

  const stickerUrls = [];
  let index = 0;
  const total = elementHandles.length;

  for (const elementHandle of elementHandles) {
    index++;
    context.spinner.text = `Scraping stickers (${index}/${total})...`;

    // 1. 点击贴纸
    await elementHandle.evaluate((node) => node.click());
    await sleep(animatedWaitDelay); // 等待动画加载

    // 2. 尝试获取动态 APNG 的 URL
    let url = await page.evaluate(() => {
      // 寻找所有带有 data-apng-src 的 canvas 元素
      const canvases = document.querySelectorAll("canvas[data-apng-src]");
      // 如果存在，取最后一个（最新打开的）元素的属性
      if (canvases.length > 0) {
        return canvases[canvases.length - 1].getAttribute("data-apng-src");
      }
      return null;
    });

    // 3. 如果没有找到动态 URL，则退回到获取静态背景图
    let isAnimated = false;
    if (url) {
      isAnimated = true;
    } else {
      url = await page.evaluate(
        (el) => el.style.backgroundImage.replace(/url\((['"]?)(.*?)\1\)/gi, "$2"),
        elementHandle
      );
    }

    console.log(`Sticker ${index}/${total}: Found ${isAnimated ? 'ANIMATED' : 'STATIC'} URL: ${url}`);
    stickerUrls.push(url);

    // 4. 关键步骤：关闭弹窗，为下一个贴纸做准备
    await page.evaluate(() => {
      // 常见的关闭按钮选择器，尝试多种可能性
      const closeSelectors = [
        '.mdLYCloseButton',          // LINE 商店常见的关闭按钮 class
        'button[aria-label="Close"]',
        '.stickerPreviewModal .close',
        '.modal-header button',
      ];
      for (const selector of closeSelectors) {
        const btn = document.querySelector(selector);
        if (btn) {
          btn.click();
          return;
        }
      }
      // 如果找不到关闭按钮，尝试点击遮罩层
      const overlay = document.querySelector('.mdLYOverlay, .modal-backdrop');
      if (overlay) overlay.click();
    });
    await sleep(500); // 给弹窗关闭一点时间
  }

  await browser.close();
  return stickerUrls;
}

async function downloadStickers(config = {}) {
  let context;
  try {
    context = createContext(config);
    const { spinner, config: { dest, convertToGif } } = context;

    spinner.start();
    let urls = await scrapeStickerUrls(context);
    urls = Array.from(new Set(urls)); // 去重

    if (urls.length === 0) throw new Error("No sticker URLs were found.");

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
            console.error(`[apng2gif] Failed: ${pngPath}:`, err.message);
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
    const { url, convertToGif = false, animatedWaitDelay = 3000 } = req.body;
    if (!url) return res.status(400).json({ error: "Missing LINE sticker URL" });

    const folderName = `stickers-${Date.now()}`;
    const downloadPath = path.join(__dirname, "downloads", folderName);

    await downloadStickers({ url, dest: downloadPath, convertToGif, animatedWaitDelay });

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
