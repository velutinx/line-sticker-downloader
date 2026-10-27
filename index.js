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

// Get the path to the bundled apng2gif binary
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
    animatedWaitDelay = 3000, // Increased default wait time
    convertToGif = false,
  } = config;

  return {
    spinner: ora("Downloading stickers..."),
    config: {
      url,
      dest,
      animatedWaitDelay,
      convertToGif,
    },
  };
}

async function scrapeStickerUrls(context) {
  const {
    url: pageUrl,
    animatedWaitDelay,
  } = context.config;

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
      "--disable-web-security"
    ],
  });

  const page = await browser.newPage();

  await page.goto(pageUrl, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  try {
    await page.waitForSelector('ul > li [style^="background-image"]', {
      timeout: 90000,
    });
  } catch (e) {
    console.log("Timed out waiting for stickers to render.");
  }

  const stickerUrls = [];

  const elementHandles = await page.$$(
    'ul > li [style^="background-image"]'
  );

  if (elementHandles.length === 0) {
    throw new Error(
      "Could not find any stickers on the specified page"
    );
  }

  let index = 0;
  const total = elementHandles.length;

  for (const elementHandle of elementHandles) {
    index++;

    context.spinner.text =
      `Scraping stickers (${index}/${total})...`;

    await elementHandle.evaluate((node) => node.click());

    await sleep(animatedWaitDelay);

    const canvasHandles = await page.$$(
      "canvas[data-apng-src]"
    );

    let url;

    if (canvasHandles.length === 2) {
      url = await page.evaluate(
        (el) => el.getAttribute("data-apng-src"),
        canvasHandles[1]
      );
    } else {
      url = await page.evaluate(
        (el) =>
          el.style.backgroundImage.replace(
            /url\((['"]?)(.*?)\1\)/gi,
            "$2"
          ),
        elementHandle
      );
    }

    stickerUrls.push(url);
  }

  await browser.close();

  return stickerUrls;
}

async function downloadStickers(config = {}) {
  let context;

  try {
    context = createContext(config);

    const {
      spinner,
      config: {
        dest,
        convertToGif,
      },
    } = context;

    spinner.start();

    let urls = await scrapeStickerUrls(context);

    urls = Array.from(new Set(urls));

    await makeDir(dest);

    context.spinner.text =
      `Downloading ${urls.length} stickers...`;

    await Promise.all(
      urls.map((url, i) =>
        downloadImage({
          url,
          dest: path.join(
            dest,
            `sticker-${i + 1}.png`
          ),
        })
      )
    );

    if (convertToGif) {
      // --- DIAGNOSTIC CHECKS ---
      try {
        fs.accessSync(apng2gifBinPath, fs.constants.X_OK);
        console.log(`[apng2gif] Binary is executable: ${apng2gifBinPath}`);
      } catch (err) {
        console.error(`[apng2gif] Binary is NOT executable or missing: ${apng2gifBinPath}`, err.message);
        try {
          fs.chmodSync(apng2gifBinPath, 0o755);
          console.log(`[apng2gif] Attempted to chmod binary to 755.`);
        } catch (chmodErr) {
          console.error(`[apng2gif] Failed to chmod binary:`, chmodErr.message);
        }
      }
      // --- END DIAGNOSTIC CHECKS ---

      context.spinner.text =
        `Converting ${urls.length} stickers to GIF...`;

      await Promise.all(
        urls.map(async (url, i) => {
          const pngPath = path.join(dest, `sticker-${i + 1}.png`);
          const gifPath = path.join(dest, `sticker-${i + 1}.gif`);
          
          try {
            await execFileAsync(apng2gifBinPath, [pngPath, gifPath]);
            console.log(`[apng2gif] Success: ${pngPath} -> ${gifPath}`);
          } catch (err) {
            console.error(`[apng2gif] Failed to convert ${pngPath}:`, err);
          }
        })
      );
    }

    spinner.succeed(
      chalk.green(`Saved stickers to ${dest}/`)
    );

    return urls.length;

  } catch (err) {
    if (context) {
      context.spinner.fail(
        chalk.red(err.message)
      );
    }
    console.error(err.stack);
    throw err;
  }
}

app.post("/download", async (req, res) => {
  try {
    const {
      url,
      convertToGif = false,
      animatedWaitDelay = 3000, // Increased default here as well
    } = req.body;

    if (!url) {
      return res.status(400).json({
        error: "Missing LINE sticker URL",
      });
    }

    const folderName = `stickers-${Date.now()}`;
    const downloadPath = path.join(__dirname, "downloads", folderName);

    await downloadStickers({
      url,
      dest: downloadPath,
      convertToGif,
      animatedWaitDelay,
    });

    const zipPath = `${downloadPath}.zip`;
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", {
      zlib: {
        level: 9,
      },
    });

    // Attach listeners BEFORE finalize
    output.on("close", () => {
      res.download(
        zipPath,
        `${folderName}.zip`,
        (err) => {
          if (err) {
            console.error("send error:", err);
          }
          fs.rmSync(downloadPath, { recursive: true, force: true });
          fs.rmSync(zipPath, { force: true });
        }
      );
    });

    output.on("error", (err) => {
      console.error("output stream error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });

    archive.on("error", (err) => {
      console.error("archive error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });

    archive.pipe(output);
    archive.directory(downloadPath, false);
    archive.finalize();

  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(
    `Server running on port ${
      process.env.PORT || 3000
    }`
  );
});
