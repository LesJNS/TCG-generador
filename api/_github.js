"use strict";
/* Cliente mínimo de la API de GitHub (solo fetch). El token nunca sale de esta capa. */
const { HttpError } = require("./_comun");

function ajustes() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO; // "usuario/repositorio" del sitio público
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new HttpError(500, "Falta configurar GITHUB_TOKEN y GITHUB_REPO (usuario/repositorio)");
  }
  return {
    token, repo,
    rama: process.env.GITHUB_BRANCH || "main",
    dir: (process.env.PUBLIC_DIR || "publico").replace(/^\/+|\/+$/g, ""),
    api: (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
  };
}

async function gh(metodo, ruta, cuerpo, aceptar) {
  const a = ajustes();
  const r = await fetch(a.api + ruta, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${a.token}`,
      Accept: aceptar || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tcg-generador",
      ...(cuerpo ? { "Content-Type": "application/json" } : {}),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  if (r.status === 404 && metodo === "GET") return null;
  if (!r.ok) {
    let detalle = "";
    try { detalle = (await r.json()).message || ""; } catch { /* sin cuerpo */ }
    const e = new HttpError(502, `GitHub respondió ${r.status}${detalle ? ": " + detalle : ""}`);
    e.githubStatus = r.status;
    e.githubMensaje = detalle;
    throw e;
  }
  return aceptar && aceptar.includes("raw") ? r.text() : r.json();
}

const ruta = (a, resto) => `/repos/${a.repo}${resto}`;

/** Contenido de un archivo de texto de la rama (o null si no existe). */
async function leerArchivo(rel) {
  const a = ajustes();
  const path = `${a.dir}/${rel}`.split("/").map(encodeURIComponent).join("/");
  return gh("GET", ruta(a, `/contents/${path}?ref=${encodeURIComponent(a.rama)}`), null, "application/vnd.github.raw+json");
}

/** Crea un blob (sin commit) y devuelve su sha. */
async function crearBlob(buffer) {
  const a = ajustes();
  const r = await gh("POST", ruta(a, "/git/blobs"), { content: buffer.toString("base64"), encoding: "base64" });
  return r.sha;
}

/**
 * Un único commit con varios archivos.
 * archivos: [{ rel, sha }] binarios ya subidos, [{ rel, texto }] texto o [{ rel, borrar: true }] para eliminar.
 */
async function confirmar(archivos, mensaje) {
  const a = ajustes();
  const ref = await gh("GET", ruta(a, `/git/ref/heads/${encodeURIComponent(a.rama)}`));
  if (!ref) throw new HttpError(502, `La rama ${a.rama} no existe en ${a.repo}`);
  const padre = ref.object.sha;
  const commitPadre = await gh("GET", ruta(a, `/git/commits/${padre}`));
  const tree = await gh("POST", ruta(a, "/git/trees"), {
    base_tree: commitPadre.tree.sha,
    tree: archivos.map((f) => ({
      path: `${a.dir}/${f.rel}`,
      mode: "100644",
      type: "blob",
      ...(f.borrar ? { sha: null } : f.sha ? { sha: f.sha } : { content: f.texto }),
    })),
  });
  const commit = await gh("POST", ruta(a, "/git/commits"), { message: mensaje, tree: tree.sha, parents: [padre] });
  await gh("PATCH", ruta(a, `/git/refs/heads/${encodeURIComponent(a.rama)}`), { sha: commit.sha, force: false });
  return commit.sha;
}

/** De las rutas dadas (relativas a PUBLIC_DIR), las que existen hoy en la rama. */
async function rutasExistentes(rels) {
  const a = ajustes();
  const ref = await gh("GET", ruta(a, `/git/ref/heads/${encodeURIComponent(a.rama)}`));
  if (!ref) throw new HttpError(502, `La rama ${a.rama} no existe en ${a.repo}`);
  const commit = await gh("GET", ruta(a, `/git/commits/${ref.object.sha}`));
  const arbol = await gh("GET", ruta(a, `/git/trees/${commit.tree.sha}?recursive=1`));
  if (!arbol || arbol.truncated) throw new HttpError(502, "No se pudo listar el repositorio (demasiado grande)");
  const presentes = new Set(arbol.tree.map((t) => t.path));
  return rels.filter((r) => presentes.has(`${a.dir}/${r}`));
}

/** ¿El error es una carrera con otro commit (la rama avanzó)? */
const esConflicto = (e) => e && (e.githubStatus === 422 || e.githubStatus === 409) && /fast.?forward|reference|conflict/i.test(e.githubMensaje || "");

module.exports = { leerArchivo, crearBlob, confirmar, rutasExistentes, esConflicto, ajustes };
