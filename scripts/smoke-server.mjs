import http from 'node:http';

http.createServer((req, res) => {
  if (req.url === '/api/healthy' || req.url === '/api/unhealthy') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ healthy: req.url === '/api/healthy', dependencies: { database: 'ready' } }));
  }
  if (req.url === '/app.js') {
    res.setHeader('Content-Type', 'text/javascript');
    return res.end('const p = document.createElement("p"); p.textContent = "ProdDoctor browser ready"; document.body.append(p);');
  }
  if (req.url === '/robots.txt') {
    res.setHeader('Content-Type', 'text/plain');
    return res.end('User-agent: *\nAllow: /');
  }
  if (req.url === '/sitemap.xml') {
    res.setHeader('Content-Type', 'application/xml');
    return res.end('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>');
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><meta name="viewport" content="width=device-width"><title>ProdDoctor smoke</title><body><h1>ProdDoctor smoke</h1><script src="/app.js"></script></body>');
}).listen(18765, '127.0.0.1');
