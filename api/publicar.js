"use strict";
const { CONFIG, RE_SHA, HttpError, baseUrl, manejador, leerCuerpo, ordenar, validarRegistro, paginaCredencial } = require("./_comun");
const gh = require("./_github");

const MAX_ITEMS = 40;

async function intentar({ items, sobrescribir }) {
  const [textoLista, plantilla] = await Promise.all([gh.leerArchivo("data/certificados.json"), gh.leerArchivo("credencial.html")]);
  if (!plantilla) throw new HttpError(502, "No se encontró credencial.html en el repositorio público");
  const lista = textoLista ? JSON.parse(textoLista) : [];
  const archivos = [];
  const vistos = new Set();

  for (const it of items) {
    const r = it && it.registro;
    const errores = validarRegistro(r);
    if (errores.length) throw new HttpError(400, `${(r && r.codigo) || "registro"}: ${errores.join(", ")}`);
    for (const k of ["png", "jpg", "pdf"]) if (!RE_SHA.test(it[k] || "")) throw new HttpError(400, `${r.codigo}: falta el archivo ${k}`);
    if (vistos.has(r.codigo)) throw new HttpError(400, `Código repetido en el lote: ${r.codigo}`);
    vistos.add(r.codigo);

    const i = lista.findIndex((c) => c.codigo === r.codigo);
    if (i >= 0 && !sobrescribir) throw new HttpError(409, `El código ${r.codigo} ya existe`);
    const previo = i >= 0 ? lista[i] : null;
    const reg = {
      codigo: r.codigo,
      nombre: r.nombre.trim(),
      area: (r.area || "").trim(),
      capacitacion: r.capacitacion.trim(),
      frase: r.frase.trim(),
      fechas: r.fechas.trim(),
      emisor: CONFIG.emisor,
      firmantes: CONFIG.firmantes,
      estado: previo ? previo.estado : "vigente",
      fecha_emision: previo ? previo.fecha_emision : new Date().toISOString().slice(0, 10),
      imagen: `certs/${r.codigo}.png`,
      vista: `certs/${r.codigo}.jpg`,
      pdf: `certs/${r.codigo}.pdf`,
    };
    if (previo && previo.fecha_revocacion) reg.fecha_revocacion = previo.fecha_revocacion;
    if (i >= 0) lista[i] = reg; else lista.push(reg);

    archivos.push(
      { rel: reg.imagen, sha: it.png },
      { rel: reg.vista, sha: it.jpg },
      { rel: reg.pdf, sha: it.pdf },
      { rel: `c/${reg.codigo}.html`, texto: paginaCredencial(plantilla, reg, baseUrl()) },
    );
  }
  archivos.push({ rel: "data/certificados.json", texto: JSON.stringify(ordenar(lista), null, 2) + "\n" });

  const resumen = items.length === 1 ? items[0].registro.codigo : `${items.length} certificados`;
  const sha = await gh.confirmar(archivos, `${sobrescribir ? "Regenera" : "Emite"} ${resumen}`);
  return { ok: true, commit: sha, codigos: items.map((x) => x.registro.codigo) };
}

module.exports = manejador({ metodo: "POST" }, async (req) => {
  const body = await leerCuerpo(req, { max: 1024 * 1024 });
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_ITEMS) {
    throw new HttpError(400, `Se esperan entre 1 y ${MAX_ITEMS} certificados por lote`);
  }
  for (let intento = 1; ; intento++) {
    try { return await intentar({ items: body.items, sobrescribir: !!body.sobrescribir }); }
    catch (e) {
      // otro commit llegó en medio: se vuelve a leer el JSON y se reintenta
      if (intento < 3 && gh.esConflicto(e)) continue;
      throw e;
    }
  }
});
