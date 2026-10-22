/* Dibujo del certificado sobre canvas. Se usa tanto para la vista previa como para generar el PNG final. */
(function (global) {
  "use strict";

  const CM_POR_PT = 2.54 / 72;

  function fuente(est, px, layout) {
    return `${est.cursiva ? "italic " : ""}${est.negrita ? "bold " : ""}${px}px ${layout.fuente}`;
  }

  function envolver(ctx, texto, anchoMax) {
    const palabras = texto.split(/\s+/).filter(Boolean);
    const lineas = [];
    let actual = "";
    for (const p of palabras) {
      const prueba = actual ? actual + " " + p : p;
      if (!actual || ctx.measureText(prueba).width <= anchoMax) actual = prueba;
      else { lineas.push(actual); actual = p; }
    }
    if (actual) lineas.push(actual);
    return lineas.length ? lineas : [""];
  }

  /**
   * Compone las líneas del bloque de texto aplicando una escala global.
   * - Nombre: se reduce hasta min_pt para caber en una línea; si aun así no cabe, salta de línea.
   * - Título: salta de línea; si pasa de 3 líneas, se reduce hasta min_pt.
   */
  function componer(ctx, layout, datos, pxPorCm, escala) {
    const est = layout.estilos;
    const anchoMax = (layout.caja_texto.ancho - 2 * layout.caja_texto.margen_horizontal) * pxPorCm;
    const pxPt = (pt) => pt * CM_POR_PT * pxPorCm * escala;
    const lineas = [];
    const vacio = () => lineas.push({ texto: "", px: pxPt(est.normal.pt), est: est.normal });

    lineas.push({ texto: layout.texto_fijo, px: pxPt(est.normal.pt), est: est.normal });
    vacio();

    // nombre
    const nombre = datos.nombre.trim().toUpperCase();
    let pt = est.nombre.pt, partes;
    for (;;) {
      ctx.font = fuente(est.nombre, pxPt(pt), layout);
      partes = envolver(ctx, nombre, anchoMax);
      if (partes.length === 1 || pt <= est.nombre.min_pt) break;
      pt = Math.max(est.nombre.min_pt, pt - 0.5);
    }
    partes.forEach((t) => lineas.push({ texto: t, px: pxPt(pt), est: est.nombre }));
    vacio();

    // la frase y las fechas también pueden ser largas: se envuelven
    ctx.font = fuente(est.normal, pxPt(est.normal.pt), layout);
    envolver(ctx, datos.frase.trim(), anchoMax)
      .forEach((t) => lineas.push({ texto: t, px: pxPt(est.normal.pt), est: est.normal }));

    // título entre comillas
    const titulo = "“" + datos.capacitacion.trim().replace(/^["“”«»]+|["“”«»]+$/g, "") + "”";
    pt = est.titulo.pt;
    for (;;) {
      ctx.font = fuente(est.titulo, pxPt(pt), layout);
      partes = envolver(ctx, titulo, anchoMax);
      if (partes.length <= 3 || pt <= est.titulo.min_pt) break;
      pt = Math.max(est.titulo.min_pt, pt - 0.5);
    }
    partes.forEach((t) => lineas.push({ texto: t, px: pxPt(pt), est: est.titulo }));
    vacio();

    const fechas = { texto: datos.fechas.trim(), px: pxPt(est.normal.pt), est: est.normal };
    ctx.font = fuente(est.normal, fechas.px, layout);
    envolver(ctx, fechas.texto, anchoMax).forEach((t) => lineas.push({ ...fechas, texto: t }));

    const alto = lineas.reduce((s, l) => s + l.px * layout.interlineado, 0);
    return { lineas, alto };
  }

  function dibujarTexto(ctx, layout, datos, pxPorCm) {
    const caja = layout.caja_texto;
    const altoMax = (caja.limite_inferior - caja.y - caja.margen_superior) * pxPorCm;
    let escala = 1, r;
    for (;;) {
      r = componer(ctx, layout, datos, pxPorCm, escala);
      if (r.alto <= altoMax || escala <= 0.55) break;
      escala -= 0.03;
    }
    const cx = (caja.x + caja.ancho / 2) * pxPorCm;
    let y = (caja.y + caja.margen_superior) * pxPorCm;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const base = layout.linea_base || 0.8; // posición de la línea base dentro de la altura de línea
    for (const l of r.lineas) {
      const alto = l.px * layout.interlineado;
      if (l.texto) {
        ctx.font = fuente(l.est, l.px, layout);
        ctx.fillStyle = l.est.color;
        ctx.fillText(l.texto, cx, y + alto * base);
      }
      y += alto;
    }
    return { escala, desborda: r.alto > altoMax };
  }

  function dibujarQR(ctx, layout, url, pxPorCm) {
    const q = layout.qr;
    const qr = global.qrcode(0, q.correccion_errores);
    qr.addData(url, "Byte");
    qr.make();
    const n = qr.getModuleCount();
    const total = n + 2 * q.margen_modulos;
    const lado = q.lado * pxPorCm;
    const mod = Math.floor(lado / total);
    const tam = mod * total;
    const ox = Math.round(q.x * pxPorCm + (lado - tam) / 2);
    const oy = Math.round(q.y * pxPorCm + (lado - tam) / 2);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(ox, oy, tam, tam);
    ctx.fillStyle = "#000000";
    for (let f = 0; f < n; f++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(f, c)) {
          ctx.fillRect(ox + (c + q.margen_modulos) * mod, oy + (f + q.margen_modulos) * mod, mod, mod);
        }
      }
    }
  }

  /**
   * @param canvas  canvas ya dimensionado como la imagen base
   * @param base    HTMLImageElement con certificado_base.png
   * @param datos   {nombre, capacitacion, fechas, frase, codigo}
   */
  function dibujarCertificado(canvas, base, layout, datos, baseUrl) {
    canvas.width = base.naturalWidth;
    canvas.height = base.naturalHeight;
    const ctx = canvas.getContext("2d");
    const pxPorCm = canvas.width / layout.diapositiva_cm[0];
    ctx.drawImage(base, 0, 0);
    const info = dibujarTexto(ctx, layout, datos, pxPorCm);
    if (datos.codigo) dibujarQR(ctx, layout, `${baseUrl}/c/${datos.codigo}`, pxPorCm);
    return info;
  }

  global.TCGRender = { dibujarCertificado, componer };
})(window);
