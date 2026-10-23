"""Prueba de extremo a extremo del panel, sin Vercel ni GitHub reales.

Arranca dev/github_falso.js (GitHub simulado, sembrado con ../publico) y dev/servidor.js, y recorre el
flujo completo en un navegador (Edge vía Playwright). Requiere: Node 20+, playwright, pillow, opencv-python, pymupdf.

    python dev/probar_panel.py
"""
import base64
import hashlib
import hmac
import io
import json
import shutil
import tempfile
import zipfile
import os
import re
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import cv2
import numpy as np
import pymupdf
from PIL import Image
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
RAIZ = Path(__file__).resolve().parent.parent
SEMILLA = Path(sys.argv[1]) if len(sys.argv) > 1 else RAIZ.parent / "publico"
SEMILLA_ORIGEN = SEMILLA
SEMILLA = Path(tempfile.mkdtemp(prefix="semilla_tcg_"))
shutil.copy(SEMILLA_ORIGEN / "credencial.html", SEMILLA / "credencial.html")
(SEMILLA / "data").mkdir()
_d = json.loads((SEMILLA_ORIGEN / "data/certificados.json").read_text(encoding="utf-8"))
for _r in _d:
    _r["estado"] = "vigente"
    _r.pop("fecha_revocacion", None)
    if _r["codigo"][-3:] in ("001", "002", "003", "004", "005"):
        _r["fecha_emision"] = "2020-03-05"
(SEMILLA / "data/certificados.json").write_text(json.dumps(_d, ensure_ascii=False, indent=2), encoding="utf-8")
PASS = "clave-de-prueba-" + secrets.token_hex(3)
TOKEN = "ghp_token_secreto_" + secrets.token_hex(6)
SESSION = secrets.token_hex(16)
PUERTO_GH, PUERTO = 4010, 3100
BASE = f"http://127.0.0.1:{PUERTO}"
GH = f"http://127.0.0.1:{PUERTO_GH}"
BASE_URL = "https://tcg-certificados.vercel.app"
fallos = []


def check(nombre, cond, extra=""):
    print(("OK    " if cond else "FALLA ") + nombre + (f"  [{extra}]" if extra else ""))
    if not cond:
        fallos.append(nombre)


def http(url, metodo="GET", cuerpo=None, headers=None):
    req = urllib.request.Request(url, data=cuerpo, method=metodo, headers=headers or {})
    t = time.time()
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read(), time.time() - t, r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), time.time() - t, e.headers


def gh_archivo(ruta):
    s, b, _, _ = http(f"{GH}/_test/archivo?path={ruta}")
    return b if s == 200 else None


def gh_lista():
    return json.loads(http(f"{GH}/_test/lista")[1])


def gh_log():
    return json.loads(http(f"{GH}/_test/log")[1])


def registros():
    return json.loads(gh_archivo("publico/data/certificados.json"))


def accion_menu(pg_, tipo, item, codigo=None):
    """Abre el menú 'Descargar ▾' (tipo='descargar') o '⋯' (tipo='mas') de una fila y pulsa un ítem."""
    fila = pg_.locator(f'#tbody tr[data-codigo="{codigo}"]') if codigo else pg_.locator("#tbody tr").first
    if tipo == "descargar":
        fila.locator("button", has_text="Descargar").click()
    else:
        fila.locator('button[aria-label="Más acciones"]').click()
    pg_.locator("#menu-global button", has_text=item).click()


def firmar_token(inicio_ms, vence_ms, secreto=None):
    cuerpo = f"{inicio_ms}.{vence_ms}"
    firma = hmac.new((secreto or SESSION).encode(), cuerpo.encode(), hashlib.sha256).digest()
    return cuerpo + "." + base64.urlsafe_b64encode(firma).decode().rstrip("=")


def decodificar_qr(img_bgr):
    d = cv2.QRCodeDetectorAruco()
    t = d.detectAndDecode(img_bgr)[0]
    return t or cv2.QRCodeDetector().detectAndDecode(img_bgr)[0]


env = {**os.environ, "GH_TOKEN": TOKEN, "SEMILLA": str(SEMILLA), "PUERTO": str(PUERTO_GH),
       "ADMIN_PASSWORD": PASS, "SESSION_SECRET": SESSION, "GITHUB_TOKEN": TOKEN,
       "GITHUB_REPO": "LesJNS/tcg-certificados", "GITHUB_API_URL": GH, "BASE_URL": BASE_URL}
procs = [subprocess.Popen(["node", str(RAIZ / "dev/github_falso.js")], env=env, stdout=subprocess.DEVNULL),
         subprocess.Popen(["node", str(RAIZ / "dev/servidor.js"), str(PUERTO)], env=env, stdout=subprocess.DEVNULL)]
try:
    for _ in range(50):
        try:
            http(f"{BASE}/"); http(f"{GH}/_test/lista"); break
        except Exception:
            time.sleep(0.2)

    # ---------------- seguridad de la API ----------------
    print("== Seguridad ==")
    check("GET /api/estado sin sesión -> 401", http(f"{BASE}/api/estado")[0] == 401)
    check("POST /api/blob sin sesión -> 401", http(f"{BASE}/api/blob", "POST", b"x", {"Content-Type": "application/octet-stream"})[0] == 401)
    check("POST /api/publicar sin sesión -> 401", http(f"{BASE}/api/publicar", "POST", b"{}", {"Content-Type": "application/json"})[0] == 401)
    check("POST /api/estado-cert sin sesión -> 401", http(f"{BASE}/api/estado-cert", "POST", b"{}", {"Content-Type": "application/json"})[0] == 401)
    check("POST /api/editar sin sesión -> 401", http(f"{BASE}/api/editar", "POST", b"{}", {"Content-Type": "application/json"})[0] == 401)
    s, _, dt, _ = http(f"{BASE}/api/login", "POST", json.dumps({"password": "mala"}).encode(), {"Content-Type": "application/json"})
    check("login con contraseña mala -> 401 y con retardo", s == 401 and dt >= 0.7, f"{dt:.2f}s")
    check("login con Origin ajeno -> 403", http(f"{BASE}/api/login", "POST", json.dumps({"password": PASS}).encode(), {"Content-Type": "application/json", "Origin": "http://evil.com"})[0] == 403)
    check("login con text/plain -> 415", http(f"{BASE}/api/login", "POST", b"{}", {"Content-Type": "text/plain"})[0] == 415)
    s, cuerpo_login, _, h = http(f"{BASE}/api/login", "POST", json.dumps({"password": PASS}).encode(), {"Content-Type": "application/json"})
    tok = json.loads(cuerpo_login).get("token", "")
    check("login correcto: devuelve un token y NO crea ninguna cookie (nada persiste al cerrar la pestaña)", s == 200 and tok.count(".") == 2 and not h.get("Set-Cookie"))
    AUTH = {"Authorization": f"Bearer {tok}"}
    s, _, _, h2 = http(f"{BASE}/api/estado", headers=AUTH)
    check("sesión válida accede a /api/estado", s == 200)
    renovado = h2.get("X-Sesion", "")
    check("cada respuesta entrega un token renovado (inactividad)", renovado.count(".") == 2 and renovado.split(".")[0] == tok.split(".")[0], renovado[:25])
    check("el token renovado también funciona", http(f"{BASE}/api/estado", headers={"Authorization": f"Bearer {renovado}"})[0] == 200)
    check("token manipulado -> 401", http(f"{BASE}/api/estado", headers={"Authorization": "Bearer " + tok[:-3] + ("aaa" if not tok.endswith("aaa") else "bbb")})[0] == 401)
    ahora = int(time.time() * 1000)
    H = 3600 * 1000
    check("token firmado válido (mi firma coincide con la del servidor)", http(f"{BASE}/api/estado", headers={"Authorization": "Bearer " + firmar_token(ahora - 1000, ahora + H)})[0] == 200)
    check("token vencido por inactividad -> 401", http(f"{BASE}/api/estado", headers={"Authorization": "Bearer " + firmar_token(ahora - 3 * H, ahora - 1000)})[0] == 401)
    check("token con más de 8 h desde el ingreso -> 401 aunque 'venza' después", http(f"{BASE}/api/estado", headers={"Authorization": "Bearer " + firmar_token(ahora - 9 * H, ahora + H)})[0] == 401)
    check("token firmado con otro secreto -> 401", http(f"{BASE}/api/estado", headers={"Authorization": "Bearer " + firmar_token(ahora - 1000, ahora + H, "otro-secreto-distinto-123")})[0] == 401)
    check("la cookie ya no sirve como credencial -> 401", http(f"{BASE}/api/estado", headers={"Cookie": "tcg_sesion=" + tok})[0] == 401)
    s, cuerpo, _, _ = http(f"{BASE}/api/estado", headers=AUTH)
    check("el token de GitHub y la contraseña no aparecen en las respuestas", TOKEN.encode() not in cuerpo and PASS.encode() not in cuerpo)
    todo = b"".join((RAIZ / "public" / f).read_bytes() for f in ("app.js", "index.html", "render.js", "png.js"))
    sc, _, _, hs = http(f"{BASE}/")
    csp = hs.get("Content-Security-Policy", "")
    check("la página sirve CSP restrictiva (sin unsafe-eval, sin scripts externos)", "script-src 'self'" in csp and "unsafe-eval" not in csp and "frame-ancestors 'none'" in csp)
    check("el token/contraseña no están en los archivos estáticos", TOKEN.encode() not in todo and PASS.encode() not in todo)
    J = {"Content-Type": "application/json", **AUTH}
    check("editar sin cambios -> 400", http(f"{BASE}/api/editar", "POST", json.dumps({"codigos": ["TCG-CI-2026-001"]}).encode(), J)[0] == 400)
    check("editar con código inválido -> 400", http(f"{BASE}/api/editar", "POST", json.dumps({"codigos": ["../x"], "empresa": "a"}).encode(), J)[0] == 400)
    check("POST /api/eliminar sin sesión -> 401", http(f"{BASE}/api/eliminar", "POST", b"{}", {"Content-Type": "application/json"})[0] == 401)
    check("eliminar con lista inválida -> 400", http(f"{BASE}/api/eliminar", "POST", json.dumps({"codigos": ["../x"]}).encode(), J)[0] == 400)
    check("eliminar lista vacía -> 400", http(f"{BASE}/api/eliminar", "POST", json.dumps({"codigos": []}).encode(), J)[0] == 400)
    check("eliminar código inexistente -> 404", http(f"{BASE}/api/eliminar", "POST", json.dumps({"codigos": ["TCG-CI-2026-999"]}).encode(), J)[0] == 404)
    check("editar código inexistente -> 404", http(f"{BASE}/api/editar", "POST", json.dumps({"codigos": ["TCG-CI-2026-999"], "empresa": "a"}).encode(), J)[0] == 404)
    s, c, _, _ = http(f"{BASE}/api/blob", "POST", b"", {"Content-Type": "application/octet-stream", **AUTH})
    check("blob vacío -> 400", s == 400)
    s, c, _, _ = http(f"{BASE}/api/publicar", "POST", json.dumps({"items": [{"registro": {"codigo": "../../x", "nombre": "a", "capacitacion": "a", "fechas": "a", "frase": "a"}, "png": "0" * 40, "jpg": "0" * 40, "pdf": "0" * 40}]}).encode(), {"Content-Type": "application/json", **AUTH})
    check("publicar con código malicioso -> 400", s == 400, c.decode()[:80])
    s, c, _, _ = http(f"{BASE}/api/blob", "POST", b"a" * 5_000_000, {"Content-Type": "application/octet-stream", **AUTH})
    check("blob > 4,4 MB -> 413", s == 413)

    # ---------------- panel en el navegador ----------------
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge")
        ctx = b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True, bypass_csp=True)  # Playwright evalúa texto: la CSP se prueba abajo
        pg = ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("dialog", lambda d: d.accept())

        print("== Login ==")
        pg.goto(BASE)
        pg.wait_for_selector("#login:not([hidden])")
        check("sin sesión se muestra el login y no el panel", pg.is_hidden("#app"))
        pg.fill("#l-pass", "incorrecta"); pg.click("#l-btn")
        pg.wait_for_function("document.getElementById('l-error').textContent.length > 0")
        check("contraseña incorrecta muestra error", "incorrecta" in pg.inner_text("#l-error").lower(), pg.inner_text("#l-error"))
        check("sigue sin mostrar el panel", pg.is_hidden("#app"))
        check("error: la tarjeta se sacude, el foco vuelve a la contraseña y el botón se reactiva",
              "sacudir" in (pg.get_attribute("#form-login", "class") or "") and pg.evaluate("document.activeElement.id") == "l-pass"
              and pg.is_enabled("#l-btn") and pg.inner_text("#l-btn").strip() == "Ingresar")
        check("el logo de Towers del login carga", pg.evaluate("document.querySelector('.marca-logo img').naturalWidth") > 0)
        centro = pg.evaluate("""() => { const p = document.querySelector('.login-marca').getBoundingClientRect(), l = document.querySelector('.marca-logo').getBoundingClientRect();
            return Math.abs((p.left + p.width / 2) - (l.left + l.width / 2)); }""")
        check("el logo de Towers está centrado horizontalmente en el panel de marca", centro < 2, f"desfase {centro:.1f}px")
        check("pantalla ancha: panel de marca y formulario a la vez", pg.is_visible(".login-marca") and pg.is_visible("#form-login"))
        pg.fill("#l-pass", "abc123")
        check("la contraseña empieza oculta", pg.get_attribute("#l-pass", "type") == "password" and pg.get_attribute("#l-ver", "aria-pressed") == "false")
        pg.click("#l-ver")
        check("el ojo muestra la contraseña (y lo anuncia)", pg.get_attribute("#l-pass", "type") == "text" and pg.get_attribute("#l-ver", "aria-pressed") == "true" and pg.get_attribute("#l-ver", "aria-label") == "Ocultar contraseña")
        pg.click("#l-ver")
        check("segundo clic la vuelve a ocultar", pg.get_attribute("#l-pass", "type") == "password")
        pg.evaluate("document.getElementById('l-pass').dispatchEvent(new KeyboardEvent('keydown', {key: 'a', modifierCapsLock: true}))")
        check("avisa cuando Bloq Mayús está activado", pg.is_visible("#l-caps"))
        pg.evaluate("document.getElementById('l-pass').dispatchEvent(new KeyboardEvent('keyup', {key: 'a', modifierCapsLock: false}))")
        check("el aviso de Bloq Mayús se quita al apagarlo", pg.is_hidden("#l-caps"))
        movil = b.new_context(viewport={"width": 390, "height": 760}, is_mobile=True, has_touch=True, bypass_csp=True)
        pm = movil.new_page(); pm.goto(BASE); pm.wait_for_selector("#login:not([hidden])")
        box = pm.locator("#l-btn").bounding_box()
        check("celular (390 px): sin desplazamiento horizontal y el botón se ve completo",
              pm.evaluate("document.documentElement.scrollWidth <= window.innerWidth") and box["x"] >= 0 and box["x"] + box["width"] <= 390 and box["y"] + box["height"] <= 760, str(box))
        check("celular: se muestra la franja de marca y el logo compacto", pm.is_visible(".login-marca") and pm.is_visible(".login-logo-movil"))
        movil.close()
        pg.click("#l-ver")   # se loguea con la contraseña visible para comprobar que Salir la vuelve a ocultar
        pg.fill("#l-pass", PASS); pg.click("#l-btn")
        pg.wait_for_selector("#app:not([hidden])")
        pg.wait_for_function("document.getElementById('f-codigo').value !== ''")
        check("panel cargado: 11 emitidos", pg.inner_text("#n-emitidos") == "(11)", pg.inner_text("#n-emitidos"))
        check("código sugerido = 012", pg.input_value("#f-codigo") == "TCG-CI-2026-012")
        pg.reload(); pg.wait_for_selector("#app:not([hidden])")
        check("la sesión persiste al recargar la misma pestaña", pg.is_visible("#app"))
        check("el navegador no guarda ninguna cookie", ctx.cookies() == [], str(ctx.cookies()))
        check("el token está en sessionStorage (se borra al cerrar la pestaña)", pg.evaluate("!!sessionStorage.getItem('tcg_sesion')") and pg.evaluate("!localStorage.getItem('tcg_sesion')"))
        otra = ctx.new_page()   # equivale a cerrar la pestaña y volver a abrir el sitio
        otra.goto(BASE)
        otra.wait_for_selector("#login:not([hidden])")
        check("una pestaña nueva NO hereda la sesión: pide contraseña", otra.is_hidden("#app") and otra.is_visible("#login"))
        otra.close()
        ahora_ms = int(time.time() * 1000)
        pg.evaluate("t => sessionStorage.setItem('tcg_sesion', t)", firmar_token(ahora_ms - 3 * 3600 * 1000, ahora_ms - 1000))
        pg.reload(); pg.wait_for_selector("#login:not([hidden])")
        check("con un token vencido (2 h sin uso) la pantalla vuelve al login", pg.is_hidden("#app") and not pg.evaluate("sessionStorage.getItem('tcg_sesion')"))
        pg.fill("#l-pass", PASS); pg.click("#l-btn")
        pg.wait_for_selector("#app:not([hidden])")

        print("== Emitir uno ==")
        pg.fill("#f-nombre", "Ricardo Adrian Francisco Rodriguez Gomez")
        pg.fill("#f-capacitacion", "DESARROLLO E IMPLEMENTACIÓN DEL MODELO DE CALIFICACIÓN INTERNA")
        pg.fill("#f-fechas", "Realizadas los días 5 y 20 de octubre de 2026.")
        pg.fill("#f-empresa", "Consorcio Andino S.A.")
        pg.fill("#f-area", "TI")
        pg.wait_for_timeout(500)
        ref = pg.evaluate("document.getElementById('canvas').toDataURL('image/png')")
        t0 = time.time()
        pg.wait_for_timeout(400)
        pg.click("#b-generar")
        pg.wait_for_function("/^Publicado:/.test(document.getElementById('aviso').textContent)", timeout=120000)
        print(f"      (emisión completa en {time.time() - t0:.1f}s)")
        lista = gh_lista()
        for rel in ("certs/TCG-CI-2026-012.png", "certs/TCG-CI-2026-012.jpg", "certs/TCG-CI-2026-012.pdf", "c/TCG-CI-2026-012.html"):
            check(f"commit incluye publico/{rel}", f"publico/{rel}" in lista)
        regs = registros()
        r12 = [r for r in regs if r["codigo"] == "TCG-CI-2026-012"][0]
        check("JSON: 12 registros, ordenados y nuevo vigente", len(regs) == 12 and [r["codigo"] for r in regs] == sorted(r["codigo"] for r in regs) and r12["estado"] == "vigente" and r12["area"] == "TI")
        check("JSON: emisor y 2 firmantes", r12["emisor"] == "Towers Consulting Group (TCG)" and [f["nombre"] for f in r12["firmantes"]] == ["Juan Carlos Torres Napa", "Ángela Carpio Zamudio"])
        check("un solo commit para el certificado", [l["message"] for l in gh_log()] == ["Emite TCG-CI-2026-012"], str(gh_log()))
        png = gh_archivo("publico/certs/TCG-CI-2026-012.png")
        jpg = gh_archivo("publico/certs/TCG-CI-2026-012.jpg")
        pdf = gh_archivo("publico/certs/TCG-CI-2026-012.pdf")
        print(f"      tamaños: PNG {len(png)/1e6:.2f} MB, JPG {len(jpg)/1e6:.2f} MB, PDF {len(pdf)/1e6:.2f} MB")
        check("cada archivo cabe bajo el límite de 4,5 MB de Vercel", max(len(png), len(jpg), len(pdf)) < 4_400_000)
        im = Image.open(io.BytesIO(png)); im.load()
        check("PNG válido 3200x1800", im.size == (3200, 1800) and im.mode == "RGB", f"{im.size} {im.mode}")
        refim = Image.open(io.BytesIO(__import__("base64").b64decode(ref.split(",")[1]))).convert("RGB")
        check("PNG propio idéntico píxel a píxel al canvas (sin pérdida)", np.array_equal(np.asarray(im), np.asarray(refim)))
        esperado = f"{BASE_URL}/c/TCG-CI-2026-012"
        bgr = cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)
        check("QR del PNG decodifica la URL correcta", decodificar_qr(bgr) == esperado, decodificar_qr(bgr))
        jim = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
        check("JPG 1600x900 con QR correcto", jim.shape[:2] == (900, 1600) and decodificar_qr(jim) == esperado, str(jim.shape))
        doc = pymupdf.open(stream=pdf, filetype="pdf")
        z = 2400 / doc[0].rect.width
        pix = doc[0].get_pixmap(matrix=pymupdf.Matrix(z, z), alpha=False)
        pim = cv2.cvtColor(np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n), cv2.COLOR_RGB2BGR)
        check("PDF de 1 página (33,87 x 19,05 cm) con QR correcto", doc.page_count == 1 and abs(doc[0].rect.width / 72 * 2.54 - 33.867) < 0.05 and decodificar_qr(pim) == esperado)
        html = gh_archivo("publico/c/TCG-CI-2026-012.html").decode()
        check("página /c/CODIGO con Open Graph (jpg) y cert-link", f'og:image" content="{BASE_URL}/certs/TCG-CI-2026-012.jpg"' in html and "cert-link" in html)
        sombra = pg.evaluate("document.getElementById('f-codigo').value")
        check("tras emitir sugiere 013 y limpia nombre", sombra == "TCG-CI-2026-013" and pg.input_value("#f-nombre") == "")

        print("== Revocar / reactivar ==")
        pg.click('[data-tab="emitidos"]')
        pg.fill("#buscar", "TCG-CI-2026-012")
        accion_menu(pg, "mas", "Revocar")
        pg.wait_for_function("document.querySelector('#tbody .badge').textContent === 'revocado'", timeout=60000)
        r = [x for x in registros() if x["codigo"] == "TCG-CI-2026-012"][0]
        check("revocar: JSON estado=revocado con fecha", r["estado"] == "revocado" and "fecha_revocacion" in r)
        check("revocar: un solo commit nuevo", gh_log()[-1]["message"] == "Revoca TCG-CI-2026-012" and len(gh_log()) == 2)
        accion_menu(pg, "mas", "Reactivar")
        pg.wait_for_function("document.querySelector('#tbody .badge').textContent === 'vigente'", timeout=60000)
        r = [x for x in registros() if x["codigo"] == "TCG-CI-2026-012"][0]
        check("reactivar: vigente y sin fecha_revocacion", r["estado"] == "vigente" and "fecha_revocacion" not in r)
        pg.fill("#buscar", "")

        print("== Importación masiva (3 filas, UN commit) ==")
        csv = Path(os.environ.get("TEMP", ".")) / "lote_prueba.csv"
        csv.write_text('nombre;capacitacion;fechas;empresa;area\n"Ana ""La Mejor"" Pérez";CURSO UNO;"Realizada el 2 de noviembre de 2026.";Minera Sur;Riesgos\nLuis Ñandú Quispe;CURSO UNO;Realizada el 2 de noviembre de 2026.;Minera Sur;TI\nSolo Nombre;;;;\nMaría Gómez;CURSO UNO;Realizada el 2 de noviembre de 2026.;;TI\n', encoding="utf-8")
        n_commits = len(gh_log())
        pg.click('[data-tab="masivo"]')
        pg.set_input_files("#csv-file", str(csv))
        pg.wait_for_function("document.querySelectorAll('#m-tbody tr').length === 4")
        pg.click("#b-masivo")
        pg.wait_for_function("document.getElementById('b-masivo').disabled === true && /publicados/.test(document.getElementById('toast').textContent)", timeout=180000)
        log = gh_log()
        check("lote: exactamente 1 commit para 3 certificados", len(log) == n_commits + 1 and log[-1]["message"] == "Emite 3 certificados", log[-1]["message"])
        regs = registros()
        check("lote: 15 registros, códigos 013-015 sin huecos, fila incompleta omitida", len(regs) == 15 and {"TCG-CI-2026-013", "TCG-CI-2026-014", "TCG-CI-2026-015"} <= {r["codigo"] for r in regs})
        r13 = [r for r in regs if r["codigo"] == "TCG-CI-2026-013"][0]
        check("lote: nombre con comillas/tildes/ñ intacto", r13["nombre"] == 'Ana "La Mejor" Pérez' and any(r["nombre"] == "Luis Ñandú Quispe" for r in regs))
        check("lote: columna empresa del CSV guardada", r13["empresa"] == "Minera Sur" and [r for r in regs if r["codigo"] == "TCG-CI-2026-015"][0]["empresa"] == "")
        html13 = gh_archivo("publico/c/TCG-CI-2026-013.html").decode()
        check("lote: comillas escapadas en el HTML (sin romper atributos)", 'content="Certificado TCG-CI-2026-013' in html13)

        check("tras el lote el código sugerido del formulario avanza a 016", pg.input_value("#f-codigo") == "TCG-CI-2026-016", pg.input_value("#f-codigo"))
        print("== Conflicto de commits (otro commit llega en medio) ==")
        http(f"{GH}/_test/conflicto")
        pg.click('[data-tab="emitir"]')
        pg.fill("#f-nombre", "Persona Concurrente"); pg.fill("#f-capacitacion", "CURSO"); pg.fill("#f-fechas", "Realizada el 3 de noviembre de 2026.")
        pg.wait_for_timeout(400)
        pg.click("#b-generar")
        pg.wait_for_function("/^Publicado:/.test(document.getElementById('aviso').textContent)", timeout=120000)
        regs = registros()
        check("conflicto: se reintenta y el certificado queda publicado", any(r["codigo"] == "TCG-CI-2026-016" for r in regs) and len(regs) == 16, str([l["message"] for l in gh_log()][-3:]))

        print("== Revocado + regenerar todos ==")
        pg.click('[data-tab="emitidos"]')
        pg.fill("#buscar", "TCG-CI-2026-015")
        accion_menu(pg, "mas", "Revocar")
        pg.wait_for_function("document.querySelector('#tbody .badge').textContent === 'revocado'", timeout=60000)
        antes = {r["codigo"]: (r["fecha_emision"], r["estado"]) for r in registros()}
        pg.click('[data-tab="ajustes"]')
        check("ajustes muestra BASE_URL y repo", BASE_URL in pg.inner_text("#c-base") and "LesJNS/tcg-certificados" in pg.inner_text("#c-repo"))
        nlog = len(gh_log())
        t0 = time.time()
        pg.click("#b-regenerar")
        pg.wait_for_function("/Listo/.test(document.getElementById('c-info').textContent)", timeout=600000)
        print(f"      (regeneración de 16 certificados en {time.time() - t0:.0f}s)")
        despues = {r["codigo"]: (r["fecha_emision"], r["estado"]) for r in registros()}
        check("regenerar: un solo commit para los 16", len(gh_log()) == nlog + 1 and gh_log()[-1]["message"] == "Regenera 16 certificados", gh_log()[-1]["message"])
        check("regenerar conserva fecha de emisión y estado (incl. revocado)", antes == despues and despues["TCG-CI-2026-015"][1] == "revocado")
        check("hay 16 x (png+jpg+pdf+html) publicados", sum(1 for f in gh_lista() if f.startswith("publico/certs/")) == 48 and sum(1 for f in gh_lista() if f.startswith("publico/c/")) == 16)

        print("== Empresa, edición, filtros y descargas ==")
        tmp = Path(tempfile.mkdtemp(prefix="descargas_tcg_"))

        def esperar_toast(patron, t=60000):
            pg.wait_for_function(f"/{patron}/i.test(document.getElementById('toast').textContent)", timeout=t)

        def descargar_con(accion, nombre):
            with pg.expect_download(timeout=240000) as d:
                accion()
            ruta = tmp / nombre
            d.value.save_as(ruta)
            return d.value.suggested_filename, ruta

        def qr_de_png(datos):
            return decodificar_qr(cv2.imdecode(np.frombuffer(datos, np.uint8), cv2.IMREAD_COLOR))

        def qr_de_pdf(datos, pagina=0):
            doc = pymupdf.open(stream=datos, filetype="pdf")
            z = 2400 / doc[pagina].rect.width
            pix = doc[pagina].get_pixmap(matrix=pymupdf.Matrix(z, z), alpha=False)
            return decodificar_qr(cv2.cvtColor(np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n), cv2.COLOR_RGB2BGR))

        pg.click('[data-tab="emitidos"]')
        pg.fill("#buscar", "")
        cab = pg.locator("#tab-emitidos thead th").all_inner_texts()
        check("columnas: Empresa justo a la derecha de Participante", cab[2:5] == ["Participante", "Empresa", "Área"], str(cab))
        r12 = [r for r in registros() if r["codigo"] == "TCG-CI-2026-012"][0]
        check("la empresa escrita al emitir quedó guardada (y se ve en la tabla)", r12["empresa"] == "Consorcio Andino S.A." and "Consorcio Andino S.A." in pg.inner_text("#tbody"))

        # -- editar un certificado ya emitido (no se imprime: no debe tocar imágenes)
        pg.fill("#buscar", "TCG-CI-2026-003")
        n_log, n_arch = len(gh_log()), len(gh_lista())
        pg.locator("#tbody tr button", has_text="Editar").click()
        pg.wait_for_selector("#dlg-editar[open]")
        check("el diálogo de edición abre con los datos actuales", pg.input_value("#e-empresa") == "" and pg.input_value("#e-area") == "TI")
        pg.fill("#e-empresa", "Minera Los Andes"); pg.fill("#e-area", "Riesgos")
        pg.click("#e-guardar")
        esperar_toast(r"actualizados \(1\)")
        r3 = [r for r in registros() if r["codigo"] == "TCG-CI-2026-003"][0]
        check("editar: empresa y área actualizadas", r3["empresa"] == "Minera Los Andes" and r3["area"] == "Riesgos")
        check("editar: un solo commit, solo el JSON (sin archivos nuevos)", len(gh_log()) == n_log + 1 and gh_log()[-1]["message"] == "Actualiza empresa/área de TCG-CI-2026-003" and len(gh_lista()) == n_arch, gh_log()[-1]["message"])

        # -- filtro por rango de fechas de emisión
        pg.fill("#buscar", "")
        pg.fill("#f-desde", "2020-01-01"); pg.fill("#f-hasta", "2020-12-31")
        check("filtro por fechas: solo los 5 emitidos en 2020", pg.locator("#tbody tr").count() == 5 and "2020-03-05" in pg.inner_text("#tbody"))
        check("sin selección se anuncia que se descargan los 5 que se ven", "5 que se ven" in pg.inner_text("#sel-info"), pg.inner_text("#sel-info"))
        pg.fill("#f-desde", "2030-01-01"); pg.fill("#f-hasta", "")
        check("rango sin resultados: aviso y botón Descargar deshabilitado", pg.is_visible("#vacio") and pg.is_disabled("#b-descargar"))
        pg.fill("#f-desde", "2020-01-01"); pg.fill("#f-hasta", "2020-12-31")

        # -- asignar empresa a varios a la vez (solo cambia lo que se llena)
        pg.check("#chk-todos")
        check("casilla general selecciona los 5 visibles", "5 seleccionado" in pg.inner_text("#sel-info") and pg.locator("#tbody tr.sel").count() == 5)
        n_log = len(gh_log())
        pg.click("#b-asignar")
        pg.wait_for_selector("#dlg-editar[open]")
        pg.fill("#e-empresa", "Grupo Norte")   # el área se deja vacía: no debe cambiar
        pg.click("#e-guardar")
        esperar_toast(r"actualizados \(5\)")
        regs = {r["codigo"]: r for r in registros()}
        grupo = [regs[f"TCG-CI-2026-00{i}"] for i in range(1, 6)]
        check("asignar a 5: todos con empresa, un solo commit", all(r["empresa"] == "Grupo Norte" for r in grupo) and len(gh_log()) == n_log + 1 and gh_log()[-1]["message"] == "Actualiza empresa/área de 5 certificados", gh_log()[-1]["message"])
        check("asignar a varios no pisa el área que se dejó vacía", regs["TCG-CI-2026-003"]["area"] == "Riesgos" and regs["TCG-CI-2026-001"]["area"] == "TI")
        check("los demás certificados no cambian de empresa", regs["TCG-CI-2026-012"]["empresa"] == "Consorcio Andino S.A." and regs["TCG-CI-2026-010"].get("empresa", "") == "")

        # -- descarga directa de uno
        pg.uncheck("#chk-todos")
        pg.fill("#buscar", "TCG-CI-2026-001")
        nom, ruta = descargar_con(lambda: accion_menu(pg, "descargar", "PNG"), "uno.png")
        datos = ruta.read_bytes()
        im = Image.open(io.BytesIO(datos)); im.load()
        check("descarga directa PNG: nombre, tamaño 3200x1800 y QR de ese certificado", nom == "TCG-CI-2026-001.png" and im.size == (3200, 1800) and qr_de_png(datos) == f"{BASE_URL}/c/TCG-CI-2026-001", nom)
        nom, ruta = descargar_con(lambda: accion_menu(pg, "descargar", "PDF"), "uno.pdf")
        datos = ruta.read_bytes()
        check("descarga directa PDF: 1 página y QR de ese certificado", nom == "TCG-CI-2026-001.pdf" and pymupdf.open(stream=datos, filetype="pdf").page_count == 1 and qr_de_pdf(datos) == f"{BASE_URL}/c/TCG-CI-2026-001", nom)

        # -- descarga por rango de fechas
        pg.fill("#buscar", "")
        pg.select_option("#d-formato", "zip-png")
        nom, ruta = descargar_con(lambda: pg.click("#b-descargar"), "rango_png.zip")
        z = zipfile.ZipFile(ruta)
        esperados = [f"TCG-CI-2026-00{i}.png" for i in range(1, 6)]
        check("rango -> ZIP de PNG: nombre con fechas y los 5 archivos", nom == "Certificados_TCG_2020-01-01_a_2020-12-31_PNG.zip" and sorted(z.namelist()) == esperados, f"{nom} {z.namelist()}")
        check("cada PNG del ZIP tiene el QR de su propio certificado", all(qr_de_png(z.read(n)) == f"{BASE_URL}/c/{n[:-4]}" for n in esperados))
        pg.select_option("#d-formato", "zip-pdf")
        nom, ruta = descargar_con(lambda: pg.click("#b-descargar"), "rango_pdf.zip")
        z = zipfile.ZipFile(ruta)
        check("rango -> ZIP de PDF individuales con su QR", sorted(z.namelist()) == [n[:-4] + ".pdf" for n in esperados] and all(qr_de_pdf(z.read(n)) == f"{BASE_URL}/c/{n[:-4]}" for n in z.namelist()), nom)
        pg.select_option("#d-formato", "pdf1")
        nom, ruta = descargar_con(lambda: pg.click("#b-descargar"), "rango.pdf")
        check("rango -> PDF único de 5 páginas", nom == "Certificados_TCG_2020-01-01_a_2020-12-31.pdf" and pymupdf.open(ruta).page_count == 5, nom)

        # -- descarga de una selección puntual
        pg.fill("#f-desde", ""); pg.fill("#f-hasta", "")
        for c in ("TCG-CI-2026-002", "TCG-CI-2026-007", "TCG-CI-2026-012"):
            pg.check(f'#tbody tr[data-codigo="{c}"] input[type=checkbox]')
        check("selección puntual de 3", "3 seleccionado" in pg.inner_text("#sel-info"))
        nom, ruta = descargar_con(lambda: pg.click("#b-descargar"), "seleccion.pdf")
        doc = pymupdf.open(ruta)
        check("selección -> PDF único con exactamente esas 3 páginas", nom == "Certificados_TCG_seleccion.pdf" and doc.page_count == 3 and [qr_de_pdf(ruta.read_bytes(), i) for i in range(3)] == [f"{BASE_URL}/c/{c}" for c in ("TCG-CI-2026-002", "TCG-CI-2026-007", "TCG-CI-2026-012")], nom)

        # -- los revocados no entran en descargas masivas
        for c in ("TCG-CI-2026-002", "TCG-CI-2026-007", "TCG-CI-2026-012"):
            pg.uncheck(f'#tbody tr[data-codigo="{c}"] input[type=checkbox]')
        pg.check("#chk-todos")
        check("todos seleccionados: avisa que el revocado no se incluye", "1 revocado" in pg.inner_text("#sel-info") and "16 seleccionado" in pg.inner_text("#sel-info"), pg.inner_text("#sel-info"))
        pg.select_option("#d-formato", "pdf1")
        nom, ruta = descargar_con(lambda: pg.click("#b-descargar"), "todos.pdf")
        vig = sum(1 for r in registros() if r["estado"] == "vigente")
        check("PDF único de todo: una página por certificado vigente (el revocado no sale)", pymupdf.open(ruta).page_count == vig == 15, f"{pymupdf.open(ruta).page_count} págs, {ruta.stat().st_size / 1e6:.1f} MB")
        shutil.rmtree(tmp, ignore_errors=True)

        print("== Lista mejorada: alineación, filtros, orden, menús y previsualización ==")
        pg.fill("#buscar", "")
        for i in ("#f-desde", "#f-hasta"):
            pg.fill(i, "")
        pg.select_option("#f-emp", ""); pg.select_option("#f-est", "")
        if pg.is_checked("#chk-todos"):
            pg.uncheck("#chk-todos")
        pg.wait_for_selector("#tbody tr")

        # -- la tabla mantiene su estructura (antes las celdas de acciones rompían las líneas de las filas)
        displays = pg.evaluate("[...document.querySelectorAll('#tbody tr')].map(tr => [...tr.children].map(td => getComputedStyle(td).display))")
        check("todas las celdas son celdas de tabla (las líneas de las filas ya no se rompen)", all(d == "table-cell" for fila in displays for d in fila))
        desfase = pg.evaluate("""() => {
            const tr = document.querySelector('#tbody tr'), nombre = tr.children[3], acc = tr.querySelector('.acc-flex');
            const c = (e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; };
            return Math.abs(c(nombre) - c(acc));
        }""")
        check("el texto y los botones de la fila están alineados al centro", desfase < 4, f"{desfase:.1f}px")
        vig = sum(1 for r in registros() if r["estado"] == "vigente"); tot = len(registros())
        check("resumen: totales, vigentes y revocados", pg.inner_text("#resumen").startswith(f"{tot} certificado(s) · {vig} vigente(s) · {tot - vig} revocado(s)"), pg.inner_text("#resumen"))
        check("cada fila tiene solo 4 acciones (Previsualizar, Descargar, Editar, ⋯)", pg.locator("#tbody tr").first.locator("button").count() == 4)

        # -- filtros por empresa y por estado
        opciones = pg.locator("#f-emp option").all_inner_texts()
        check("el filtro de empresa lista las empresas que existen", {"Todas", "(Sin empresa)", "Grupo Norte", "Consorcio Andino S.A."} <= set(opciones), str(opciones))
        pg.select_option("#f-emp", "Grupo Norte")
        esperado = sum(1 for r in registros() if r.get("empresa") == "Grupo Norte")
        check("filtrar por empresa", pg.locator("#tbody tr").count() == esperado == 5 and "mostrando 5" in pg.inner_text("#resumen"), pg.inner_text("#resumen"))
        pg.select_option("#f-emp", "__sin__")
        sin = sum(1 for r in registros() if not r.get("empresa"))
        check("filtrar por '(Sin empresa)'", pg.locator("#tbody tr").count() == sin > 0, str(sin))
        pg.select_option("#f-emp", "")
        pg.select_option("#f-est", "revocado")
        check("filtrar por estado revocado", pg.locator("#tbody tr").count() == 1 and "revocado" in pg.inner_text("#tbody"))
        check("el revocado ofrece 'Reactivar' (no 'Revocar') en su menú", (pg.locator('#tbody tr button[aria-label="Más acciones"]').click() or True) and pg.locator("#menu-global button", has_text="Reactivar").count() == 1 and pg.locator("#menu-global button", has_text="Revocar").count() == 0)
        pg.keyboard.press("Escape")
        pg.select_option("#f-est", "vigente")
        check("filtrar por estado vigente", pg.locator("#tbody tr").count() == vig)
        pg.click("#b-limpiar")
        check("'Limpiar filtros' restablece todo", pg.locator("#tbody tr").count() == tot and pg.input_value("#f-emp") == "" and pg.input_value("#f-est") == "")

        # -- orden por columnas
        nombres = lambda: pg.locator("#tbody tr td:nth-child(3)").all_inner_texts()
        pg.click('th[data-orden="nombre"]')
        asc = nombres()
        check("ordenar por Participante A→Z", asc == sorted(asc, key=lambda x: x.lower()) and pg.get_attribute('th[data-orden="nombre"]', "aria-sort") == "ascending", asc[0])
        pg.click('th[data-orden="nombre"]')
        check("segundo clic: Z→A", nombres() == asc[::-1] and pg.get_attribute('th[data-orden="nombre"]', "aria-sort") == "descending")
        pg.click('th[data-orden="codigo"]')
        check("volver a ordenar por Código", pg.locator("#tbody tr td:nth-child(2)").first.inner_text() == min(r["codigo"] for r in registros()))

        # -- menús flotantes
        pg.fill("#buscar", "TCG-CI-2026-002")
        pg.locator("#tbody tr").first.locator("button", has_text="Descargar").click()
        check("el menú Descargar muestra PNG y PDF", pg.locator("#menu-global").is_visible() and pg.locator("#menu-global button").count() == 2)
        pg.mouse.click(700, 120)   # clic fuera
        check("clic fuera cierra el menú", pg.locator("#menu-global").is_hidden())
        pg.locator("#tbody tr").first.locator('button[aria-label="Más acciones"]').click()
        check("el menú ⋯ ofrece página pública, revocar y eliminar", [t.strip() for t in pg.locator("#menu-global button").all_inner_texts()] == ["Abrir página pública", "Revocar", "Eliminar…"])
        pg.keyboard.press("Escape")
        check("Escape cierra el menú", pg.locator("#menu-global").is_hidden())
        pg.fill("#buscar", "")

        # -- previsualizar
        pg.locator('#tbody tr[data-codigo="TCG-CI-2026-002"] button', has_text="Previsualizar").click()
        pg.wait_for_selector("#dlg-ver[open]")
        pg.wait_for_timeout(500)
        check("previsualizar: título, estado y posición", pg.inner_text("#v-codigo") == "TCG-CI-2026-002" and pg.inner_text("#v-estado") == "vigente" and re.match(r"^2 de \d+$", pg.inner_text("#v-pos").strip()) is not None, pg.inner_text("#v-pos"))
        check("previsualizar: muestra los datos del registro", "Rodriguez Gomez" in pg.inner_text("#v-nombre") and "CALIFICACIÓN" in pg.inner_text("#v-capacitacion") and pg.inner_text("#v-area") == "TI" and "Grupo Norte" in pg.inner_text("#v-empresa"))
        dim = pg.evaluate("[document.getElementById('v-canvas').width, document.getElementById('v-canvas').height]")
        du = pg.evaluate("document.getElementById('v-canvas').toDataURL('image/png')")
        qr = decodificar_qr(cv2.imdecode(np.frombuffer(base64.b64decode(du.split(",")[1]), np.uint8), cv2.IMREAD_COLOR))
        check("previsualizar: certificado 3200x1800 con el QR de ese código", dim == [3200, 1800] and qr == f"{BASE_URL}/c/TCG-CI-2026-002", f"{dim} {qr}")
        check("previsualizar: enlace a la página pública", pg.get_attribute("#v-pagina", "href") == f"{BASE_URL}/c/TCG-CI-2026-002")
        pg.keyboard.press("ArrowRight")
        check("flecha → pasa al siguiente certificado", pg.inner_text("#v-codigo") == "TCG-CI-2026-003" and pg.inner_text("#v-nombre") == "Roy Roger Rios Nuñez")
        pg.keyboard.press("ArrowLeft"); pg.keyboard.press("ArrowLeft")
        check("flecha ← pasa al anterior; en el primero 'Anterior' se deshabilita", pg.inner_text("#v-codigo") == "TCG-CI-2026-001" and pg.is_disabled("#v-ant") and pg.is_enabled("#v-sig"))
        nom, ruta = descargar_con(lambda: pg.click("#v-png"), "desde_vista.png")
        check("descargar PNG desde la previsualización", nom == "TCG-CI-2026-001.png" and Image.open(ruta).size == (3200, 1800), nom)
        pg.keyboard.press("Escape")
        check("Escape cierra la previsualización", not pg.evaluate("document.getElementById('dlg-ver').open"))
        pg.locator('#tbody tr[data-codigo="TCG-CI-2026-002"] button', has_text="Previsualizar").click()
        pg.wait_for_selector("#dlg-ver[open]")
        pg.mouse.click(4, 4)   # clic en el fondo oscuro
        check("clic fuera de la ventana la cierra", not pg.evaluate("document.getElementById('dlg-ver').open"))
        pg.select_option("#f-est", "revocado")
        pg.locator("#tbody tr button", has_text="Previsualizar").click()
        pg.wait_for_selector("#dlg-ver[open]")
        check("previsualizar un revocado: marca 'revocado' y es 1 de 1 (sin navegación)", pg.inner_text("#v-estado") == "revocado" and pg.inner_text("#v-pos").strip() == "1 de 1" and pg.is_disabled("#v-ant") and pg.is_disabled("#v-sig"))
        pg.keyboard.press("Escape")
        pg.click("#b-limpiar")

        print("== Eliminar ==")
        for i in ("#f-desde", "#f-hasta", "#buscar"):
            pg.fill(i, "")
        pg.uncheck("#chk-todos")
        check("sin selección, el botón masivo 'Eliminar…' está deshabilitado", pg.is_disabled("#b-eliminar"))

        # -- uno por la fila: pide escribir ELIMINAR; cancelar no borra
        pg.fill("#buscar", "TCG-CI-2026-016")
        accion_menu(pg, "mas", "Eliminar")
        pg.wait_for_selector("#dlg-eliminar[open]")
        check("diálogo: título y botón de confirmar deshabilitado al abrir", "TCG-CI-2026-016" in pg.inner_text("#x-titulo") and pg.is_disabled("#x-ok"))
        pg.fill("#x-confirmar", "eliminar")
        check("'eliminar' en minúsculas no habilita el botón", pg.is_disabled("#x-ok"))
        pg.click("#x-cancelar")
        check("cancelar no borra nada", any(r["codigo"] == "TCG-CI-2026-016" for r in registros()))
        n_log = len(gh_log())
        accion_menu(pg, "mas", "Eliminar")
        pg.wait_for_selector("#dlg-eliminar[open]")
        pg.fill("#x-confirmar", "ELIMINAR")
        check("escribir ELIMINAR habilita el botón", pg.is_enabled("#x-ok"))
        pg.click("#x-ok")
        pg.wait_for_function("/1 certificado\\(s\\) eliminado/i.test(document.getElementById('toast').textContent)", timeout=60000)
        regs = registros()
        check("eliminar uno: un solo commit y sale del JSON", len(gh_log()) == n_log + 1 and gh_log()[-1]["message"] == "Elimina TCG-CI-2026-016" and len(regs) == 15 and not any(r["codigo"] == "TCG-CI-2026-016" for r in regs), gh_log()[-1]["message"])
        lista = gh_lista()
        check("eliminar uno: borró PNG, JPG, PDF y la página; los demás siguen",
              not any("TCG-CI-2026-016" in f for f in lista) and "publico/certs/TCG-CI-2026-012.png" in lista and "publico/c/TCG-CI-2026-012.html" in lista)
        check("el código eliminado queda registrado (data/eliminados.json)", json.loads(gh_archivo("publico/data/eliminados.json")) == ["TCG-CI-2026-016"])
        sig = json.loads(http(f"{BASE}/api/estado", headers=AUTH)[1])["siguienteCodigo"]
        check("el código eliminado NO se vuelve a sugerir (017, no 016)", sig == "TCG-CI-2026-017", sig)
        cuerpo = json.dumps({"items": [{"registro": {"codigo": "TCG-CI-2026-016", "nombre": "x", "capacitacion": "x", "fechas": "x", "frase": "x"}, "png": "0" * 40, "jpg": "0" * 40, "pdf": "0" * 40}]}).encode()
        st, resp, _, _ = http(f"{BASE}/api/publicar", "POST", cuerpo, J)
        check("emitir con un código eliminado -> 409", st == 409 and "eliminado" in resp.decode(), resp.decode()[:90])

        # -- varios a la vez, incluyendo un revocado (015) y uno sin archivos en el repo (005)
        pg.fill("#buscar", "")
        codigos = ["TCG-CI-2026-005", "TCG-CI-2026-013", "TCG-CI-2026-014", "TCG-CI-2026-015"]
        for c in codigos:
            pg.check(f'#tbody tr[data-codigo="{c}"] input[type=checkbox]')
        check("el botón 'Eliminar…' se habilita con selección", pg.is_enabled("#b-eliminar"))
        n_log = len(gh_log())
        pg.click("#b-eliminar")
        pg.wait_for_selector("#dlg-eliminar[open]")
        check("diálogo masivo: lista los 4 y marca el revocado", "4 certificados" in pg.inner_text("#x-titulo") and "(revocado)" in pg.inner_text("#x-lista") and all(c in pg.inner_text("#x-lista") for c in codigos))
        pg.fill("#x-confirmar", "ELIMINAR"); pg.click("#x-ok")
        pg.wait_for_function("/4 certificado\\(s\\) eliminado/i.test(document.getElementById('toast').textContent)", timeout=60000)
        regs = registros()
        check("eliminar varios: un solo commit para los 4", len(gh_log()) == n_log + 1 and gh_log()[-1]["message"] == "Elimina 4 certificados" and len(regs) == 11, gh_log()[-1]["message"])
        lista = gh_lista()
        check("eliminar varios: no queda ningún archivo de esos 4 (aunque 005 no tenía archivos)", not any(c in f for f in lista for c in codigos))
        check("eliminados.json acumula los códigos", json.loads(gh_archivo("publico/data/eliminados.json")) == sorted(["TCG-CI-2026-016"] + codigos))
        check("la selección se limpia tras eliminar", pg.is_disabled("#b-eliminar") and "Sin selección" in pg.inner_text("#sel-info"))
        check("los eliminados ya no aparecen en la tabla", not any(c in pg.inner_text("#tbody") for c in codigos))
        sig = json.loads(http(f"{BASE}/api/estado", headers=AUTH)[1])["siguienteCodigo"]
        check("siguiente código sigue siendo 017 (nunca se reutilizan)", sig == "TCG-CI-2026-017", sig)

        print("== Salir ==")
        pg.click("#b-salir")
        pg.wait_for_selector("#login:not([hidden])")
        check("salir vuelve al login", pg.is_hidden("#app"))
        check("tras salir la contraseña vuelve a estar oculta y el campo vacío", pg.get_attribute("#l-pass", "type") == "password" and pg.input_value("#l-pass") == "")
        check("tras salir el token se borra y /api/estado devuelve 401", pg.evaluate("sessionStorage.getItem('tcg_sesion')") is None and pg.evaluate("fetch('/api/estado').then(r => r.status)") == 401)
        check("al salir no quedan datos de certificados en pantalla", pg.inner_text("#tbody").strip() == "" and pg.input_value("#f-nombre") == "")
        pg.reload(); pg.wait_for_selector("#login:not([hidden])")
        check("recargar después de salir sigue pidiendo contraseña", pg.is_hidden("#app"))
        check("sin errores de JavaScript", not errs, "; ".join(errs))

        print("== CSP real (otro navegador SIN bypass: todo el panel debe funcionar bajo la política) ==")
        ctx2 = b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
        p2 = ctx2.new_page()
        viol, errs2 = [], []
        p2.on("console", lambda m: viol.append(m.text) if "Content Security Policy" in m.text or "Content-Security-Policy" in m.text else None)
        p2.on("pageerror", lambda e: errs2.append(str(e)))
        p2.on("dialog", lambda d: d.accept())
        p2.goto(BASE)
        p2.wait_for_selector("#login:not([hidden])")
        p2.fill("#l-pass", PASS); p2.click("#l-btn")
        p2.wait_for_selector("#app:not([hidden])")
        p2.locator("#tab-emitir").wait_for()
        p2.fill("#f-nombre", "Prueba Bajo CSP"); p2.fill("#f-capacitacion", "CURSO CSP"); p2.fill("#f-fechas", "Realizada el 4 de noviembre de 2026.")
        p2.click("#b-generar")
        p2.locator("#aviso", has_text="Publicado:").wait_for(timeout=120000)
        check("bajo CSP: se genera y publica un certificado (canvas, PNG propio, jsPDF, subida)", any(r["nombre"] == "Prueba Bajo CSP" for r in registros()))
        p2.click('[data-tab="emitidos"]')
        p2.fill("#buscar", "Prueba Bajo CSP")
        with p2.expect_download(timeout=120000) as d1:
            accion_menu(p2, "descargar", "PNG")
        with p2.expect_download(timeout=120000) as d2:
            accion_menu(p2, "descargar", "PDF")
        check("bajo CSP: descargas directas PNG y PDF", d1.value.suggested_filename.endswith(".png") and d2.value.suggested_filename.endswith(".pdf"))
        p2.fill("#buscar", "")
        p2.select_option("#d-formato", "zip-png")
        p2.locator("#tbody tr").first.locator("input[type=checkbox]").check()
        with p2.expect_download(timeout=120000) as d3:
            p2.click("#b-descargar")
        check("bajo CSP: ZIP (fflate) y selección", d3.value.suggested_filename.endswith("_PNG.zip"))
        p2.locator("#tbody tr", has_text="Prueba Bajo CSP").locator("input[type=checkbox]").check()
        p2.click("#b-asignar")
        p2.locator("#dlg-editar[open]").wait_for()
        p2.fill("#e-empresa", "Empresa CSP"); p2.click("#e-guardar")
        p2.locator("#toast", has_text="Datos actualizados").wait_for(timeout=60000)
        check("bajo CSP: diálogos y edición", any(r.get("empresa") == "Empresa CSP" for r in registros()))
        check("la política CSP no bloqueó nada del panel", not viol, "; ".join(viol)[:300])
        check("sin errores de JavaScript bajo CSP", not errs2, "; ".join(errs2)[:300])
        ctx2.close()
        b.close()
finally:
    for pr in procs:
        pr.terminate()

print("\nFALLOS:", len(fallos), fallos)
sys.exit(1 if fallos else 0)
