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
const apng2gif = require("apng2gif");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function createContext(config) {
  const {
    url,
    dest = "stickers",
    animatedWaitDelay = 1000,
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
      "--disable-dev-shm-usage", // Crucial for Docker/Render environments
      "--disable-gpu",           // No GPU on the server
      "--single-process",        // Runs Chrome in a single process to save RAM
      "--no-zygote",             // Helps with single-process mode
      "--disable-accelerated-2d-canvas",
      "--disable-web-security"
    ],
  });

  const page = await browser.newPage();

  // Increase timeout to 90 seconds and use domcontentloaded to avoid timeouts
  // on slow servers waiting for heavy images/scripts.
  await page.goto(pageUrl, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  // Explicitly wait for the sticker elements to be rendered by LINE's scripts
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
            /url\((['"]?)(.*?)\1\)/gi, // Correctly extracts the URL
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

      context.spinner.text =
        `Converting ${urls.length} stickers to GIF...`;

      await Promise.all(
        urls.map((url, i) =>
          apng2gif(
            path.join(
              dest,
              `sticker-${i + 1}.png`
            )
          )
        )
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
      animatedWaitDelay = 1000,
    } = req.body;

    if (!url) {
      return res.status(400).json({
        error: "Missing LINE sticker URL",
      });
    }

    const folderName =
      `stickers-${Date.now()}`;

    const downloadPath = path.join(
      __dirname,
      "downloads",
      folderName
    );

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

    // Attach listeners BEFORE finalize, otherwise the "close"
    // event can fire before our handler is registered and the
    // response never gets sent (browser hangs forever).
    output.on("close", () => {

      res.download(
        zipPath,
        `${folderName}.zip`,
        (err) => {

          if (err) {
            console.error("send error:", err);
          }

          fs.rmSync(downloadPath, {
            recursive: true,
            force: true,
          });

          fs.rmSync(zipPath, {
            force: true,
          });

        }
      );

    });

    output.on("error", (err) => {

      console.error("output stream error:", err);

      if (!res.headersSent) {
        res.status(500).json({
          error: err.message,
        });
      }

    });

    archive.on("error", (err) => {

      console.error("archive error:", err);

      if (!res.headersSent) {
        res.status(500).json({
          error: err.message,
        });
      }

    });

    archive.pipe(output);

    archive.directory(downloadPath, false);

    // Do not await: finalize's promise resolves before the
    // underlying stream emits "close". Errors are handled via
    // archive.on("error") above.
    archive.finalize();

  } catch (err) {

    console.error(err);

    if (!res.headersSent) {
      res.status(500).json({
        error: err.message,
      });
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
