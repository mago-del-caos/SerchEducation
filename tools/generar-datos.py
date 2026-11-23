#!/usr/bin/env python3
"""Serch Education — generador del registro propio de escuelas.

Descarga de OpenStreetMap (Overpass API) TODAS las escuelas
(amenity=school y amenity=kindergarten, nodos y vías) dentro de
50 km del punto medio de los dos centros fijos de la app
(IJEM 19.4785,-99.2396 y Jardín de Niños IJEM 19.49411,-99.22223;
punto medio 19.4863, -99.2309) y escribe el dataset que la app
trae incluido: escuelas.json, en la raíz del proyecto.

La app YA NO depende de la consulta en vivo (Overpass devuelve
406 de forma intermitente según su carga): trabaja con este
registro y la revisión semanal lo refresca corriendo este script.

Estrategia de descarga:
1. Una consulta completa de 50 km, intentando los tres
   intérpretes Overpass conocidos, con reintentos y esperas.
2. Si la consulta grande falla, la zona se divide en una rejilla
   de celdas (~0.15°, unos 16 km) consultadas por bbox, una por
   una, con los mismos respaldos; se deduplica por tipo/id OSM.

Normalización: la MISMA heurística de la app (app.js) para nivel
y tipo; el registro de cada escuela es
{id, nombre, nivel, tipo, tipoTexto, lat, lng, website,
telefono, direccion} (los campos sin dato se omiten).

Si ni con la rejilla se completa la zona, se guarda lo obtenido
con "parcial": true en el propio JSON — un dataset parcial NUNCA
se presenta como completo.

Solo biblioteca estándar; no necesita tokens ni claves.

Uso:
    python3 tools/generar-datos.py
    python3 tools/generar-datos.py --salida /ruta/escuelas.json
    python3 tools/generar-datos.py --celda 0.12 --rondas-celda 5
"""
import argparse
import json
import math
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

PUNTO = (19.4863, -99.2309)   # punto medio IJEM <-> Jardín de Niños IJEM
RADIO_KM = 50
URLS_OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
USER_AGENT = "SerchEducation/1.0 (generador del registro de escuelas; datos OSM)"
SALIDA_DEFECTO = Path(__file__).resolve().parent.parent / "escuelas.json"


def log(*args):
    print(*args, file=sys.stderr, flush=True)


# ------------------------------------------------------------------
# Normalización (espejo fiel de app.js: clasificarNivel,
# clasificarTipo, direccionDe y normalizarEscuela)
# ------------------------------------------------------------------
def normalizar_txt(t):
    t = (t or "").lower()
    t = unicodedata.normalize("NFD", t)
    return "".join(c for c in t if not unicodedata.combining(c))


def nivel_desde_etiquetas_nivel(tags):
    crudo = tags.get("isced:level") or tags.get("school:level") or ""
    if not crudo:
        return None
    t = " " + normalizar_txt(crudo) + " "
    if re.search(r"jardin|kinder|preescolar|preprimary|preschool", t):
        return "Kinder"
    if re.search(r"primaria|primary", t) and not re.search(r"secundaria|preparatoria", t):
        return "Primaria"
    if re.search(r"preparatoria|bachillerato|high school|upper secondary", t):
        return "Preparatoria"
    if re.search(r"secundaria|secondary|middle", t):
        return "Secundaria"
    nums = set(re.findall(r"[0-3]", crudo))
    if len(nums) == 1:
        return {0: "Kinder", 1: "Primaria", 2: "Secundaria", 3: "Preparatoria"}[int(nums.pop())]
    return None


def clasificar_nivel(tags):
    """Heurística (igual que en app.js): amenity, isced:level /
    school:level y nombre en español. No es un dato oficial."""
    if tags.get("amenity") == "kindergarten":
        return "Kinder"
    por_etiqueta = nivel_desde_etiquetas_nivel(tags)
    if por_etiqueta:
        return por_etiqueta
    n = " " + normalizar_txt(tags.get("name") or "") + " "
    if re.search(r"jardin de ninos|jardin de infantes|kinder|preescolar|estancia infantil|cendi|caic|guarderia", n):
        return "Kinder"
    if re.search(r"preparatoria|bachillerato|bachilleres|cch|cbtis|cetis|conalep|cobach| prepa ", n):
        return "Preparatoria"
    if re.search(r"secundaria|telesecundaria", n):
        return "Secundaria"
    if re.search(r"primaria", n):
        return "Primaria"
    return "Nivel sin especificar"


def clasificar_tipo(tags):
    """(clave, texto) SOLO desde etiquetas públicas, como en app.js."""
    ot = normalizar_txt(tags.get("operator:type") or "")
    if ot == "public":
        return "gratuita", "Pública (gratuita)"
    if ot == "private":
        return "pago", "Particular (de pago)"
    fee = normalizar_txt(tags.get("fee") or "")
    if fee == "yes":
        return "pago", "De pago (etiqueta fee=yes)"
    if fee == "no":
        return "gratuita", "Gratuita (etiqueta fee=no)"
    return "sindato", "Tipo sin dato público"


def direccion_de(tags):
    partes = []
    if tags.get("addr:street"):
        partes.append(tags["addr:street"] + ((" " + tags["addr:housenumber"]) if tags.get("addr:housenumber") else ""))
    if tags.get("addr:suburb"):
        partes.append(tags["addr:suburb"])
    if tags.get("addr:city"):
        partes.append(tags["addr:city"])
    return ", ".join(partes) if partes else None


def normalizar_elemento(el):
    """Un elemento de Overpass -> registro del dataset (o None)."""
    tags = el.get("tags") or {}
    lat = el.get("lat")
    lng = el.get("lon")
    if lat is None and el.get("center"):
        lat = el["center"].get("lat")
        lng = el["center"].get("lon")
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        return None
    clave, texto = clasificar_tipo(tags)
    reg = {
        "id": f"{el['type']}/{el['id']}",
        "nombre": tags.get("name") or "Escuela sin nombre en OpenStreetMap",
        "nivel": clasificar_nivel(tags),
        "tipo": clave,
        "tipoTexto": texto,
        "lat": lat,
        "lng": lng,
    }
    website = tags.get("website") or tags.get("contact:website")
    if website:
        reg["website"] = website
    telefono = tags.get("phone") or tags.get("contact:phone")
    if telefono:
        reg["telefono"] = telefono
    direccion = direccion_de(tags)
    if direccion:
        reg["direccion"] = direccion
    return reg


def distancia_km(lat1, lng1, lat2, lng2):
    r = 6371.0
    rad = math.pi / 180
    dlat = (lat2 - lat1) * rad
    dlng = (lng2 - lng1) * rad
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin(dlng / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# ------------------------------------------------------------------
# Descarga con respaldos
# ------------------------------------------------------------------
def pedir(url, consulta, timeout_cliente):
    req = urllib.request.Request(
        url,
        data=urllib.parse.urlencode({"data": consulta}).encode("utf-8"),
        headers={
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_cliente) as r:
        return json.loads(r.read().decode("utf-8"))


def intentar(consulta, timeout_cliente, rondas, esperas, descripcion):
    """Recorre los intérpretes por rondas hasta que uno responda.
    Devuelve el JSON de Overpass o None si todos fallaron."""
    ultimo = None
    for ronda in range(rondas):
        for url in URLS_OVERPASS:
            try:
                data = pedir(url, consulta, timeout_cliente)
                log(f"  OK {descripcion} vía {url.split('/')[2]}")
                return data
            except Exception as e:  # este intérprete falló: al siguiente
                ultimo = e
                log(f"  fallo {descripcion} en {url.split('/')[2]}: {type(e).__name__} {str(e)[:80]}")
                time.sleep(3)
        if ronda < rondas - 1:
            espera = esperas[min(ronda, len(esperas) - 1)]
            log(f"  …espera de {espera}s antes de otra ronda por {descripcion}")
            time.sleep(espera)
    log(f"  SIN RESPUESTA {descripcion} (último error: {ultimo})")
    return None


def consulta_completa():
    m = int(RADIO_KM * 1000)
    return (
        "[out:json][timeout:180];\n"
        "(\n"
        f'  node["amenity"~"^(school|kindergarten)$"](around:{m},{PUNTO[0]},{PUNTO[1]});\n'
        f'  way["amenity"~"^(school|kindergarten)$"](around:{m},{PUNTO[0]},{PUNTO[1]});\n'
        ");\n"
        "out center tags;"
    )


def consulta_celda(s, w, n, e):
    return (
        "[out:json][timeout:90];\n"
        "(\n"
        f'  node["amenity"~"^(school|kindergarten)$"]({s},{w},{n},{e});\n'
        f'  way["amenity"~"^(school|kindergarten)$"]({s},{w},{n},{e});\n'
        ");\n"
        "out center tags;"
    )


def celdas_de_rejilla(tam):
    """Celdas bbox de `tam` grados que cubren el círculo de 50 km.
    Se saltan las que quedan enteramente fuera del círculo."""
    dlat = RADIO_KM / 111.32
    dlng = RADIO_KM / (111.32 * math.cos(math.radians(PUNTO[0])))
    lat0, lat1 = PUNTO[0] - dlat, PUNTO[0] + dlat
    lng0, lng1 = PUNTO[1] - dlng, PUNTO[1] + dlng
    celdas = []
    lat = lat0
    while lat < lat1 - 1e-9:
        lng = lng0
        while lng < lng1 - 1e-9:
            s, w = lat, lng
            n, e = min(lat + tam, lat1), min(lng + tam, lng1)
            # Punto de la celda más cercano al centro del círculo:
            clat = min(max(PUNTO[0], s), n)
            clng = min(max(PUNTO[1], w), e)
            if distancia_km(PUNTO[0], PUNTO[1], clat, clng) <= RADIO_KM:
                celdas.append((s, w, n, e))
            lng += tam
        lat += tam
    return celdas


def descargar():
    """Devuelve (elementos, parcial, detalle)."""
    log(f"1) Consulta completa de {RADIO_KM} km alrededor de {PUNTO}…")
    data = intentar(consulta_completa(), timeout_cliente=240, rondas=2,
                    esperas=[30], descripcion="consulta completa")
    if data is not None:
        return data.get("elements", []), False, "consulta completa"

    log("2) La consulta completa no respondió: se divide en rejilla…")
    celdas = celdas_de_rejilla(args.celda)
    log(f"   {len(celdas)} celdas por consultar")
    por_id = {}
    fallidas = 0
    for i, (s, w, n, e) in enumerate(celdas, 1):
        data = intentar(consulta_celda(s, w, n, e), timeout_cliente=120,
                        rondas=args.rondas_celda, esperas=[10, 30, 60],
                        descripcion=f"celda {i}/{len(celdas)}")
        if data is None:
            fallidas += 1
            continue
        for el in data.get("elements", []):
            por_id[f"{el['type']}/{el['id']}"] = el
        time.sleep(1)  # cortesía con el servicio público
    elementos = list(por_id.values())
    if fallidas:
        return elementos, True, f"rejilla: {fallidas} de {len(celdas)} celdas sin respuesta"
    return elementos, False, f"rejilla completa de {len(celdas)} celdas"


def main():
    global args
    ap = argparse.ArgumentParser(description="Genera escuelas.json, el registro propio de Serch Education")
    ap.add_argument("--salida", default=str(SALIDA_DEFECTO), help="Ruta del escuelas.json a escribir")
    ap.add_argument("--celda", type=float, default=0.15, help="Tamaño de celda de la rejilla, en grados")
    ap.add_argument("--rondas-celda", type=int, default=4, help="Rondas de intérpretes por celda")
    args = ap.parse_args()

    elementos, parcial, detalle = descargar()

    escuelas = {}
    for el in elementos:
        reg = normalizar_elemento(el)
        if reg is None:
            continue
        if distancia_km(PUNTO[0], PUNTO[1], reg["lat"], reg["lng"]) > RADIO_KM:
            continue  # la rejilla sobrecubre las esquinas: fuera del círculo no va
        escuelas[reg["id"]] = reg
    lista = [escuelas[k] for k in sorted(escuelas)]

    salida = {
        "generado": date.today().isoformat(),
        "total": len(lista),
        "escuelas": lista,
    }
    if parcial:
        salida["parcial"] = True
        salida["nota"] = (
            "Registro INCOMPLETO: " + detalle + ". Las zonas sin respuesta "
            "faltan en este archivo; hay que regenerarlo cuando Overpass responda."
        )
    ruta = Path(args.salida)
    ruta.write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tam = ruta.stat().st_size
    print(f"Dataset {'PARCIAL' if parcial else 'completo'} ({detalle}): "
          f"{len(lista)} escuelas, {tam} bytes -> {ruta}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
