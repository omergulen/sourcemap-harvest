#!/usr/bin/env node
/**
 * sourcemap-harvest - Extract original source files from website sourcemaps
 *
 * This tool uses Chrome DevTools Protocol via Puppeteer to:
 * 1. Connect to a website and enable debugging
 * 2. Collect all JavaScript files and their sourcemap references
 * 3. Parse sourcemaps to extract original source file paths
 * 4. Download/save original source files to local filesystem
 *
 * Usage: node index.js <url> [url2] [url3] ...
 * Example: node index.js https://example.com
 * Example: node index.js https://example.com https://example.com/about https://example.com/contact
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const puppeteer = require('puppeteer');

// ============================================================================
// Configuration
// ============================================================================

const TARGET_URLS = process.argv.slice(2).length > 0 
  ? process.argv.slice(2) 
  : ['https://example.com'];
const OUTPUT_DIR = 'out';

// Only keep files whose paths contain these substrings (empty array = keep all)
// Modify this to filter which files to extract
const PATH_FILTERS = ['/src/'];

// Wait time in milliseconds after network is idle to capture dynamically loaded scripts
// Increase this if the site loads content via code splitting or lazy loading
const WAIT_AFTER_LOAD_MS = 3000;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a file path matches the filter criteria
 */
const matchesFilter = (filePath) =>
  PATH_FILTERS.length === 0 ||
  PATH_FILTERS.some((filter) => (filePath || '').includes(filter));

/**
 * Create directory and parent directories if they don't exist
 */
const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

/**
 * Convert DevTools-style URLs to filesystem paths
 * Examples: webpack://./src/index.js -> webpack/src/index.js
 *           https://example.com/app.js -> example.com/app.js
 */
const urlToFilesystemPath = (url) => {
  if (!url) return 'anonymous.js';

  return (
    url
      .replace(/^webpack:\/\//, 'webpack/')
      .replace(/^rollup:\/\//, 'rollup/')
      .replace(/^file:\/\//, 'file/')
      .replace(/^vm:\/\//i, 'vm/')
      .replace(/^https?:\/\//, '')
      .replace(/[?#].*$/, '') || 'anonymous.js'
  );
};

/**
 * Normalize sourcemap path to a safe relative filesystem path
 * Handles webpack://, rollup://, file://, and URL patterns
 */
const normalizeSourceFilePath = (sourceFilePath) => {
  let normalized = sourceFilePath
    .replace(/^webpack:\/\//, 'webpack/')
    .replace(/^rollup:\/\//, 'rollup/')
    .replace(/^file:\/\//, 'file/')
    .replace(/^\.\//, '');

  // Convert HTTP URLs to filesystem paths
  if (/^https?:\/\//.test(normalized)) {
    normalized = normalized.replace(/^https?:\/\//, '');
  }

  // Remove leading slashes to ensure relative path
  normalized = normalized.replace(/^\/+/, '');

  // Ensure path has a filename
  if (!path.basename(normalized)) {
    normalized = path.join(normalized, 'index.txt');
  }

  return normalized;
};

/**
 * Sanitize relative path to prevent directory traversal attacks
 * Removes or neutralizes ../ sequences that would escape the base directory
 */
const sanitizePath = (relPath) => {
  if (!relPath) return '';

  // Remove leading slashes
  let sanitized = relPath.replace(/^\/+/, '');

  // Split by path separator and normalize
  const parts = sanitized.split(/[/\\]/);
  const result = [];

  for (const part of parts) {
    if (part === '..') {
      // Cancel out with previous directory if possible
      if (result.length > 0 && result[result.length - 1] !== '..') {
        result.pop();
      } else {
        // Can't go up further, replace with safe marker
        result.push('_up_');
      }
    } else if (part !== '.' && part !== '') {
      result.push(part);
    }
  }

  return result.join(path.sep);
};

/**
 * Safely join base directory with relative path, ensuring result stays within base
 * Throws error if path would escape the base directory
 */
const safePathJoin = (baseDir, relPath) => {
  const baseAbs = path.resolve(baseDir);
  const sanitized = sanitizePath(relPath);
  const full = path.resolve(baseAbs, sanitized);

  // Verify the result is still within base directory
  const baseNormalized = baseAbs + path.sep;
  const fullNormalized = full + path.sep;

  if (!fullNormalized.startsWith(baseNormalized)) {
    throw new Error(`Unsafe path: ${relPath} would escape base directory`);
  }

  return full;
};

// ============================================================================
// Network & Data Fetching
// ============================================================================

/**
 * Decode data URL (data:image/png;base64,...) to buffer
 */
const decodeDataUrl = (dataUrl) => {
  const match = String(dataUrl).match(/^data:([^,]*?)(;base64)?,(.*)$/i);
  if (!match) return null;

  const isBase64 = !!match[2];
  const data = isBase64
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'utf8');

  return data;
};

/**
 * Fetch URL content (HTTP/HTTPS/data URLs) and return as buffer
 * Handles redirects automatically
 */
const fetchUrl = (url) => {
  return new Promise((resolve, reject) => {
    try {
      // Handle data URLs
      if (url.startsWith('data:')) {
        const buffer = decodeDataUrl(url);
        return buffer ? resolve(buffer) : reject(new Error('Invalid data URL'));
      }

      // Handle HTTP/HTTPS URLs
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'http:' ? http : https;

      const req = client.get(urlObj, (res) => {
        // Handle redirects
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          return resolve(
            fetchUrl(new URL(res.headers.location, url).toString())
          );
        }

        // Handle errors
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }

        // Collect response chunks
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });

      req.on('error', reject);
    } catch (error) {
      reject(error);
    }
  });
};

/**
 * Resolve sourcemap URL relative to script URL if needed
 */
const resolveSourceMapUrl = (mapRef, scriptUrl) => {
  // Already absolute URL or data URL
  if (/^https?:|^data:|^file:|^webpack:\/\//i.test(mapRef)) {
    return mapRef;
  }

  // Resolve relative to script URL
  if (scriptUrl.startsWith('http')) {
    try {
      return new URL(mapRef, scriptUrl).toString();
    } catch (e) {
      return null;
    }
  }

  return mapRef;
};

// ============================================================================
// Main Extraction Logic
// ============================================================================

/**
 * Extract and save generated JavaScript files (before sourcemap expansion)
 */
const extractGeneratedScripts = async (scripts, client) => {
  let savedCount = 0;

  for (const [scriptId, metadata] of scripts) {
    const scriptPath = urlToFilesystemPath(metadata.url);

    // Apply filter
    if (!matchesFilter(scriptPath) && !matchesFilter(metadata.url)) {
      continue;
    }

    try {
      const { scriptSource } = await client.send('Debugger.getScriptSource', {
        scriptId,
      });

      const destPath = safePathJoin(OUTPUT_DIR, scriptPath || 'anonymous.js');
      ensureDir(path.dirname(destPath));
      fs.writeFileSync(destPath, scriptSource ?? '', 'utf8');
      savedCount++;
    } catch (e) {
      // Skip scripts that can't be retrieved
    }
  }

  return savedCount;
};

/**
 * Extract and save original source files from sourcemaps
 */
const extractOriginalSources = async (scripts) => {
  let savedCount = 0;
  let skippedNoMapRef = 0;
  let skippedFetchFailed = 0;
  let skippedInvalid = 0;

  for (const [, metadata] of scripts) {
    const scriptUrl = metadata.url || '';
    const sourceMapReference = metadata.sourceMapURL || '';

    if (!sourceMapReference) {
      skippedNoMapRef++;
      continue;
    }

    // Resolve sourcemap URL
    const sourceMapUrl = resolveSourceMapUrl(sourceMapReference, scriptUrl);
    if (!sourceMapUrl) {
      skippedFetchFailed++;
      continue;
    }

    // Fetch sourcemap
    let sourceMapBuffer;
    try {
      sourceMapBuffer = await fetchUrl(sourceMapUrl);
    } catch (e) {
      skippedFetchFailed++;
      continue; // Skip if sourcemap can't be fetched
    }

    // Parse sourcemap JSON
    let sourceMap;
    try {
      sourceMap = JSON.parse(sourceMapBuffer.toString('utf8'));
    } catch (e) {
      skippedInvalid++;
      continue; // Skip if sourcemap is invalid
    }

    // Get base URL for resolving relative source paths
    let sourceMapBaseUrl = null;
    try {
      sourceMapBaseUrl = new URL(sourceMapUrl);
    } catch (e) {
      // sourceMapUrl might not be a valid URL (e.g., data: or file:)
    }

    const sources = sourceMap.sources || [];
    const sourcesContent = sourceMap.sourcesContent || [];

    // Process each source file in the sourcemap
    for (let i = 0; i < sources.length; i++) {
      const sourceFilePath = sources[i] || '';
      let fileContent = null;

      // Prefer embedded content from sourcemap
      if (sourcesContent[i] != null) {
        fileContent = Buffer.from(String(sourcesContent[i]), 'utf8');
      } else if (sourceMapBaseUrl) {
        // Try to fetch from network relative to sourcemap URL
        try {
          const absoluteUrl = new URL(sourceFilePath, sourceMapBaseUrl).toString();
          fileContent = await fetchUrl(absoluteUrl);
        } catch (e) {
          // Source file not available, skip
        }
      }

      if (!fileContent) continue;

      // Normalize source path for filesystem
      const normalizedPath = normalizeSourceFilePath(sourceFilePath);

      // Apply filter
      if (!matchesFilter(normalizedPath) && !matchesFilter('/' + normalizedPath)) {
        continue;
      }

      // Save file
      const destPath = safePathJoin(OUTPUT_DIR, normalizedPath);
      ensureDir(path.dirname(destPath));
      fs.writeFileSync(destPath, fileContent);
      savedCount++;
    }
  }

  if (skippedNoMapRef > 0 || skippedFetchFailed > 0 || skippedInvalid > 0) {
    console.log(
      `  Note: ${skippedNoMapRef} script(s) had no sourcemap, ` +
        `${skippedFetchFailed} sourcemap(s) couldn't be fetched, ` +
        `${skippedInvalid} sourcemap(s) were invalid`
    );
  }

  return savedCount;
};

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Process a single URL and collect all scripts
 * For SvelteKit/SPAs: attempts to discover and navigate to routes programmatically
 */
const processUrl = async (url, cdpClient, page, scripts) => {
  console.log(`\n📍 Processing: ${url}`);

  // Navigate to target page and wait for all resources
  console.log('  Loading page and collecting scripts...');
  await page.goto(url, { waitUntil: 'networkidle0' });

  // Wait additional time for dynamically loaded scripts (code splitting, lazy loading)
  if (WAIT_AFTER_LOAD_MS > 0) {
    console.log(`  Waiting ${WAIT_AFTER_LOAD_MS}ms for dynamically loaded content...`);
    await new Promise((resolve) => setTimeout(resolve, WAIT_AFTER_LOAD_MS));
  }

  // For SvelteKit/SPAs: try to discover and click navigation links to load route chunks
  console.log('  Discovering and navigating to routes...');
  try {
    const discoveredRoutes = await page.evaluate(() => {
      const routes = new Set();
      // Find all anchor tags that look like internal navigation
      document.querySelectorAll('a[href]').forEach((link) => {
        const href = link.getAttribute('href');
        if (href && !href.startsWith('http') && !href.startsWith('#') && href.startsWith('/')) {
          routes.add(href);
        }
      });
      return Array.from(routes).slice(0, 10); // Limit to first 10 routes to avoid too many
    });

    // Navigate to discovered routes (SvelteKit will load route-specific chunks)
    for (const route of discoveredRoutes.slice(0, 5)) {
      try {
        const fullUrl = new URL(route, url).toString();
        const scriptCountBefore = scripts.size;
        
        await page.goto(fullUrl, { waitUntil: 'networkidle0', timeout: 5000 });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        
        if (scripts.size > scriptCountBefore) {
          console.log(`    → Found new scripts at ${route}`);
        }
      } catch (e) {
        // Route might not exist or timeout, continue
      }
    }
    
    // Return to original page
    await page.goto(url, { waitUntil: 'networkidle0' });
  } catch (e) {
    // Route discovery failed, continue with normal flow
  }

  // Try to trigger lazy-loaded routes in SPAs by scrolling
  console.log('  Scrolling page to trigger lazy-loaded content...');
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });

  // Wait a bit more after scrolling for any triggered scripts
  if (WAIT_AFTER_LOAD_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

(async () => {
  console.log(`🚀 sourcemap-harvest - Processing ${TARGET_URLS.length} URL(s)`);

  // Launch browser and enable CDP
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  const cdpClient = await page.target().createCDPSession();

  // Enable required CDP domains
  await cdpClient.send('Page.enable');
  await cdpClient.send('Runtime.enable');
  await cdpClient.send('Debugger.enable');

  // Collect all scripts as they're parsed (across all URLs)
  const scripts = new Map(); // scriptId -> { url, sourceMapURL }

  cdpClient.on('Debugger.scriptParsed', (event) => {
    scripts.set(event.scriptId, {
      url: event.url || event.sourceURL || '',
      sourceMapURL: event.sourceMapURL || '',
    });
  });

  // Process each URL
  for (const url of TARGET_URLS) {
    try {
      await processUrl(url, cdpClient, page, scripts);
    } catch (error) {
      console.error(`  ⚠️  Error processing ${url}:`, error.message);
    }
  }

  console.log(`\n📦 Collected ${scripts.size} unique script(s) across all pages`);

  // Prepare output directory
  ensureDir(OUTPUT_DIR);

  // Extract and save files
  console.log('📥 Extracting source files...');
  const savedGenerated = await extractGeneratedScripts(scripts, cdpClient);
  const savedOriginal = await extractOriginalSources(scripts);

  await browser.close();

  console.log(
    `\n✓ Saved ${savedGenerated} generated script(s) and ${savedOriginal} original source file(s) into ${OUTPUT_DIR}/`
  );
})();
