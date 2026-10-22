"use strict";
/* Elimina certificados: quita su registro del JSON y borra sus archivos (PNG, JPG, PDF y página) en UN commit.
   Los códigos eliminados se anotan en data/eliminados.json y no se vuelven a asignar, para que un QR ya
   impreso nunca apunte a otra persona. */
const { HttpError, RE_CODIGO, manejador, leerCuerpo } = require("./_comun");
const gh = require("./_github");

const MAX_CODIGOS = 100;

async function intentar(codigos) {
  const [textoLista, textoElim] = await Promise.all([gh.leerArchivo("data/certificados.json"), gh.leerArchivo("data/eliminados.json")]);
  const lista = textoLista ? JSON.parse(textoLista) : [];
  const previos = textoElim ? JSON.parse(textoElim) : [];
  const faltan = codigos.filter((c) => !lista.some((x) => x.codigo === c));
  if (faltan.length) throw new HttpError(404, `No existen: ${faltan.join(", ")}`);

  const restantes = lista.filter((x) => !codigos.includes(x.codigo));
  const eliminados = [...new Set([...previos, ...codigos])].sort();
  const rels = codigos.flatMap((c) => [`certs/${c}.png`, `certs/${c}.jpg`, `certs/${c}.pdf`, `c/${c}.html`]);
  const existentes = await gh.rutasExistentes(rels); // borrar algo que no existe haría fallar el commit

  const archivos = [
    ...existentes.map((rel) => ({ rel, borrar: true })),
    { rel: "data/certificados.json", texto: JSON.stringify(restantes, null, 2) + "\n" },
    { rel: "data/eliminados.json", texto: JSON.stringify(eliminados, null, 2) + "\n" },
  ];
  const resumen = codigos.length === 1 ? codigos[0] : `${codigos.length} certificados`;
  await gh.confirmar(archivos, `Elimina ${resumen}`);
  return { ok: true, eliminados: codigos.length, archivos: existentes.length };
}

module.exports = manejador({ metodo: "POST" }, async (req) => {
  const { codigos } = await leerCuerpo(req, { max: 64 * 1024 });
  if (!Array.isArray(codigos) || !codigos.length || codigos.length > MAX_CODIGOS || !codigos.every((c) => RE_CODIGO.test(c || ""))) {
    throw new HttpError(400, "Lista de códigos inválida");
  }
  const unicos = [...new Set(codigos)];
  for (let intento = 1; ; intento++) {
    try { return await intentar(unicos); }
    catch (e) { if (intento < 3 && gh.esConflicto(e)) continue; throw e; }
  }
});
