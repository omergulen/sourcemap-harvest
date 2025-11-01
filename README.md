# sourcemap-harvest

Extract original source files from website sourcemaps using Chrome DevTools Protocol (CDP).

## What It Does

When websites deploy JavaScript, they often include sourcemaps that map the minified/bundled code back to the original source files. This tool:

1. **Connects** to a website using Puppeteer and Chrome DevTools Protocol
2. **Collects** all JavaScript files and their associated sourcemap references
3. **Extracts** original source file paths and content from the sourcemaps
4. **Saves** the original source files to your local filesystem

This is useful for:
- Researching website architecture and code structure
- Learning from real-world code patterns and implementations
- Security research and vulnerability analysis
- Understanding how modern web applications are built
- Educational purposes (with permission from website owners)

## Installation

```bash
npm install
```

## Usage

```bash
node index.js <url> [url2] [url3] ...
```

Or use the npm script:
```bash
npm start <url>
```

Examples:
```bash
# Single page (usually enough for SPAs)
node index.js https://example.com

# Multiple pages (useful for MPAs or to capture route-specific code in SPAs)
node index.js https://example.com https://example.com/about https://example.com/contact
```

**Tip**: 
- **For SvelteKit/SPAs**: The tool automatically discovers routes from navigation links and visits them to load route-specific chunks. Visiting just the main page usually works well, but you can list additional routes to ensure complete coverage.
- **For Multi-Page Applications**: You'll need to list multiple URLs to capture all pages.

The extracted source files will be saved to the `out/` directory.

## Configuration

Edit `PATH_FILTERS` in `index.js` to filter which files to save:

```javascript
// Only keep paths containing any of these substrings (empty array = keep all)
const PATH_FILTERS = ['/src/'];
```

Set it to an empty array `[]` to save all files.

## How It Works

The tool leverages Chrome DevTools Protocol to access the same debugging information that browser DevTools use:

1. **Launches** a headless Chrome browser via Puppeteer
2. **Enables** Chrome DevTools Protocol domains (Page, Runtime, Debugger)
3. **Navigates** to the target website and waits for all resources to load
4. **Listens** for all JavaScript files as they're parsed by the browser
5. **Collects** sourcemap references from each script
6. **Fetches** sourcemaps (from URLs, data URLs, or embedded references)
7. **Parses** sourcemaps to extract original source file paths and content
8. **Normalizes** paths (handles webpack://, rollup://, file://, etc.)
9. **Saves** files with path sanitization to prevent directory traversal attacks

The extracted files maintain their original directory structure where possible, making it easy to explore the codebase.

## Security & Safety

The tool includes several security measures:

- **Path Sanitization**: Prevents directory traversal attacks by normalizing `../` sequences
- **Safe Path Joining**: Ensures all file writes stay within the output directory
- **URL Validation**: Validates and safely resolves relative sourcemap URLs
- **Error Handling**: Gracefully handles malformed sourcemaps and network errors

**Important**: Only use this tool on websites you have permission to analyze. Respect robots.txt and terms of service.

## Requirements

- Node.js >= 14.0.0
- Puppeteer (installed via npm)

## License

MIT License - see [LICENSE](LICENSE) file for details.

**Disclaimer**: This software is provided "as is" without warranty of any kind. Users are responsible for ensuring they have permission to analyze any websites they target with this tool. The authors and contributors are not liable for any misuse or damages resulting from the use of this software.

