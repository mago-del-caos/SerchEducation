/* Pruebas de Serch Education con jsdom y un fixture local de Overpass
   (sin red real): se sirve el proyecto por HTTP local, se sustituye
   fetch (Overpass y datos-extra.json) y Leaflet por dobles de prueba.
   Uso:  cd tests && node test-serch.mjs                        */
import pkg from "jsdom";
const { JSDOM, requestInterceptor } = pkg;
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureOverpass = JSON.parse(await readFile(path.join(RAIZ, "tests", "fixture-overpass.json"), "utf8"));
const eventosReales = JSON.parse(await readFile(path.join(RAIZ, "eventos.json"), "utf8"));

/* datos-extra.json de prueba: fama y eventos para dos escuelas. */
const EXTRA = {
  "node/102": {
    costos: "Sin colegiatura; cuota voluntaria de padres de familia",
    beneficios: ["Comedor escolar", "Beca Benito Juárez"],
    servicios: ["Transporte escolar", "Horario extendido"],
    eventos: [{ titulo: "Inscripciones abiertas", fecha: "2026-12-01", descripcion: "Periodo de inscripción al ciclo siguiente." }],
    valoracion: { estrellas: 4.6, opiniones: 230, fuente: "Google", fecha: "2026-11-20" },
    fuente: "https://ejemplo.edu.mx/primaria-benito-juarez",
    fecha: "2026-11-20"
  },
  "node/103": {
    valoracion: { estrellas: 3.8, opiniones: 95, fuente: "Google", fecha: "2026-11-20" },
    fuente: "https://ejemplo.edu.mx/secundaria-tecnica-45",
    fecha: "2026-11-20"
  }
};

const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    let p = path.join(RAIZ, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    const data = await readFile(p);
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(p)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("no"); }
});
await new Promise(r => servidor.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + servidor.address().port + "/";

/* Solo se deja pasar la red local; el CDN (Leaflet) se responde vacío
   para que en el mapa mande el doble de L puesto en beforeParse. */
const soloLocal = {
  interceptors: [requestInterceptor((request) => {
    if (request.url.startsWith(BASE)) return undefined;
    return new Response("", { status: 200, headers: { "Content-Type": "text/plain" } });
  })]
};

async function cargarPagina(archivo, urlSufijo, opciones = {}) {
  const html = await readFile(path.join(RAIZ, archivo), "utf8");
  return new JSDOM(html, {
    url: BASE + archivo + (urlSufijo || ""),
    resources: soloLocal,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    ...opciones
  });
}

let pasadas = 0, falladas = 0;
function ok(cond, nombre) {
  if (cond) { pasadas++; console.log("  ✓ " + nombre); }
  else { falladas++; console.log("  ✗ " + nombre); }
}
async function esperar(fn, nombre, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 60));
  }
  ok(false, nombre + " (tiempo agotado)");
  return false;
}
function stubFetch(win) {
  win.fetch = async (url) => {
    const u = String(url);
    const cuerpo = u.includes("overpass") ? fixtureOverpass
      : u.includes("datos-extra.json") ? EXTRA
      : u.includes("eventos.json") ? eventosReales
      : {};
    return { ok: true, status: 200, json: async () => cuerpo };
  };
}

/* ============ 1. Funciones puras (en el contexto de index) ============ */
console.log("— Funciones puras y clasificación —");
const domIndex = await cargarPagina("index.html", "", {
  beforeParse(win) { stubFetch(win); }
});
const w = domIndex.window;
await esperar(() => w.document.querySelectorAll("#lista .tarjeta-est").length >= 6, "el inicio pinta las 6 escuelas del radio de 5 km");
const ev = (expr) => w.eval(expr);

ok(ev("construirConsultaOverpass(19.4785, -99.2396, 5)").includes("around:5000,19.4785,-99.2396"), "la consulta Overpass se construye con el radio pedido (5 km → 5000 m)");
ok(ev("construirConsultaOverpass(19.4785, -99.2396, 50)").includes("around:50000"), "la consulta con 50 km usa 50000 m");
ok(ev("normalizar('Jardín de Niños ÁÉÍ')") === "jardin de ninos aei", "normalizar quita acentos");
ok(ev("clasificarNivel({amenity:'school', name:'Jardín de Niños Las Flores'})") === "Kinder", "nivel: kinder por nombre");
ok(ev("clasificarNivel({amenity:'school', name:'Escuela Primaria Benito Juárez'})") === "Primaria", "nivel: primaria por nombre");
ok(ev("clasificarNivel({amenity:'school', name:'Escuela Secundaria Técnica 45'})") === "Secundaria", "nivel: secundaria por nombre");
ok(ev("clasificarNivel({amenity:'school', name:'Preparatoria Oficial Anexa'})") === "Preparatoria", "nivel: preparatoria por nombre");
ok(ev("clasificarNivel({amenity:'kindergarten', name:'CENDI Pequeños Pasos'})") === "Kinder", "nivel: amenity=kindergarten → Kinder");
ok(ev("clasificarNivel({amenity:'school', name:'Instituto Cultural Amanecer'})") === "Nivel sin especificar", "nivel: sin especificar cuando no se puede saber");
ok(ev("clasificarNivel({amenity:'school', name:'CBTis 184'})") === "Preparatoria", "nivel: CBTis → Preparatoria");
ok(ev("clasificarTipo({amenity:'school','operator:type':'public'}).clave") === "gratuita", "tipo: operator:type=public → gratuita");
ok(ev("clasificarTipo({amenity:'school','operator:type':'private'}).clave") === "pago", "tipo: operator:type=private → pago");
ok(ev("clasificarTipo({amenity:'school'}).clave") === "sindato", "tipo: sin etiquetas → sin dato");
ok(ev("filtrarPorRadio([{dist:0.5},{dist:4.9},{dist:5.1},{dist:19.7}], 5).length") === 2, "el filtro por radio descarta las escuelas lejanas");
ok(ev("CENTRO_DEFECTO.lat") === 19.4785 && ev("CENTRO_DEFECTO.lng") === -99.2396 && ev("CENTRO_DEFECTO.etiqueta").includes("Instituto Juventud"), "el centro por defecto es el IJEM (19.4785, -99.2396)");

/* ============ 2. Inicio: tarjetas, fama y orden «Mejor fama» ============ */
console.log("— Inicio: tarjetas y orden por fama —");
const tarjetas = () => [...w.document.querySelectorAll("#lista .tarjeta-est")];
ok(tarjetas().length === 6, "en 5 km hay 6 tarjetas (la lejana queda fuera)");
const tarjeta102 = tarjetas().find(t => t.textContent.includes("Benito Juárez"));
ok(!!tarjeta102 && tarjeta102.textContent.includes("Dato investigado"), "la tarjeta de la escuela investigada trae la marca «Dato investigado»");
ok(!!tarjeta102 && tarjeta102.textContent.includes("4.6") && tarjeta102.textContent.includes("230 opiniones"), "la tarjeta muestra la fama compacta (★ 4.6 · 230 opiniones)");
ok(!!tarjeta102 && tarjeta102.textContent.includes("Sin colegiatura"), "la tarjeta muestra el costo investigado");
w.document.querySelector('.orden-btn[data-orden="fama"]').click();
await new Promise(r => setTimeout(r, 150));
const nombresOrden = tarjetas().map(t => t.querySelector(".est-nombre").textContent);
ok(nombresOrden[0].includes("Benito Juárez"), "orden «Mejor fama»: primero la de 4.6 estrellas");
ok(nombresOrden[1].includes("Secundaria Técnica 45"), "orden «Mejor fama»: segunda la de 3.8 estrellas");
ok(nombresOrden.slice(2).every(n => !n.includes("Benito") && !n.includes("Técnica")), "orden «Mejor fama»: las sin valoración van al final");

/* ============ 3. Chatbot: fama y eventos desde datos-extra ============ */
console.log("— Chatbot —");
const fama = ev("botRespuesta('¿qué fama tiene la Escuela Primaria Benito Juárez?')");
ok(fama.includes("4.6") && fama.includes("230"), "el bot responde la fama de una escuela del fixture");
const mejor = ev("botRespuesta('¿cuál es la mejor valorada?')");
ok(mejor.includes("Benito Juárez") && mejor.includes("4.6"), "el bot responde cuál es la mejor valorada");
const eventos = ev("botRespuesta('¿qué eventos hay?')");
ok(eventos.includes("Inscripciones abiertas"), "el bot responde los eventos investigados");
const cercana = ev("botRespuesta('¿cuál es la más cercana?')");
ok(cercana.includes("Instituto Juventud") || cercana.length > 20, "el bot responde la más cercana");
const gratuitas = ev("botRespuesta('¿cuáles son gratuitas?')");
ok(gratuitas.includes("Benito Juárez"), "el bot responde las gratuitas (operator:type=public)");

/* ============ 4. Ficha de escuela: la fusión muestra la fama ============ */
console.log("— Ficha de escuela —");
const guardado = JSON.parse(w.sessionStorage.getItem("serch_resultados"));
const domFicha = await cargarPagina("escuela.html", "?id=" + encodeURIComponent("node/102"), {
  beforeParse(win) {
    stubFetch(win);
    win.sessionStorage.setItem("serch_resultados", JSON.stringify(guardado));
  }
});
await esperar(() => domFicha.window.document.querySelector("#ficha").textContent.includes("Fama"), "la ficha pinta la sección «Fama»");
const fichaTxt = domFicha.window.document.querySelector("#ficha").textContent;
ok(fichaTxt.includes("Fama") && fichaTxt.includes("4.6") && fichaTxt.includes("230 opiniones"), "la ficha muestra las estrellas de la valoración investigada con sus opiniones");
ok(fichaTxt.includes("Google"), "la ficha muestra la fuente de la valoración");
ok(fichaTxt.includes("Eventos y promociones") && fichaTxt.includes("Inscripciones abiertas"), "la ficha muestra los eventos investigados");
ok(fichaTxt.includes("Datos investigados") && fichaTxt.includes("Comedor escolar"), "la ficha muestra beneficios investigados");
ok(fichaTxt.includes("Sin colegiatura") && fichaTxt.includes("dato investigado"), "la ficha muestra el costo investigado con prioridad y marcado");
const llenas = domFicha.window.document.querySelectorAll(".estrellas-ver .est.llena").length;
const medias = domFicha.window.document.querySelectorAll(".estrellas-ver .est.media").length;
ok(llenas === 4 && medias === 1, "el pintado de estrellas de 4.6 da 4 llenas y 1 media");

/* ============ 5. Mapa: el círculo usa el radio elegido ============ */
console.log("— Mapa —");
const radiosCirculo = [];
const domMapa = await cargarPagina("mapa.html", "", {
  beforeParse(win) {
    stubFetch(win);
    win.L = {
      map: () => ({ setView() { return this; }, fitBounds() {} }),
      tileLayer: () => ({ addTo() {} }),
      circle: (latlng, opts) => { radiosCirculo.push(opts.radius); return { addTo() { return this; }, remove() {}, getBounds() { return {}; } }; },
      marker: () => ({ addTo() { return this; }, bindPopup() { return this; }, remove() {} }),
      divIcon: (o) => o, icon: (o) => o,
      layerGroup: () => ({ addLayer() {}, addTo() { return this; }, remove() {} })
    };
  }
});
await esperar(() => radiosCirculo.includes(5000), "el mapa dibuja el círculo del radio de la búsqueda (5 km)");
domMapa.window.document.querySelector('.chip-radio[data-radio="10"]').click();
await esperar(() => radiosCirculo.includes(10000), "al cambiar el radio a 10 km, el círculo se redibuja con 10000 m");

/* ============ 6. Eventos: pinta eventos.json y los investigados ============ */
console.log("— Página de eventos —");
const domEventos = await cargarPagina("eventos.html", "", {
  beforeParse(win) {
    stubFetch(win);
    win.sessionStorage.setItem("serch_resultados", JSON.stringify(guardado));
  }
});
await esperar(() => domEventos.window.document.querySelector("#listaEventos").textContent.includes("Vigilancia activa"), "eventos.html pinta los hallazgos de eventos.json");
ok(domEventos.window.document.querySelector("#listaInvestigados").textContent.includes("Inscripciones abiertas"), "eventos.html pinta los eventos investigados de datos-extra.json");
ok(domEventos.window.document.querySelector("#listaInvestigados").textContent.includes("Benito Juárez"), "los eventos investigados van agrupados por escuela, con su nombre");
ok(domEventos.window.document.querySelector("#listaInvestigados").textContent.includes("Consultado el 2026-11-20"), "el grupo muestra la fecha de consulta");

/* ============ 7. Respaldo Overpass: el 1º falla, el 2º responde ============ */
console.log("— Respaldo de intérpretes Overpass —");
const llamadasOverpass = [];
const domRespaldo = await cargarPagina("index.html", "", {
  beforeParse(win) {
    win.fetch = async (url) => {
      const u = String(url);
      if (u.includes("overpass")) {
        llamadasOverpass.push(u);
        if (u.includes("overpass-api.de")) throw new TypeError("fallo de red simulado");
        return { ok: true, status: 200, json: async () => fixtureOverpass };
      }
      const cuerpo = u.includes("datos-extra.json") ? EXTRA
        : u.includes("eventos.json") ? eventosReales : {};
      return { ok: true, status: 200, json: async () => cuerpo };
    };
  }
});
await esperar(() => domRespaldo.window.document.querySelectorAll("#lista .tarjeta-est").length >= 6, "con el primer intérprete caído, la búsqueda termina con resultados del respaldo");
ok(llamadasOverpass.length >= 2 &&
   llamadasOverpass[0].includes("overpass-api.de") &&
   llamadasOverpass[1].includes("overpass.kumi.systems"),
   "se intentó primero overpass-api.de y luego el respaldo kumi.systems, sin intervención del usuario");
const estadoRespaldo = domRespaldo.window.document.querySelector("#estadoBusqueda").textContent;
ok(estadoRespaldo.includes("Se encontraron") && !estadoRespaldo.includes("falló"),
   "sin error visible: el estado reporta las escuelas encontradas vía el respaldo");
ok(domRespaldo.window.sessionStorage.getItem("serch_overpass_endpoint") === "https://overpass.kumi.systems/api/interpreter",
   "se recuerda en sessionStorage el intérprete que funcionó (kumi.systems)");

console.log("\nResultado: " + pasadas + " pasadas, " + falladas + " falladas");
servidor.close();
process.exit(falladas ? 1 : 0);
