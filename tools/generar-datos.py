#!/usr/bin/env python3
"""Búsqueda educativa — generador del registro propio de escuelas.

Descarga de OpenStreetMap (Overpass API) TODAS las escuelas
(amenity=school y amenity=kindergarten, nodos y vías) dentro de
50 km del punto medio de los dos centros fijos de la app
(IJEM 19.4785,-99.2396 y Jardín de Niños IJEM
19.4941815,-99.2199265; punto medio 19.4863, -99.2309) y
escribe el dataset que la app
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
y tipo, con la fuente de cada dato etiquetada en el registro
(nivelFuente / tipoFuente: "sep" | "osm" | "inferido"); el
registro de cada escuela es
{id, nombre, nivel, nivelFuente, tipo, tipoTexto, tipoFuente,
cct, lat, lng, website, telefono, direccion} (los campos sin
dato se omiten).

TRIANGULACIÓN DE NIVEL (y de tipo cuando la fuente lo confirma),
con esta precedencia:
1. SEP — el «Catálogo de centros de trabajo SEP» de datos.gob.mx
   (CSV por entidad en repodatos.atdt.gob.mx; entidades 09, 13 y
   15, las que cubre el círculo). Cruce por nombre normalizado
   (sin acentos y sin palabras de nivel) + cercanía ≤ 400 m si el
   catálogo trae coordenadas; si no, nombre exacto normalizado
   dentro del mismo municipio. Lo que cruza gana nivel y tipo
   con fuente "sep" y guarda su CCT.
   ⚠ ESTADO (2026-11-23): la descarga SÍ existe y las URL están
   verificadas, pero el CDN del repositorio (Akamai) responde
   403 a las peticiones desde esta red (probado con curl y con
   urllib, con y sin cabeceras de navegador). La etapa queda
   implementada y se activa sola cuando la descarga responda o
   cuando los CSV estén en tools/sep/ (cct_09.csv, cct_15.csv,
   cct_13.csv); mientras tanto se omite con un aviso en el log y
   el dataset se genera con los pasos 2 y 3.
2. OSM — lo declarado en las etiquetas (amenity=kindergarten,
   isced:level, school:level): fuente "osm".
3. Nombre — inferencia conservadora (patrones del sistema
   mexicano): fuente "inferido", etiquetada en la UI.
Lo que ni así se resuelve queda «Nivel sin especificar»:
residuo honesto, sin rellenar.

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
import csv
import io
import json
import math
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter
from datetime import date
from pathlib import Path

PUNTO = (19.4863, -99.2309)   # punto medio IJEM <-> Jardín de Niños IJEM
RADIO_KM = 50
URLS_OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
USER_AGENT = "BusquedaEducativa/1.0 (generador del registro de escuelas; datos OSM)"
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


def nivel_desde_nombre(nombre):
    """Nivel por el NOMBRE (inferido): patrones del sistema
    educativo mexicano, extendidos con las siglas de los
    subsistemas (CBTIS, CECyT, CONALEP, COBACH, EPO…).
    Espejo fiel de nivelDesdeNombre en app.js."""
    n = " " + normalizar_txt(nombre or "") + " "
    if re.search(r"jardin de ninos|jardin de infantes|kinder|preescolar|preprimaria|estancia infantil|cendi|caic|guarderia", n):
        return "Kinder"
    if re.search(r"preparatoria|bachillerato|bachilleres|cch|cbtis|cbta|cetis|cecyt|conalep|cobach|emsad| prepa ", n):
        return "Preparatoria"
    if re.search(r"\bepo\s*\d", n):
        return "Preparatoria"  # «EPO 139» y similares
    if re.search(r"secundaria|telesecundaria", n):
        return "Secundaria"
    if re.search(r"primaria", n):
        return "Primaria"
    return None


def clasificar_nivel_con_fuente(tags):
    """(nivel, fuente): lo declarado en OSM (amenity o isced /
    school:level) manda sobre el nombre ("osm"); el nombre
    etiqueta "inferido"; sin nada, «Nivel sin especificar» y
    fuente None (residuo honesto). La SEP, si cruza, va encima."""
    if tags.get("amenity") == "kindergarten":
        return "Kinder", "osm"
    por_etiqueta = nivel_desde_etiquetas_nivel(tags)
    if por_etiqueta:
        return por_etiqueta, "osm"
    por_nombre = nivel_desde_nombre(tags.get("name") or "")
    if por_nombre:
        return por_nombre, "inferido"
    return "Nivel sin especificar", None


def clasificar_nivel(tags):
    return clasificar_nivel_con_fuente(tags)[0]


def texto_tipo(clave, fuente):
    """Espejo de textoTipo en app.js."""
    if clave == "pago":
        if fuente == "inferido":
            return "De pago (inferido)"
        if fuente == "investigado":
            return "De pago (dato investigado)"
        return "Particular (de pago)"
    if clave == "gratuita":
        if fuente == "inferido":
            return "Gratuita (inferido)"
        if fuente == "investigado":
            return "Gratuita (dato investigado)"
        return "Pública (gratuita)"
    return "Tipo sin dato público"


def inferir_tipo_por_nombre(nombre):
    """Inferencia de tipo por el NOMBRE, conservadora (espejo
    fiel de inferirTipoPorNombre en app.js). Devuelve "gratuita",
    "pago" o None: ante la duda, sin dato. OJO: «Colegio de
    Bachilleres» y el CONALEP son PÚBLICOS; de «Instituto» a
    secas no se infiere nada."""
    n = normalizar_txt(nombre or "").strip()
    if not n:
        return None
    # 1) Sistema público: siglas y nombres oficiales inconfundibles.
    if re.search(r"\b(cendi|conafe|cbtis|cetis|conalep|cobach)\b", n):
        return "gratuita"
    if "colegio de bachilleres" in n:
        return "gratuita"
    if "colegio nacional de educacion" in n:
        return "gratuita"  # CONALEP, nombre extendido
    if "colegio de educacion profesional" in n:
        return "gratuita"  # CONALEP estatal (p. ej. el del Estado de México, sin «Nacional»)
    if "colegio de ciencias y humanidades" in n:
        return "gratuita"  # CCH (UNAM)
    if re.search(r"\b(unam|ipn|uaem)\b", n) or "instituto politecnico nacional" in n:
        return "gratuita"
    if n.startswith("escuela preparatoria oficial") or n.startswith("preparatoria oficial"):
        return "gratuita"
    if re.search(r"\bepo\s*\d", n):
        return "gratuita"  # «EPO 139» y similares
    if "secundaria tecnica" in n or "secundaria general" in n or "telesecundaria" in n:
        return "gratuita"
    if n.startswith("escuela primaria") or n.startswith("escuela secundaria"):
        return "gratuita"
    if n.startswith("primaria ") or n.startswith("secundaria "):
        return "gratuita"
    if "escuela nacional preparatoria" in n or re.search(r"\bvocacional\b", n):
        return "gratuita"
    # 2) Marcas privadas claras.
    if re.search(r"\b(montessori|waldorf)\b", n):
        return "pago"
    if re.search(r"\b(school|college|academy|kids|liceo)\b", n):
        return "pago"
    if n == "colegio" or n.startswith("colegio "):
        return "pago"
    # 3) Nombre oficial de plantel público con nombre de prócer
    #    (patrón SEP). Después de las marcas privadas a propósito:
    #    un «Preescolar Montessori» es de pago.
    if n.startswith("jardin de ninos") or n.startswith("preescolar"):
        return "gratuita"
    return None


def clasificar_tipo(tags):
    """(clave, texto, fuente) como en app.js: lo DECLARADO en las
    etiquetas (operator:type / fee) manda ("osm"); si el mapa no
    declara nada, inferencia por el nombre ("inferido")."""
    ot = normalizar_txt(tags.get("operator:type") or "")
    if ot == "public":
        return "gratuita", texto_tipo("gratuita", "osm"), "osm"
    if ot == "private":
        return "pago", texto_tipo("pago", "osm"), "osm"
    fee = normalizar_txt(tags.get("fee") or "")
    if fee == "yes":
        return "pago", "De pago (etiqueta fee=yes)", "osm"
    if fee == "no":
        return "gratuita", "Gratuita (etiqueta fee=no)", "osm"
    inf = inferir_tipo_por_nombre(tags.get("name") or "")
    if inf:
        return inf, texto_tipo(inf, "inferido"), "inferido"
    return "sindato", texto_tipo("sindato", None), None


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
    """Un elemento de Overpass -> (registro del dataset, municipio
    OSM) o (None, None). El municipio no va en el registro: solo
    lo usa el cruce con la SEP dentro del generador."""
    tags = el.get("tags") or {}
    lat = el.get("lat")
    lng = el.get("lon")
    if lat is None and el.get("center"):
        lat = el["center"].get("lat")
        lng = el["center"].get("lon")
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        return None, None
    clave, texto, fuente = clasificar_tipo(tags)
    nivel, nivel_fuente = clasificar_nivel_con_fuente(tags)
    reg = {
        "id": f"{el['type']}/{el['id']}",
        "nombre": tags.get("name") or "Escuela sin nombre en OpenStreetMap",
        "nivel": nivel,
        "tipo": clave,
        "tipoTexto": texto,
        "lat": lat,
        "lng": lng,
    }
    if nivel_fuente:
        reg["nivelFuente"] = nivel_fuente
    if fuente:
        reg["tipoFuente"] = fuente
    website = tags.get("website") or tags.get("contact:website")
    if website:
        reg["website"] = website
    telefono = tags.get("phone") or tags.get("contact:phone")
    if telefono:
        reg["telefono"] = telefono
    direccion = direccion_de(tags)
    if direccion:
        reg["direccion"] = direccion
    return reg, (tags.get("addr:city") or None)


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


# ------------------------------------------------------------------
# Etapa SEP (triangulación, precedencia 1): «Catálogo de centros
# de trabajo SEP» de datos.gob.mx. Ver la nota del docstring: las
# URL están verificadas pero el CDN (Akamai) responde 403 desde
# esta red; la etapa se activa sola cuando la descarga responda
# o cuando los CSV estén en tools/sep/. Si no, se omite con aviso
# y el dataset se genera con OSM + nombre. NUNCA truena el resto.
# ------------------------------------------------------------------
SEP_DIR = Path(__file__).resolve().parent / "sep"
SEP_ENTIDADES = ("09", "15", "13")  # CDMX, México e Hidalgo: las que toca el círculo de 50 km


def url_sep(ent):
    return ("https://repodatos.atdt.gob.mx/api_update/secretaria_educacion/"
            f"catalogo_centros_trabajo_sep/catalogo_centro_trabajo_{ent}_csv.csv")


_REEMPLAZOS_SUBSISTEMA = [
    ("centro de bachillerato tecnologico industrial y de servicios", "cbtis"),
    ("centro de estudios tecnologicos industrial y de servicios", "cetis"),
    ("centro de estudios tecnologicos industriales y de servicios", "cetis"),
    ("centro de estudios cientificos y tecnologicos", "cecyt"),
    ("colegio nacional de educacion profesional tecnica", "conalep"),
    ("colegio de bachilleres", "cobach"),
    ("escuela preparatoria oficial", "epo"),
    ("preparatoria oficial", "epo"),
]
_PALABRAS_NIVEL = {
    "escuela", "escuelas", "primaria", "primarias", "secundaria", "secundarias",
    "preparatoria", "preparatorias", "bachillerato", "jardin", "ninos", "ninas",
    "kinder", "preescolar", "colegio", "instituto", "centro", "centros",
    "educacion", "el", "la", "los", "las", "del", "de", "y", "e", "a", "en",
    "no", "num", "numero", "oficial", "federal", "estatal", "tecnica",
    "tecnico", "general", "anexa", "anexo", "normal", "superior", "particular",
    "publica", "publico", "para", "con",
}


def clave_nombre(nombre):
    """Clave de cruce: nombre normalizado SIN palabras de nivel ni
    institucionales genéricas, con los subsistemas largos reducidos
    a su sigla (así «Centro de Bachillerato Tecnológico… núm. 184»
    y «CBTIS 184» producen la misma clave)."""
    n = normalizar_txt(nombre or "")
    for frase, sigla in _REEMPLAZOS_SUBSISTEMA:
        n = n.replace(frase, " " + sigla + " ")
    toks = []
    for t in re.split(r"[^a-z0-9]+", n):
        if not t or t in _PALABRAS_NIVEL:
            continue
        if len(t) == 1 and not t.isdigit():
            continue
        toks.append("epo" if t == "epoan" else t)
    return " ".join(toks)


def nivel_desde_sep(texto):
    """Nivel del catálogo SEP -> nivel de la app (o None si el
    nivel oficial no es uno de los cuatro: especial, capacitación
    para el trabajo, superior… no se fuerzan)."""
    t = normalizar_txt(texto or "")
    if "media superior" in t or "bachillerato" in t:
        return "Preparatoria"
    if "preescolar" in t or re.search(r"\binicial\b", t):
        return "Kinder"
    if "primaria" in t:
        return "Primaria"
    if "secundaria" in t:
        return "Secundaria"
    return None


def tipo_desde_sep(texto):
    """Sostenimiento del catálogo SEP -> tipo de la app."""
    t = normalizar_txt(texto or "")
    if "particular" in t or "privad" in t:
        return "pago"
    if "public" in t or "autonom" in t or "federal" in t or "estatal" in t or "municipal" in t:
        return "gratuita"
    return None


def descargar_sep():
    """Rutas de los CSV del catálogo SEP, o None si no se pudo.
    Si los tres ya están en tools/sep/ (caché local), se usan."""
    rutas = [SEP_DIR / f"cct_{e}.csv" for e in SEP_ENTIDADES]
    if all(r.exists() and r.stat().st_size > 10000 for r in rutas):
        log("SEP: usando la caché local de tools/sep/")
        return rutas
    SEP_DIR.mkdir(parents=True, exist_ok=True)
    for ent, ruta in zip(SEP_ENTIDADES, rutas):
        try:
            req = urllib.request.Request(url_sep(ent), headers={
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 BusquedaEducativa/1.0",
                "Referer": "https://datos.gob.mx/dataset/catalogo_centros_trabajo_sep",
            })
            with urllib.request.urlopen(req, timeout=120) as r:
                datos = r.read()
            if len(datos) < 10000 or b"<html" in datos[:200].lower():
                raise ValueError("la respuesta no parece un CSV")
            ruta.write_bytes(datos)
            log(f"SEP: descargado el catálogo de la entidad {ent} ({len(datos)} bytes)")
        except Exception as e:
            log(f"SEP: NO se pudo descargar la entidad {ent}: {type(e).__name__} {str(e)[:100]}")
            log("SEP: etapa omitida (el CDN responde 403 desde esta red; ver docstring). "
                "El dataset se genera con OSM + nombre.")
            return None
    return rutas


_ALIAS_SEP = {
    "cct": ("cct", "clave", "clavedelcentrodetrabajo", "clavecentrodetrabajo", "clavedecentrosdetrabajo", "clavecct"),
    "nombre": ("nombre", "nombredelcentrodetrabajo", "nombrecentrodetrabajo", "nombrecentro", "nombreescuela"),
    "nivel": ("nivel", "niveleducativo", "descripcionnivel", "nombrenivel"),
    "sostenimiento": ("sostenimiento", "descripcionsostenimiento", "nombresostenimiento"),
    "lat": ("latitud", "lat"),
    "lng": ("longitud", "lng", "lon", "long"),
    "municipio": ("municipio", "descripcionmunicipio", "nombremunicipio", "alcaldia", "descripcionalcaldia"),
}


def _detectar_columnas(cabeceras):
    norm = {re.sub(r"[^a-z0-9]", "", normalizar_txt(h or "")): h for h in cabeceras}
    cols = {}
    for campo, alias in _ALIAS_SEP.items():
        for a in alias:
            if a in norm:
                cols[campo] = norm[a]
                break
    # Respaldo por subcadena para variantes no previstas.
    for nh, h in norm.items():
        if "nombre" not in cols and "nombre" in nh and "municip" not in nh and "nivel" not in nh and "sosten" not in nh:
            cols["nombre"] = h
        elif "nivel" not in cols and "nivel" in nh:
            cols["nivel"] = h
        elif "sostenimiento" not in cols and "sosten" in nh:
            cols["sostenimiento"] = h
        elif "lat" not in cols and nh.startswith("lat"):
            cols["lat"] = h
        elif "lng" not in cols and (nh.startswith("lon") or nh.startswith("lng")):
            cols["lng"] = h
        elif "municipio" not in cols and ("municip" in nh or "alcald" in nh):
            cols["municipio"] = h
        elif "cct" not in cols and ("clave" in nh or nh == "cct"):
            cols["cct"] = h
    return cols


def leer_sep(rutas):
    """Lee los CSV del catálogo y devuelve las entradas utilizables
    para el cruce: {cct, clave, nivel, tipo, lat, lng, municipio}."""
    entradas = []
    for ruta in rutas:
        crudo = ruta.read_bytes()
        texto = None
        for cod in ("utf-8-sig", "latin-1"):
            try:
                texto = crudo.decode(cod)
                break
            except UnicodeDecodeError:
                continue
        if texto is None:
            continue
        primera = texto.split("\n", 1)[0]
        delim = ";" if primera.count(";") > primera.count(",") else ","
        lector = csv.DictReader(io.StringIO(texto), delimiter=delim)
        if not lector.fieldnames:
            continue
        cols = _detectar_columnas(lector.fieldnames)
        if "nombre" not in cols:
            log(f"SEP: {ruta.name} no trae una columna de nombre reconocible: se salta")
            continue
        for fila in lector:
            def val(campo):
                c = cols.get(campo)
                v = fila.get(c) if c else None
                return v.strip() if isinstance(v, str) else ""
            nombre = val("nombre")
            if not nombre:
                continue
            lat = lng = None
            try:
                if val("lat"):
                    lat = float(val("lat").replace(",", "."))
                if val("lng"):
                    lng = float(val("lng").replace(",", "."))
            except ValueError:
                lat = lng = None
            if lat is not None and not (14 < lat < 33 and -119 < lng < -86):
                lat = lng = None  # fuera de México: coordenadas no utilizables
            entradas.append({
                "cct": val("cct") or None,
                "clave": clave_nombre(nombre),
                "nivel": nivel_desde_sep(val("nivel")),
                "tipo": tipo_desde_sep(val("sostenimiento")),
                "lat": lat, "lng": lng,
                "municipio": val("municipio") or None,
            })
    return entradas


def aplicar_sep(lista, municipios):
    """Cruza el dataset contra el catálogo SEP y fija nivel/tipo
    con fuente "sep" (+ CCT) en lo que cruce. Devuelve el número
    de escuelas cruzadas (0 si la etapa no corrió)."""
    rutas = descargar_sep()
    if not rutas:
        return 0
    try:
        entradas = leer_sep(rutas)
    except Exception as e:
        log(f"SEP: no se pudo leer el catálogo ({type(e).__name__} {str(e)[:100]}): etapa omitida.")
        return 0
    if not entradas:
        log("SEP: el catálogo no trajo entradas utilizables: etapa omitida.")
        return 0
    indice = {}
    for en in entradas:
        if en["clave"]:
            indice.setdefault(en["clave"], []).append(en)
    cruzadas = 0
    for reg in lista:
        clave = clave_nombre(reg["nombre"])
        if not clave:
            continue
        cands = indice.get(clave) or []
        if not cands:
            continue
        elegido = None
        con_coords = [c for c in cands if c["lat"] is not None]
        if con_coords:
            cerca = [(distancia_km(reg["lat"], reg["lng"], c["lat"], c["lng"]), c) for c in con_coords]
            cerca = [x for x in cerca if x[0] <= 0.4]  # umbral prudente: 400 m
            if cerca:
                elegido = min(cerca, key=lambda x: x[0])[1]
        if elegido is None:
            # Sin coordenadas útiles: nombre exacto normalizado
            # dentro del mismo municipio, y candidato único.
            mun = normalizar_txt(municipios.get(reg["id"]) or "").strip()
            if mun:
                mismos = [c for c in cands
                          if c["municipio"] and normalizar_txt(c["municipio"]).strip() == mun]
                if len(mismos) == 1:
                    elegido = mismos[0]
        if not elegido:
            continue
        cruzadas += 1
        if elegido["cct"]:
            reg["cct"] = elegido["cct"]
        if elegido["nivel"]:
            reg["nivel"] = elegido["nivel"]
            reg["nivelFuente"] = "sep"
        if elegido["tipo"]:
            reg["tipo"] = elegido["tipo"]
            reg["tipoTexto"] = texto_tipo(elegido["tipo"], "sep")
            reg["tipoFuente"] = "sep"
    log(f"SEP: {cruzadas} escuelas cruzadas con el catálogo oficial (de {len(lista)} en el registro)")
    return cruzadas


def main():
    global args
    ap = argparse.ArgumentParser(description="Genera escuelas.json, el registro propio de Búsqueda educativa")
    ap.add_argument("--salida", default=str(SALIDA_DEFECTO), help="Ruta del escuelas.json a escribir")
    ap.add_argument("--celda", type=float, default=0.15, help="Tamaño de celda de la rejilla, en grados")
    ap.add_argument("--rondas-celda", type=int, default=4, help="Rondas de intérpretes por celda")
    ap.add_argument("--sin-sep", action="store_true", help="Omite la etapa de triangulación con el catálogo SEP")
    args = ap.parse_args()

    elementos, parcial, detalle = descargar()

    escuelas = {}
    municipios = {}
    for el in elementos:
        reg, municipio = normalizar_elemento(el)
        if reg is None:
            continue
        if distancia_km(PUNTO[0], PUNTO[1], reg["lat"], reg["lng"]) > RADIO_KM:
            continue  # la rejilla sobrecubre las esquinas: fuera del círculo no va
        escuelas[reg["id"]] = reg
        if municipio:
            municipios[reg["id"]] = municipio
    lista = [escuelas[k] for k in sorted(escuelas)]

    if not args.sin_sep:
        aplicar_sep(lista, municipios)
    log("Nivel: " + str(dict(Counter(r["nivel"] for r in lista))))
    log("Nivel por fuente: " + str(dict(Counter(r.get("nivelFuente") or "—" for r in lista))))
    log("Tipo por fuente: " + str(dict(Counter(r.get("tipoFuente") or "—" for r in lista))))

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
