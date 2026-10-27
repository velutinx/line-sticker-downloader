// Replace this block in index.js:
  await page.goto(pageUrl, {
    waitUntil: "networkidle2",
  });

  const stickerUrls = [];

  const elementHandles = await page.$$(
    'ul > li [style^="background-image"]'
  );

// WITH THIS:
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
