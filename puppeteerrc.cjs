const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Changes the cache location for Puppeteer to be inside your project directory,
  // which persists between the build and runtime on Render.
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
