"use strict";
const { HttpError, RE_CODIGO, hoyLima, manejador, leerCuerpo } = require("./_comun");
const gh = require("./_github");

async function intentar(codigo, estado) {
  const texto = await gh.leerArchivo("data/certificados.json");
  const lista = texto ? JSON.parse(texto) : [];
  const c = lista.find((x) => x.codigo === codigo);
  if (!c) throw new HttpError(404, "No existe ese certificado");
  c.estado = estado;
  if (estado === "revocado") c.fecha_revocacion = hoyLima();
  else delete c.fecha_revocacion;
  await gh.confirmar([{ rel: "data/certificados.json", texto: JSON.stringify(lista, null, 2) + "\n" }],
    `${estado === "revocado" ? "Revoca" : "Reactiva"} ${codigo}`);
  return { ok: true, registro: c };
}

module.exports = manejador({ metodo: "POST" }, async (req) => {
  const { codigo, estado } = await leerCuerpo(req, { max: 4096 });
  if (!RE_CODIGO.test(codigo || "")) throw new HttpError(400, "Código inválido");
  if (!["vigente", "revocado"].includes(estado)) throw new HttpError(400, "Estado inválido");
  for (let intento = 1; ; intento++) {
    try { return await intentar(codigo, estado); }
    catch (e) { if (intento < 3 && gh.esConflicto(e)) continue; throw e; }
  }
});
