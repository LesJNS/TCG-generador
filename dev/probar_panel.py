"""Prueba de extremo a extremo del panel, sin Vercel ni GitHub reales.

Arranca dev/github_falso.js (GitHub simulado, sembrado con ../publico) y dev/servidor.js, y recorre el
flujo completo en un navegador (Edge vía Playwright). Requiere: Node 20+, playwright, pillow, opencv-python, pymupdf.

    python dev/probar_panel.py
"""
import io
import json
import os
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
    s, _, dt, _ = http(f"{BASE}/api/login", "POST", json.dumps({"password": "mala"}).encode(), {"Content-Type": "application/json"})
    check("login con contraseña mala -> 401 y con retardo", s == 401 and dt >= 0.7, f"{dt:.2f}s")
    check("login con Origin ajeno -> 403", http(f"{BASE}/api/login", "POST", json.dumps({"password": PASS}).encode(), {"Content-Type": "application/json", "Origin": "http://evil.com"})[0] == 403)
    check("login con text/plain -> 415", http(f"{BASE}/api/login", "POST", b"{}", {"Content-Type": "text/plain"})[0] == 415)
    s, _, _, h = http(f"{BASE}/api/login", "POST", json.dumps({"password": PASS}).encode(), {"Content-Type": "application/json"})
    ck = h.get("Set-Cookie", "")
    check("login correcto: cookie HttpOnly + SameSite=Strict", s == 200 and "HttpOnly" in ck and "SameSite=Strict" in ck, ck.split(";")[0][:30] + "…")
    cookie = ck.split(";")[0]
    check("sesión válida accede a /api/estado", http(f"{BASE}/api/estado", headers={"Cookie": cookie})[0] == 200)
    manipulada = cookie[:-3] + ("aaa" if not cookie.endswith("aaa") else "bbb")
    check("cookie manipulada -> 401", http(f"{BASE}/api/estado", headers={"Cookie": manipulada})[0] == 401)
    vencida = f"tcg_sesion={int(time.time() * 1000) - 1000}.{'A' * 43}"
    check("cookie vencida/falsa -> 401", http(f"{BASE}/api/estado", headers={"Cookie": vencida})[0] == 401)
    s, cuerpo, _, _ = http(f"{BASE}/api/estado", headers={"Cookie": cookie})
    check("el token de GitHub y la contraseña no aparecen en las respuestas", TOKEN.encode() not in cuerpo and PASS.encode() not in cuerpo)
    todo = b"".join((RAIZ / "public" / f).read_bytes() for f in ("app.js", "index.html", "render.js", "png.js"))
    check("el token/contraseña no están en los archivos estáticos", TOKEN.encode() not in todo and PASS.encode() not in todo)
    s, c, _, _ = http(f"{BASE}/api/blob", "POST", b"", {"Content-Type": "application/octet-stream", "Cookie": cookie})
    check("blob vacío -> 400", s == 400)
    s, c, _, _ = http(f"{BASE}/api/publicar", "POST", json.dumps({"items": [{"registro": {"codigo": "../../x", "nombre": "a", "capacitacion": "a", "fechas": "a", "frase": "a"}, "png": "0" * 40, "jpg": "0" * 40, "pdf": "0" * 40}]}).encode(), {"Content-Type": "application/json", "Cookie": cookie})
    check("publicar con código malicioso -> 400", s == 400, c.decode()[:80])
    s, c, _, _ = http(f"{BASE}/api/blob", "POST", b"a" * 5_000_000, {"Content-Type": "application/octet-stream", "Cookie": cookie})
    check("blob > 4,4 MB -> 413", s == 413)

    # ---------------- panel en el navegador ----------------
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge")
        ctx = b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
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
        pg.fill("#l-pass", PASS); pg.click("#l-btn")
        pg.wait_for_selector("#app:not([hidden])")
        pg.wait_for_function("document.getElementById('f-codigo').value !== ''")
        check("panel cargado: 11 emitidos", pg.inner_text("#n-emitidos") == "(11)", pg.inner_text("#n-emitidos"))
        check("código sugerido = 012", pg.input_value("#f-codigo") == "TCG-CI-2026-012")
        pg.reload(); pg.wait_for_selector("#app:not([hidden])")
        check("la sesión persiste al recargar", pg.is_visible("#app"))

        print("== Emitir uno ==")
        pg.fill("#f-nombre", "Ricardo Adrian Francisco Rodriguez Gomez")
        pg.fill("#f-capacitacion", "DESARROLLO E IMPLEMENTACIÓN DEL MODELO DE CALIFICACIÓN INTERNA")
        pg.fill("#f-fechas", "Realizadas los días 5 y 20 de octubre de 2026.")
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
        pg.locator("#tbody tr button").first.click()
        pg.wait_for_function("document.querySelector('#tbody .badge').textContent === 'revocado'", timeout=60000)
        r = [x for x in registros() if x["codigo"] == "TCG-CI-2026-012"][0]
        check("revocar: JSON estado=revocado con fecha", r["estado"] == "revocado" and "fecha_revocacion" in r)
        check("revocar: un solo commit nuevo", gh_log()[-1]["message"] == "Revoca TCG-CI-2026-012" and len(gh_log()) == 2)
        pg.locator("#tbody tr button").first.click()
        pg.wait_for_function("document.querySelector('#tbody .badge').textContent === 'vigente'", timeout=60000)
        r = [x for x in registros() if x["codigo"] == "TCG-CI-2026-012"][0]
        check("reactivar: vigente y sin fecha_revocacion", r["estado"] == "vigente" and "fecha_revocacion" not in r)
        pg.fill("#buscar", "")

        print("== Importación masiva (3 filas, UN commit) ==")
        csv = Path(os.environ.get("TEMP", ".")) / "lote_prueba.csv"
        csv.write_text('nombre;capacitacion;fechas;area\n"Ana ""La Mejor"" Pérez";CURSO UNO;"Realizada el 2 de noviembre de 2026.";Riesgos\nLuis Ñandú Quispe;CURSO UNO;Realizada el 2 de noviembre de 2026.;TI\nSolo Nombre;;;\nMaría Gómez;CURSO UNO;Realizada el 2 de noviembre de 2026.;TI\n', encoding="utf-8")
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
        pg.locator("#tbody tr button").first.click()
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

        print("== PDF de impresión ==")
        pg.click('[data-tab="emitidos"]')
        with pg.expect_download(timeout=180000) as d:
            pg.evaluate("document.getElementById('b-impresion').click()")
        ruta = Path(os.environ.get("TEMP", ".")) / "impresion_prueba.pdf"
        d.value.save_as(ruta)
        vig = sum(1 for r in registros() if r["estado"] == "vigente")
        check("PDF de impresión: una página por certificado vigente", pymupdf.open(ruta).page_count == vig == 15, f"{pymupdf.open(ruta).page_count} págs, {ruta.stat().st_size/1e6:.1f} MB")

        print("== Salir ==")
        pg.click("#b-salir")
        pg.wait_for_selector("#login:not([hidden])")
        check("salir vuelve al login", pg.is_hidden("#app"))
        check("tras salir /api/estado devuelve 401", pg.evaluate("fetch('/api/estado').then(r => r.status)") == 401)
        check("sin errores de JavaScript", not errs, "; ".join(errs))
        b.close()
finally:
    for pr in procs:
        pr.terminate()

print("\nFALLOS:", len(fallos), fallos)
sys.exit(1 if fallos else 0)
