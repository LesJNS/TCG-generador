#!/usr/bin/env node
/* GitHub simulado en memoria (solo para pruebas locales): implementa los endpoints que usa api/_github.js.
   Uso: GH_TOKEN=xxx SEMILLA=ruta/a/publico PUERTO=4010 node dev/github_falso.js
   Siembra el repo con SEMILLA/{credencial.html,data/certificados.json} bajo el prefijo "publico/". */
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const TOKEN = process.env.GH_TOKEN || "token-de-prueba";
const PUERTO = Number(process.env.PUERTO) || 4010;
const REPO = process.env.GH_REPO || "LesJNS/tcg-certificados";
const sha1 = (...partes) => { const h = crypto.createHash("sha1"); partes.forEach((p) => h.update(p)); return h.digest("hex"); };

const blobs = new Map();       // sha -> Buffer
const arboles = new Map();     // sha -> Map(path -> sha de blob)
const commits = new Map();     // sha -> { tree, parents, message }
const refs = { main: null };
const registro = [];           // log de commits para las pruebas
let conflictoProximo = false;

function blob(buf) { const s = sha1("blob ", String(buf.length), "\0", buf); blobs.set(s, buf); return s; }
function arbol(mapa) { const s = sha1("tree ", JSON.stringify([...mapa].sort())); arboles.set(s, mapa); return s; }
function commit(tree, parents, message) {
  const s = sha1("commit ", tree, parents.join(","), message, String(Date.now()), String(Math.random()));
  commits.set(s, { tree, parents, message }); return s;
}

// semilla
{
  const m = new Map();
  const dir = process.env.SEMILLA;
  if (dir) for (const rel of ["credencial.html", "data/certificados.json"]) {
    const f = path.join(dir, rel);
    if (fs.existsSync(f)) m.set("publico/" + rel, blob(fs.readFileSync(f)));
  }
  refs.main = commit(arbol(m), [], "semilla");
}
const cabeza = () => arboles.get(commits.get(refs.main).tree);

function json(res, status, obj) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);

  // utilidades de prueba (sin autenticación)
  if (p === "/_test/archivo") { const s = cabeza().get(url.searchParams.get("path")); return s ? (res.writeHead(200), res.end(blobs.get(s))) : json(res, 404, {}); }
  if (p === "/_test/lista") return json(res, 200, [...cabeza().keys()].sort());
  if (p === "/_test/log") return json(res, 200, registro);
  if (p === "/_test/conflicto") { conflictoProximo = true; return json(res, 200, { ok: true }); }

  if ((req.headers.authorization || "") !== `Bearer ${TOKEN}`) return json(res, 401, { message: "Bad credentials" });
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  const base = `/repos/${REPO}`;
  if (!p.startsWith(base + "/")) return json(res, 404, { message: "Not Found" });
  const r = p.slice(base.length);
  let m;

  if (req.method === "GET" && (m = r.match(/^\/contents\/(.+)$/))) {
    const s = cabeza().get(m[1]);
    if (!s) return json(res, 404, { message: "Not Found" });
    res.writeHead(200, { "Content-Type": "application/vnd.github.raw" }); return res.end(blobs.get(s));
  }
  if (req.method === "POST" && r === "/git/blobs") {
    if (body.encoding !== "base64") return json(res, 422, { message: "solo base64" });
    return json(res, 201, { sha: blob(Buffer.from(body.content, "base64")) });
  }
  if (req.method === "GET" && (m = r.match(/^\/git\/ref\/heads\/(.+)$/))) {
    return refs[m[1]] ? json(res, 200, { object: { sha: refs[m[1]] } }) : json(res, 404, { message: "Not Found" });
  }
  if (req.method === "GET" && (m = r.match(/^\/git\/commits\/(\w+)$/))) {
    const c = commits.get(m[1]); return c ? json(res, 200, { sha: m[1], tree: { sha: c.tree } }) : json(res, 404, { message: "Not Found" });
  }
  if (req.method === "POST" && r === "/git/trees") {
    const mapa = new Map(arboles.get(body.base_tree) || []);
    for (const e of body.tree) {
      let s = e.sha;
      if (e.content !== undefined) s = blob(Buffer.from(e.content, "utf8"));
      if (!blobs.has(s)) return json(res, 422, { message: `Invalid tree entry: sha ${s} no existe` });
      mapa.set(e.path, s);
    }
    return json(res, 201, { sha: arbol(mapa) });
  }
  if (req.method === "POST" && r === "/git/commits") {
    if (!arboles.has(body.tree)) return json(res, 422, { message: "tree inválido" });
    return json(res, 201, { sha: commit(body.tree, body.parents, body.message) });
  }
  if (req.method === "PATCH" && (m = r.match(/^\/git\/refs\/heads\/(.+)$/))) {
    if (conflictoProximo) { // simula que otro commit llegó antes
      conflictoProximo = false;
      refs[m[1]] = commit(commits.get(refs[m[1]]).tree, [refs[m[1]]], "commit concurrente");
    }
    const c = commits.get(body.sha);
    if (!c || c.parents[0] !== refs[m[1]]) return json(res, 422, { message: "Update is not a fast forward" });
    refs[m[1]] = body.sha; registro.push({ sha: body.sha, message: c.message });
    return json(res, 200, { object: { sha: body.sha } });
  }
  json(res, 404, { message: "Not Found" });
}).listen(PUERTO, "127.0.0.1", () => console.log(`GitHub falso en :${PUERTO}`));
