#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8080;
const ROOT_DIR = __dirname;

const server = http.createServer((req, res) => {
  // Parse URL
  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;

  // Decode URL-encoded paths
  try {
    pathname = decodeURIComponent(pathname);
  } catch (e) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  // Remove leading slash
  if (pathname.startsWith('/')) {
    pathname = pathname.slice(1);
  }

  // Default to index.html if root
  if (!pathname || pathname === '' || pathname === '/') {
    pathname = 'Campaign Dashboard HTML.html';
  }

  const filePath = path.join(ROOT_DIR, pathname);

  // Security: prevent directory traversal
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // Try to serve the file
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found: ' + pathname);
      return;
    }

    // Determine content type
    let contentType = 'text/plain';
    if (pathname.endsWith('.html')) contentType = 'text/html';
    else if (pathname.endsWith('.js')) contentType = 'application/javascript';
    else if (pathname.endsWith('.json')) contentType = 'application/json';
    else if (pathname.endsWith('.css')) contentType = 'text/css';
    else if (pathname.endsWith('.png')) contentType = 'image/png';
    else if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) contentType = 'image/jpeg';
    else if (pathname.endsWith('.gif')) contentType = 'image/gif';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`✓ HTTP Server running on port ${PORT}`);
  console.log(`  http://localhost:${PORT}/Campaign%20Dashboard%20HTML.html`);
});
