#!/usr/bin/env node
/* Servidor de desarrollo: sirve public/ y monta las funciones de api/ como lo hace Vercel.
   Variables de entorno: ver .env.example.   Uso:  node dev/servidor.js [puerto] */
"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const PUBLIC = path.resolve(__dirname, "..", "public");
const API = path.resolve(__dirname, "..", "api");
// mismas cabeceras de seguridad que en Vercel (vercel.json), para que las pruebas las ejerciten
const CABECERAS = Object.fromEntries(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "vercel.json"), "utf8")).headers[0].headers.map((h) => [h.key, h.value]));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".png": "image/png" };

http.createServer(async (req, res) => {
  const ruta = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const m = ruta.match(/^\/api\/([a-z-]+)$/);
  if (m) {
    const f = path.join(API, m[1] + ".js");
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end("{}"); }
    return require(f)(req, res);
  }
  const p = path.join(PUBLIC, ruta === "/" ? "index.html" : ruta);
  if (!p.startsWith(PUBLIC) || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404); return res.end("404"); }
  res.writeHead(200, { ...CABECERAS, "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(p).pipe(res);
}).listen(Number(process.argv[2]) || 3100, "127.0.0.1", () => console.log("Panel (desarrollo) en http://localhost:" + (process.argv[2] || 3100)));
