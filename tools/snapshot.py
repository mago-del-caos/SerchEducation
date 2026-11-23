#!/usr/bin/env python3
"""Serch Education — revisión semanal de escuelas (vigilante).

Consulta Overpass API (OpenStreetMap) alrededor del centro por
defecto del proyecto — el Instituto Juventud del Estado de México
(Naucalpan de Juárez, 19.4785, -99.2396) — en un radio de 10 km,
normaliza las escuelas (id OSM, nombre, nivel, tipo, sitio web,
teléfono) ordenadas por id, y compara contra la foto guardada en
tools/snapshot.json:

- Sin cambios: no imprime NADA y no gasta tokens (patrón vigilante).
- Con cambios: imprime solo las diferencias (altas, bajas y cambios
  de campo) y actualiza la foto.
- Primera corrida: guarda la foto inicial y lo dice en una línea.

Solo biblioteca estándar; no necesita tokens ni claves.

Uso:
    python3 tools/snapshot.py
    python3 tools/snapshot.py --desde-archivo respuesta-overpass.json
    python3 tools/snapshot.py --foto /ruta/foto.json   (para pruebas)
"""
import argparse
import json
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

CENTRO = (19.4785, -99.2396)   # Instituto Juventud del Estado de México
RADIO_KM = 10
# Intérpretes Overpass en orden de intento (los mismos respaldos que
# usa la app en app.js): si uno falla —red, HTTP no-OK o timeout— se
# pasa al siguiente; solo si TODOS fallan se propaga el error.
URLS_OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
FOTO_DEFECTO = Path(__file__).with_name("snapshot.json")


def consulta_overpass(lat, lng, radio_km):
    m = int(radio_km * 1000)
    return (
        "[out:json][timeout:30];\n"
        "(\n"
        f'  node["amenity"~"^(school|kindergarten)$"](around:{m},{lat},{lng});\n'
        f'  way["amenity"~"^(school|kindergarten)$"](around:{m},{lat},{lng});\n'
        ");\n"
        "out center tags;"
    )


def normalizar_txt(t):
    t = (t or "").lower()
    t = unicodedata.normalize("NFD", t)
    return "".join(c for c in t if not unicodedata.combining(c))


def clasificar_nivel(tags):
    """Heurística (igual que en app.js): amenity, isced:level /
    school:level y nombre en español. No es un dato oficial."""
    if tags.get("amenity") == "kindergarten":
        return "Kinder"
    crudo = tags.get("isced:level") or tags.get("school:level") or ""
    if crudo:
        t = " " + normalizar_txt(crudo) + " "
        if re.search(r"jardin|kinder|preescolar|preprimary|preschool", t):
            return "Kinder"
        if re.search(r"preparatoria|bachillerato|high school|upper secondary", t):
            return "Preparatoria"
        if re.search(r"secundaria|secondary|middle", t):
            return "Secundaria"
        if re.search(r"primaria|primary", t):
            return "Primaria"
        nums = set(re.findall(r"[0-3]", crudo))
        if len(nums) == 1:
            return {"0": "Kinder", "1": "Primaria", "2": "Secundaria", "3": "Preparatoria"}[nums.pop()]
    n = " " + normalizar_txt(tags.get("name", "")) + " "
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
    ot = normalizar_txt(tags.get("operator:type", ""))
    if ot == "public":
        return "gratuita"
    if ot == "private":
        return "pago"
    fee = normalizar_txt(tags.get("fee", ""))
    if fee == "yes":
        return "pago"
    if fee == "no":
        return "gratuita"
    return "sindato"


def normalizar_elemento(el):
    tags = el.get("tags") or {}
    return {
        "id": f"{el['type']}/{el['id']}",
        "nombre": tags.get("name") or "Escuela sin nombre en OpenStreetMap",
        "nivel": clasificar_nivel(tags),
        "tipo": clasificar_tipo(tags),
        "website": tags.get("website") or tags.get("contact:website"),
        "telefono": tags.get("phone") or tags.get("contact:phone"),
    }


def obtener_datos(desde_archivo=None):
    if desde_archivo:
        with open(desde_archivo, encoding="utf-8") as f:
            return json.load(f)
    consulta = consulta_overpass(CENTRO[0], CENTRO[1], RADIO_KM)
    ultimo_error = None
    for url in URLS_OVERPASS:
        req = urllib.request.Request(
            url,
            data=urllib.parse.urlencode({"data": consulta}).encode("utf-8"),
            headers={
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": "SerchEducation/1.0 (revision semanal; datos OSM)",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # este intérprete falló: se pasa al siguiente
            ultimo_error = e
    raise ultimo_error


def main():
    ap = argparse.ArgumentParser(description="Revisión semanal de escuelas de Serch Education")
    ap.add_argument("--desde-archivo", help="Lee la respuesta de Overpass de un archivo (pruebas)")
    ap.add_argument("--foto", default=str(FOTO_DEFECTO), help="Ruta de la foto snapshot.json")
    args = ap.parse_args()

    data = obtener_datos(args.desde_archivo)
    escuelas = {}
    for el in data.get("elements", []):
        e = normalizar_elemento(el)
        escuelas[e["id"]] = e
    nueva = [escuelas[k] for k in sorted(escuelas)]

    ruta_foto = Path(args.foto)
    if not ruta_foto.exists():
        ruta_foto.write_text(json.dumps(nueva, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"Foto inicial guardada: {len(nueva)} escuelas en {RADIO_KM} km del IJEM.")
        return 0

    anterior = {e["id"]: e for e in json.loads(ruta_foto.read_text(encoding="utf-8"))}
    actual = {e["id"]: e for e in nueva}
    lineas = []
    for id_ in sorted(set(actual) - set(anterior)):
        e = actual[id_]
        lineas.append(f"ALTA {id_}: {e['nombre']} ({e['nivel']}, {e['tipo']})")
    for id_ in sorted(set(anterior) - set(actual)):
        e = anterior[id_]
        lineas.append(f"BAJA {id_}: {e['nombre']} ({e['nivel']}, {e['tipo']})")
    for id_ in sorted(set(actual) & set(anterior)):
        for campo in ("nombre", "nivel", "tipo", "website", "telefono"):
            if anterior[id_].get(campo) != actual[id_].get(campo):
                lineas.append(
                    f"CAMBIO {id_} {actual[id_]['nombre']}: {campo} "
                    f"«{anterior[id_].get(campo)}» -> «{actual[id_].get(campo)}»"
                )
    if lineas:
        ruta_foto.write_text(json.dumps(nueva, ensure_ascii=False, indent=1), encoding="utf-8")
        print("\n".join(lineas))
    # Sin cambios: silencio total (no se imprime nada).
    return 0


if __name__ == "__main__":
    sys.exit(main())
