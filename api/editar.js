"use strict";
/* Edita datos que NO se imprimen en el certificado (empresa y área) de uno o varios certificados,
   en un solo commit. No toca imágenes ni QR. */
const { HttpError, RE_CODIGO, manejador, leerCuerpo } = require("./_comun");
const gh = require("./_github");

const MAX_CODIGOS = 200;

async function intentar(codigos, cambios) {
  const texto = await gh.leerArchivo("data/certificados.json");
  const lista = texto ? JSON.parse(texto) : [];
  const faltan = codigos.filter((c) => !lista.some((x) => x.codigo === c));
  if (faltan.length) throw new HttpError(404, `No existen: ${faltan.join(", ")}`);
  for (const reg of lista) {
    if (codigos.includes(reg.codigo)) Object.assign(reg, cambios);
  }
  const resumen = codigos.length === 1 ? codigos[0] : `${codigos.length} certificados`;
  await gh.confirmar([{ rel: "data/certificados.json", texto: JSON.stringify(lista, null, 2) + "\n" }],
    `Actualiza empresa/área de ${resumen}`);
  return { ok: true, actualizados: codigos.length };
}

module.exports = manejador({ metodo: "POST" }, async (req) => {
  const body = await leerCuerpo(req, { max: 64 * 1024 });
  const { codigos } = body;
  if (!Array.isArray(codigos) || !codigos.length || codigos.length > MAX_CODIGOS || !codigos.every((c) => RE_CODIGO.test(c || ""))) {
    throw new HttpError(400, "Lista de códigos inválida");
  }
  const cambios = {};
  for (const k of ["empresa", "area"]) {
    if (body[k] === undefined) continue; // sin cambios en este campo
    if (typeof body[k] !== "string" || body[k].length > 200) throw new HttpError(400, `${k} inválido`);
    cambios[k] = body[k].trim();
  }
  if (!Object.keys(cambios).length) throw new HttpError(400, "No hay cambios que aplicar");
  const unicos = [...new Set(codigos)];
  for (let intento = 1; ; intento++) {
    try { return await intentar(unicos, cambios); }
    catch (e) { if (intento < 3 && gh.esConflicto(e)) continue; throw e; }
  }
});
