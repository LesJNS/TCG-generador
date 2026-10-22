"use strict";
/* Sube UN archivo binario (PNG, JPG o PDF) como blob de git. Vercel limita cada petición a 4,5 MB,
   por eso cada archivo viaja por separado y luego /api/publicar los reúne en un solo commit. */
const { HttpError, manejador, leerCuerpo } = require("./_comun");
const gh = require("./_github");

module.exports = manejador({ metodo: "POST", tipo: "application/octet-stream" }, async (req) => {
  const datos = await leerCuerpo(req, { raw: true });
  if (!datos.length) throw new HttpError(400, "Archivo vacío");
  return { ok: true, sha: await gh.crearBlob(datos), bytes: datos.length };
});
