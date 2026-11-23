/* Pruebas de Serch Education con jsdom y fixtures locales (sin red
   real): la fuente primaria es el dataset (fixture-escuelas.json,
   espejo chico de escuelas.json); Overpass solo se ejercita en el
   botón «Actualizar en vivo» con fixture-overpass.json. Se sirve el
   proyecto por HTTP local y se sustituyen fetch y Leaflet por
   dobles de prueba.
   Uso:  cd tests && node test-serch.mjs                        */
import pkg from "jsdom";
const { JSDOM, requestInterceptor } = pkg;
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureOverpass = JSON.parse(await readFile(path.join(RAIZ, "tests", "fixture-overpass.json"), "utf8"));
const fixtureDataset = JSON.parse(await readFile(path.join(RAIZ, "tests", "fixture-escuelas.json"), "utf8"));
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
/* Doble de fetch: registra cada URL pedida en win.__urls.
   Opciones: {dataset} sustituye el cuerpo de escuelas.json;
   {extra} sustituye el cuerpo de datos-extra.json;
   {datasetFalla:true} hace que escuelas.json lance (red caída). */
function stubFetch(win, opciones = {}) {
  win.__urls = [];
  win.fetch = async (url) => {
    const u = String(url);
    win.__urls.push(u);
    if (u.includes("overpass")) return { ok: true, status: 200, json: async () => fixtureOverpass };
    if (u.includes("escuelas.json")) {
      if (opciones.datasetFalla) throw new TypeError("fallo de red simulado (dataset)");
      return { ok: true, status: 200, json: async () => opciones.dataset || fixtureDataset };
    }
    const cuerpo = u.includes("datos-extra.json") ? (opciones.extra || EXTRA)
      : u.includes("eventos.json") ? eventosReales
      : {};
    return { ok: true, status: 200, json: async () => cuerpo };
  };
}
/* Doble de Leaflet que registra teselas, iconos, marcadores y
   radios de círculo pedidos, para poder afirmar sobre ellos. */
function stubLeaflet(reg) {
  return {
    map: () => ({ setView() { return this; }, fitBounds() {} }),
    tileLayer: (url) => { reg.teselas.push(url); return { addTo() {} }; },
    circle: (latlng, opts) => { reg.radios.push(opts.radius); return { addTo() { return this; }, remove() {}, getBounds() { return {}; } }; },
    marker: (latlng, opts) => {
      const m = { latlng, opts, popup: null,
        addTo() { return this; },
        bindPopup(html) { this.popup = html; reg.marcadores.push(this); return this; },
        remove() {} };
      return m;
    },
    divIcon: (o) => o,
    icon: (o) => { reg.iconos.push(o); return o; },
    layerGroup: () => ({ addLayer() {}, addTo() { return this; }, remove() {} })
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
/* --- Tipo: inferencia por nombre, conservadora y etiquetada --- */
ok(ev("clasificarTipo({amenity:'school', name:'Colegio Ejemplo'}).clave") === "pago" &&
   ev("clasificarTipo({amenity:'school', name:'Colegio Ejemplo'}).fuente") === "inferido" &&
   ev("clasificarTipo({amenity:'school', name:'Colegio Ejemplo'}).texto") === "De pago (inferido)",
   "tipo: «Colegio Ejemplo» sin etiquetas → pago INFERIDO, con su etiqueta");
ok(ev("clasificarTipo({amenity:'school', name:'Escuela Primaria Benito Juárez'}).clave") === "gratuita" &&
   ev("clasificarTipo({amenity:'school', name:'Escuela Primaria Benito Juárez'}).fuente") === "inferido",
   "tipo: «Escuela Primaria…» sin etiquetas → gratuita inferida");
ok(ev("clasificarTipo({amenity:'school', name:'Colegio de Bachilleres Plantel 13'}).clave") === "gratuita",
   "tipo: «Colegio de Bachilleres» es PÚBLICO (no se infiere pago de todo «Colegio…»)");
ok(ev("clasificarTipo({amenity:'school', name:'Colegio de Educación Profesional Técnica del Estado de México'}).clave") === "gratuita",
   "tipo: el «Colegio de Educación Profesional Técnica» estatal es el CONALEP (público), no un colegio de pago");
ok(ev("clasificarTipo({amenity:'school', name:'Colegio Ejemplo', 'operator:type':'public'}).clave") === "gratuita" &&
   ev("clasificarTipo({amenity:'school', name:'Colegio Ejemplo', 'operator:type':'public'}).fuente") === "osm",
   "tipo: lo DECLARADO en OSM no se sobrescribe por la inferencia del nombre");
ok(ev("clasificarTipo({amenity:'school', name:'Instituto Cultural Amanecer'}).clave") === "sindato" &&
   ev("clasificarTipo({amenity:'school', name:'Instituto Cultural Amanecer'}).fuente") === null,
   "tipo: de «Instituto» a secas NO se infiere nada (hay institutos públicos)");
ok(ev("inferirTipoPorNombre('Jardín de Niños Las Flores')") === "gratuita", "inferencia: «Jardín de Niños…» → gratuita");
ok(ev("inferirTipoPorNombre('Preescolar Montessori Valle')") === "pago", "inferencia: la marca privada (Montessori) gana al patrón «Preescolar…»");
ok(ev("inferirTipoPorNombre('Secundaria Técnica 45')") === "gratuita", "inferencia: «Secundaria Técnica» → gratuita");
/* --- Nivel con fuente (triangulación OSM > nombre en la app) --- */
ok(ev("clasificarNivelConFuente({amenity:'kindergarten', name:'Lo Que Sea'}).fuente") === "osm" &&
   ev("clasificarNivelConFuente({amenity:'kindergarten', name:'Lo Que Sea'}).nivel") === "Kinder",
   "nivel: amenity=kindergarten declara el nivel en OSM (fuente «osm»)");
ok(ev("clasificarNivelConFuente({amenity:'school','isced:level':'2', name:'Lo Que Sea'}).nivel") === "Secundaria" &&
   ev("clasificarNivelConFuente({amenity:'school','isced:level':'2', name:'Lo Que Sea'}).fuente") === "osm",
   "nivel: isced:level manda sobre el nombre (fuente «osm»)");
ok(ev("clasificarNivelConFuente({amenity:'school', name:'EPO 139'}).nivel") === "Preparatoria" &&
   ev("clasificarNivelConFuente({amenity:'school', name:'EPO 139'}).fuente") === "inferido",
   "nivel: «EPO 139» se resuelve por el nombre (fuente «inferido», patrón extendido)");
ok(ev("clasificarNivelConFuente({amenity:'school', name:'CECyT 9'}).nivel") === "Preparatoria",
   "nivel: «CECyT» (IPN) → Preparatoria por el nombre");
ok(ev("textoNivel('Primaria','inferido')") === "Primaria (inferido)" && ev("textoNivel('Primaria','osm')") === "Primaria",
   "el nivel solo lleva la etiqueta «(inferido)» cuando su fuente es el nombre");
/* --- escuelaDesdeRegistro: tipo/nivel con fuente desde el dataset --- */
ok(ev("escuelaDesdeRegistro({id:'node/201', nombre:'Colegio Ejemplo', nivel:'Primaria', tipo:'sindato', tipoTexto:'Tipo sin dato público', lat:19.48, lng:-99.24}).tipo") === "pago" &&
   ev("escuelaDesdeRegistro({id:'node/201', nombre:'Colegio Ejemplo', nivel:'Primaria', tipo:'sindato', tipoTexto:'Tipo sin dato público', lat:19.48, lng:-99.24}).tipoFuente") === "inferido" &&
   ev("escuelaDesdeRegistro({id:'node/201', nombre:'Colegio Ejemplo', nivel:'Primaria', tipo:'sindato', tipoTexto:'Tipo sin dato público', lat:19.48, lng:-99.24}).tipoTexto") === "De pago (inferido)",
   "dataset: un registro «sin dato» llamado «Colegio Ejemplo» queda pago (inferido) también desde la app");
ok(ev("escuelaDesdeRegistro({id:'node/202', nombre:'Colegio Declarado', nivel:'Primaria', tipo:'gratuita', tipoTexto:'Pública (gratuita)', tipoFuente:'osm', lat:19.48, lng:-99.24}).tipo") === "gratuita" &&
   ev("escuelaDesdeRegistro({id:'node/202', nombre:'Colegio Declarado', nivel:'Primaria', tipo:'gratuita', tipoTexto:'Pública (gratuita)', tipoFuente:'osm', lat:19.48, lng:-99.24}).tipoFuente") === "osm",
   "dataset: un tipo declarado (fuente «osm») NO lo sobrescribe la inferencia del nombre");
ok(ev("escuelaDesdeRegistro({id:'node/203', nombre:'Telesecundaria 21', nivel:'Nivel sin especificar', tipo:'sindato', lat:19.48, lng:-99.24}).nivel") === "Secundaria" &&
   ev("escuelaDesdeRegistro({id:'node/203', nombre:'Telesecundaria 21', nivel:'Nivel sin especificar', tipo:'sindato', lat:19.48, lng:-99.24}).nivelTexto") === "Secundaria (inferido)",
   "dataset: un «Nivel sin especificar» llamado «Telesecundaria 21» se resuelve por nombre y se etiqueta");
/* --- datos-extra manda sobre OSM y sobre la inferencia --- */
const extraTipo = JSON.parse(ev("JSON.stringify(aplicarDatosExtra({id:'node/999', nombre:'Colegio Ejemplo', tipo:'pago', tipoTexto:'Particular (de pago)', tipoFuente:'osm'}, {'node/999': {tipo:'gratuita', fuente:'Prueba', fecha:'2026-11-22'}}))"));
ok(extraTipo.tipo === "gratuita" && extraTipo.tipoFuente === "investigado" && extraTipo.tipoTexto === "Gratuita (dato investigado)",
   "datos-extra: el tipo investigado manda sobre lo declarado en OSM y sobre lo inferido");
ok(ev("filtrarPorRadio([{dist:0.5},{dist:4.9},{dist:5.1},{dist:19.7}], 5).length") === 2, "el filtro por radio descarta las escuelas lejanas");
ok(ev("CENTRO_DEFECTO.lat") === 19.4785 && ev("CENTRO_DEFECTO.lng") === -99.2396 && ev("CENTRO_DEFECTO.etiqueta").includes("Instituto Juventud"), "el centro por defecto es el IJEM (19.4785, -99.2396)");
ok(ev("CENTROS.ijem.lat") === 19.4785 && ev("CENTROS.ijem.lng") === -99.2396, "CENTROS.ijem tiene las coordenadas del IJEM");
ok(ev("CENTROS.kinder.lat") === 19.4941815 && ev("CENTROS.kinder.lng") === -99.2199265 && ev("CENTROS.kinder.etiqueta").includes("Jardín de Niños"), "CENTROS.kinder es el Jardín de Niños IJEM (19.4941815, -99.2199265, Av. del Paseo 19)");
ok(ev("centroActivo()") === "ijem" && ev("origen.lat") === 19.4785, "el centro activo al arrancar es el IJEM y el origen parte de él");
ok(w.document.querySelectorAll("#selectorCentro .centro-btn").length === 2, "el Inicio trae el interruptor con los dos centros");
ok(w.document.querySelector('#selectorCentro .centro-btn[data-centro="ijem"]').classList.contains("activo"), "en el interruptor arranca activo «Instituto Juventud»");
ok(!w.document.getElementById("btnGps") && !w.document.body.textContent.includes("Usar mi ubicación"), "ya no existe el botón «Usar mi ubicación» en el Inicio");
ok(ev("typeof pedirUbicacion") === "undefined" && ev("typeof hayGPS") === "undefined", "la geolocalización como origen quedó eliminada de app.js");
ok(w.__urls.some(u => u.includes("escuelas.json")), "al cargar se pidió el registro propio (escuelas.json)");
ok(!w.__urls.some(u => u.includes("overpass")), "al cargar NO se llamó a Overpass: la lista sale del dataset, no de la consulta en vivo");
const estadoIni = w.document.querySelector("#estadoBusqueda").textContent;
ok(estadoIni.includes("Datos del 2026-11-21") && estadoIni.includes("7 escuelas en el registro") && estadoIni.includes("se actualiza cada semana"),
   "la línea de estado dice la fecha del dataset, su total y que se actualiza cada semana");
ok(ev("infoDataset().total") === 7 && ev("infoDataset().generado") === "2026-11-21" && ev("fuenteActual()") === "dataset",
   "infoDataset expone fecha y total del registro, y la fuente activa es el dataset");
const lineaCentro = w.document.querySelector("#centroActivoTxt").textContent;
ok(lineaCentro.includes("Instituto Juventud del Estado de México") && lineaCentro.includes("Rincón Echegaray"),
   "bajo el interruptor, la línea de centro activo nombra el centro y su dirección de referencia");

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

/* ============ 5. Mapa: círculo, teselas OSM y marcador del centro ============ */
console.log("— Mapa —");
const regMapa = { teselas: [], iconos: [], marcadores: [], radios: [] };
const domMapa = await cargarPagina("mapa.html", "", {
  beforeParse(win) {
    stubFetch(win);
    win.L = stubLeaflet(regMapa);
  }
});
await esperar(() => regMapa.radios.includes(5000), "el mapa dibuja el círculo del radio de la búsqueda (5 km)");
ok(!domMapa.window.document.getElementById("btnMiUbicacion"), "ya no existe el botón «Mi ubicación» en el Mapa");
ok(domMapa.window.document.querySelectorAll("#selectorCentro .centro-btn").length === 2, "el Mapa trae el interruptor con los dos centros");
ok(regMapa.teselas.length === 1 && regMapa.teselas[0] === "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
   "el mapa usa las teselas estándar de OpenStreetMap (CARTO quedó fuera: su capa pública ahora exige API key)");
const iconoCentro = regMapa.iconos.find(o => o.iconUrl === "assets/marcador-centro.png");
ok(!!iconoCentro && iconoCentro.iconSize[0] === 44 && iconoCentro.iconSize[1] === 44,
   "el centro se marca con el logo «Soy Juventud» (assets/marcador-centro.png) a 44 px");
const marcadorCentro = regMapa.marcadores.find(m => m.opts && m.opts.zIndexOffset === 10000);
ok(!!marcadorCentro && marcadorCentro.latlng[0] === 19.4785 && marcadorCentro.latlng[1] === -99.2396,
   "el marcador del centro está en las coordenadas del IJEM y por encima de todo (zIndexOffset máximo)");
ok(!!marcadorCentro && marcadorCentro.popup.includes("Instituto Juventud del Estado de México") && marcadorCentro.popup.includes("centro de búsqueda"),
   "el popup del marcador nombra el centro activo: «Instituto Juventud del Estado de México — centro de búsqueda»");
domMapa.window.document.querySelector('.chip-radio[data-radio="10"]').click();
await esperar(() => regMapa.radios.includes(10000), "al cambiar el radio a 10 km, el círculo se redibuja con 10000 m");

/* ============ 5b. Mapa con cero resultados: el centro se ve igual ============ */
console.log("— Mapa sin resultados —");
const datasetLejano = { generado: "2026-11-21", total: 1, escuelas: fixtureDataset.escuelas.filter(e => e.id === "node/107") };
const regCero = { teselas: [], iconos: [], marcadores: [], radios: [] };
const domMapaCero = await cargarPagina("mapa.html", "", {
  beforeParse(win) {
    stubFetch(win, { dataset: datasetLejano });
    win.L = stubLeaflet(regCero);
  }
});
await esperar(() => regCero.marcadores.some(m => m.opts && m.opts.zIndexOffset === 10000),
   "con cero escuelas en el radio, el marcador del centro se dibuja igual");
const marcadorCero = regCero.marcadores.find(m => m.opts && m.opts.zIndexOffset === 10000);
ok(!!marcadorCero && marcadorCero.popup.includes("Instituto Juventud del Estado de México") && marcadorCero.popup.includes("centro de búsqueda"),
   "sin resultados, el popup sigue nombrando el centro activo");
ok(domMapaCero.window.document.querySelector("#mapaMsg").textContent.includes("Se encontraron 0 escuelas"),
   "el mapa reporta cero escuelas sin romperse");

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

/* ============ 7. «Actualizar en vivo»: opcional y sustituye la sesión ============ */
console.log("— Actualizar en vivo (Overpass con respaldos) —");
/* La respuesta en vivo difiere del dataset a propósito: pierde al
   Instituto Cultural Amanecer (node/106) y gana una escuela nueva
   (node/108), para poder afirmar que la sesión quedó sustituida. */
const fixtureVivo = { elements: fixtureOverpass.elements.filter(el => el.id !== 106).concat([{
  type: "node", id: 108, lat: 19.4795, lon: -99.2385,
  tags: { amenity: "school", name: "Escuela en Vivo de Prueba", "operator:type": "public" }
}]) };
const llamadasVivo = [];
const domVivo = await cargarPagina("index.html", "", {
  beforeParse(win) {
    win.__urls = [];
    win.fetch = async (url) => {
      const u = String(url);
      win.__urls.push(u);
      if (u.includes("overpass")) {
        llamadasVivo.push(u);
        if (u.includes("overpass-api.de")) throw new TypeError("fallo de red simulado");
        return { ok: true, status: 200, json: async () => fixtureVivo };
      }
      const cuerpo = u.includes("escuelas.json") ? fixtureDataset
        : u.includes("datos-extra.json") ? EXTRA
        : u.includes("eventos.json") ? eventosReales : {};
      return { ok: true, status: 200, json: async () => cuerpo };
    };
  }
});
const wv = domVivo.window;
const tarjetasVivo = () => [...wv.document.querySelectorAll("#lista .tarjeta-est")];
await esperar(() => tarjetasVivo().length >= 6, "la carga inicial pinta las escuelas del dataset");
ok(llamadasVivo.length === 0, "la carga inicial NO tocó Overpass (la fuente primaria es el dataset)");
ok(tarjetasVivo().some(t => t.textContent.includes("Instituto Cultural Amanecer")), "antes de actualizar se ve la escuela que solo está en el dataset (Amanecer)");
wv.document.querySelector("#btnActualizarVivo").click();
await esperar(() => tarjetasVivo().some(t => t.textContent.includes("Escuela en Vivo de Prueba")),
   "tras «Actualizar en vivo», la lista se sustituye con los datos en vivo");
ok(llamadasVivo.length >= 2 &&
   llamadasVivo[0].includes("overpass-api.de") &&
   llamadasVivo[1].includes("overpass.kumi.systems"),
   "se intentó primero overpass-api.de y luego el respaldo kumi.systems, sin intervención del usuario");
ok(!tarjetasVivo().some(t => t.textContent.includes("Instituto Cultural Amanecer")),
   "la escuela que solo estaba en el dataset ya no aparece: la sesión quedó sustituida por lo vivo");
ok(wv.document.querySelector("#estadoBusqueda").textContent.includes("actualizados en vivo"),
   "el estado anuncia los datos actualizados en vivo");
ok(wv.sessionStorage.getItem("serch_overpass_endpoint") === "https://overpass.kumi.systems/api/interpreter",
   "se recuerda en sessionStorage el intérprete que funcionó (kumi.systems)");
ok(JSON.parse(wv.sessionStorage.getItem("serch_resultados")).fuente === "vivo",
   "los resultados guardados en la sesión quedan marcados con fuente «vivo»");
ok(wv.eval("fuenteActual()") === "vivo", "la fuente activa de la sesión es «vivo» tras actualizar");

/* ============ 8. Interruptor de centro: cambian origen y distancias ============ */
console.log("— Interruptor de centro fijo —");
const domCentro = await cargarPagina("index.html", "", {
  beforeParse(win) { stubFetch(win); }
});
const wc = domCentro.window;
await esperar(() => wc.document.querySelectorAll("#lista .tarjeta-est").length >= 6, "el inicio (centro IJEM) pinta las escuelas del radio");
function distanciaEnTarjeta(doc, nombre) {
  const t = [...doc.querySelectorAll("#lista .tarjeta-est")].find(x => x.textContent.includes(nombre));
  const m = t && t.textContent.match(/a ([\d.]+) km/);
  return m ? parseFloat(m[1]) : null;
}
/* «Jardín de Niños Las Flores» (fixture) está pegado al IJEM
   (19.479, -99.240): desde el IJEM son ~0.1 km; desde el Jardín
   de Niños IJEM (19.4941815, -99.2199265) son ~2.5 km. */
const distDesdeIjem = distanciaEnTarjeta(wc.document, "Las Flores");
ok(distDesdeIjem !== null && distDesdeIjem < 0.5, "desde el IJEM, Las Flores está a menos de 0.5 km (fixture: " + distDesdeIjem + " km)");
wc.document.querySelector('#selectorCentro .centro-btn[data-centro="kinder"]').click();
await esperar(() => {
  const d = distanciaEnTarjeta(wc.document, "Las Flores");
  return d !== null && d > 2 && d < 3;
}, "al intercambiar al Jardín de Niños, la distancia de Las Flores se recalcula (≈2.5 km)");
const distDesdeKinder = distanciaEnTarjeta(wc.document, "Las Flores");
ok(distDesdeKinder !== null && Math.abs(distDesdeKinder - 2.5) < 0.3, "la nueva distancia es ≈2.5 km (la del Jardín), no la del IJEM");
ok(wc.sessionStorage.getItem("serch_centro") === "kinder", "el centro activo queda guardado en sessionStorage (serch_centro=kinder)");
const guardadoCentro = JSON.parse(wc.sessionStorage.getItem("serch_resultados"));
ok(guardadoCentro.origen.lat === 19.4941815 && guardadoCentro.origen.lng === -99.2199265 && guardadoCentro.centro === "kinder",
   "la nueva búsqueda se hizo y se guardó desde las coordenadas del Jardín de Niños IJEM");
ok(wc.document.querySelector("#estadoBusqueda").textContent.includes("Jardín de Niños IJEM"), "el estado de la búsqueda nombra el centro elegido");
ok(wc.document.querySelector('#selectorCentro .centro-btn[data-centro="kinder"]').classList.contains("activo"), "el interruptor marca activo «Jardín de Niños» tras el cambio");
ok(wc.eval("centroActivo()") === "kinder" && wc.eval("origen.lat") === 19.4941815, "el origen en memoria es el Jardín de Niños IJEM");

/* ============ 9. Preferencias guardadas (localStorage) ============ */
console.log("— Preferencias guardadas —");
const domPrefs = await cargarPagina("index.html", "", {
  beforeParse(win) { stubFetch(win); }
});
const wp = domPrefs.window;
await esperar(() => wp.document.querySelectorAll("#lista .tarjeta-est").length >= 6, "el inicio sin preferencias pinta las escuelas por defecto");
ok(!!wp.document.querySelector("#btnGuardarPrefs") && !!wp.document.querySelector("#btnRestablecerPrefs"),
   "existen los botones «Guardar preferencias» y «Restablecer» junto a «Buscar escuelas»");
/* Estado NO por defecto: Jardín, 10 km, Primaria, Gratuitas, Mejor fama. */
wp.document.querySelector('#selectorCentro .centro-btn[data-centro="kinder"]').click();
await esperar(() => wp.document.querySelector("#estadoBusqueda").textContent.includes("Se encontraron"),
   "la búsqueda desde el Jardín terminó");
wp.document.querySelector('.chip-radio[data-radio="10"]').click();
await esperar(() => {
  const g = JSON.parse(wp.sessionStorage.getItem("serch_resultados") || "null");
  return g && g.radioKm === 10;
}, "la búsqueda de 10 km quedó guardada en la sesión");
wp.document.querySelector('.nivel-btn[data-nivel="Primaria"]').click();
wp.document.querySelector('.tipo-btn[data-tipo="gratuita"]').click();
wp.document.querySelector('.orden-btn[data-orden="fama"]').click();
wp.document.querySelector("#btnGuardarPrefs").click();
const prefsTxt = wp.localStorage.getItem("serch_preferencias");
ok(!!prefsTxt, "guardar crea la clave serch_preferencias en localStorage");
const prefsObj = JSON.parse(prefsTxt || "{}");
ok(prefsObj.centro === "kinder" && prefsObj.radioKm === 10 && prefsObj.nivel === "Primaria" &&
   prefsObj.tipo === "gratuita" && prefsObj.orden === "fama",
   "lo guardado es el estado elegido (Jardín, 10 km, Primaria, Gratuitas, Mejor fama)");
ok(!("texto" in prefsObj) && !("buscar" in prefsObj) && Object.keys(prefsObj).length === 5,
   "NO se guarda el texto del buscador por nombre (solo centro, radio, nivel, tipo y orden)");
ok(wp.document.querySelector("#btnGuardarPrefs").textContent.includes("guardadas"),
   "el botón confirma en el acto: «Preferencias guardadas ✓», sin alert");

/* «Recarga»: ventana nueva con las preferencias sembradas en
   localStorage; todo debe arrancar aplicado y buscando con ellas. */
const domPrefs2 = await cargarPagina("index.html", "", {
  beforeParse(win) {
    stubFetch(win);
    win.localStorage.setItem("serch_preferencias", prefsTxt);
  }
});
const wp2 = domPrefs2.window;
await esperar(() => wp2.document.querySelector("#estadoBusqueda").textContent.includes("Se encontr"),
   "la recarga corre la búsqueda inicial con las preferencias guardadas");
ok(wp2.sessionStorage.getItem("serch_centro") === "kinder",
   "la preferencia fija el centro inicial de la sesión (serch_centro=kinder)");
ok(wp2.eval("centroActivo()") === "kinder", "el centro activo tras recargar es el Jardín de Niños");
ok(wp2.document.querySelector('#selectorCentro .centro-btn[data-centro="kinder"]').classList.contains("activo"),
   "el interruptor de centro refleja lo guardado");
ok(wp2.document.querySelector('.chip-radio[data-radio="10"]').classList.contains("activo"),
   "el chip de radio refleja los 10 km guardados");
ok(wp2.document.querySelector('.nivel-btn[data-nivel="Primaria"]').classList.contains("activo"),
   "el filtro de nivel refleja «Primaria»");
ok(wp2.document.querySelector('.tipo-btn[data-tipo="gratuita"]').classList.contains("activo"),
   "el filtro de tipo refleja «Gratuitas»");
ok(wp2.document.querySelector('.orden-btn[data-orden="fama"]').classList.contains("activo"),
   "el orden refleja «Mejor fama»");
const g2 = JSON.parse(wp2.sessionStorage.getItem("serch_resultados"));
ok(g2.radioKm === 10 && g2.centro === "kinder",
   "la búsqueda inicial se hizo y se guardó con el radio y el centro de las preferencias");
const visiblesPrefs = [...wp2.document.querySelectorAll("#lista .tarjeta-est")];
ok(visiblesPrefs.length === 1 && visiblesPrefs[0].textContent.includes("Benito Juárez"),
   "con Primaria + Gratuitas aplicadas solo se ve la primaria gratuita del radio (Benito Juárez)");

/* Restablecer: borra la clave y aplica los valores por defecto en el acto. */
wp2.document.querySelector("#btnRestablecerPrefs").click();
ok(wp2.localStorage.getItem("serch_preferencias") === null,
   "restablecer borra la clave serch_preferencias");
await esperar(() => {
  const e = wp2.document.querySelector("#estadoBusqueda").textContent;
  return e.includes("Se encontraron") && e.includes("5 km") && e.includes("Instituto Juventud");
}, "restablecer vuelve a buscar con los valores por defecto (IJEM, 5 km)");
ok(wp2.document.querySelector('#selectorCentro .centro-btn[data-centro="ijem"]').classList.contains("activo"),
   "tras restablecer, el interruptor marca «Instituto Juventud»");
ok(wp2.document.querySelector('.chip-radio[data-radio="5"]').classList.contains("activo"),
   "tras restablecer, el radio vuelve a 5 km");
ok(wp2.document.querySelector('.nivel-btn[data-nivel="Todas"]').classList.contains("activo") &&
   wp2.document.querySelector('.tipo-btn[data-tipo="todas"]').classList.contains("activo") &&
   wp2.document.querySelector('.orden-btn[data-orden="cerca"]').classList.contains("activo"),
   "tras restablecer, nivel, tipo y orden vuelven a los valores por defecto");
ok(wp2.document.querySelectorAll("#lista .tarjeta-est").length === 6,
   "tras restablecer se ven las 6 escuelas del radio por defecto");

/* ============ 10. Dataset caído: los controles se montan igual ============ */
console.log("— Sin dataset: error controlado y controles vivos —");
const domSinDatos = await cargarPagina("index.html", "", {
  beforeParse(win) { stubFetch(win, { datasetFalla: true }); }
});
const wsd = domSinDatos.window;
await esperar(() => wsd.document.querySelector("#estadoBusqueda").textContent.includes("No se pudo cargar el registro"),
   "sin dataset, el error es controlado y se anuncia en la línea de estado");
ok(wsd.document.querySelectorAll("#selectorCentro .centro-btn").length === 2,
   "aunque el dataset falle al cargar, el interruptor renderiza sus dos botones");
ok(wsd.document.querySelector('#selectorCentro .centro-btn[data-centro="kinder"]').textContent.includes("Jardín de Niños"),
   "el botón «Jardín de Niños» está presente sin datos");
ok(wsd.document.querySelectorAll(".chip-radio").length === 6, "los chips de radio también se montan sin datos");
ok(wsd.document.querySelector("#centroActivoTxt").textContent.includes("Instituto Juventud del Estado de México"),
   "la línea de centro activo se pinta aunque no haya datos");
ok(wsd.document.querySelectorAll("#lista .tarjeta-est").length === 0,
   "sin dataset no se pinta ninguna tarjeta: nada inventado");

/* ============ 11. Resumen principal = conteo filtrado; tipo inferido en la lista ============ */
console.log("— Resumen principal y tipo inferido (página) —");
const domRes = await cargarPagina("index.html", "", {
  beforeParse(win) { stubFetch(win); }
});
const wr = domRes.window;
await esperar(() => wr.document.querySelectorAll("#lista .tarjeta-est").length >= 6, "el inicio pinta las 6 escuelas del radio");
const resumenRes = () => wr.document.querySelector("#estadoBusqueda").textContent;
const tarjetasRes = () => [...wr.document.querySelectorAll("#lista .tarjeta-est")];
ok(resumenRes().includes("Se encontraron 6 escuelas"), "sin filtros, el resumen principal dice el total de la búsqueda (6)");
wr.document.querySelector('.nivel-btn[data-nivel="Kinder"]').click();
await new Promise(r => setTimeout(r, 120));
ok(tarjetasRes().length === 2 && resumenRes().includes("Se encontraron 2 escuelas") && !resumenRes().includes("6 escuelas"),
   "al filtrar por nivel Kinder, el resumen principal baja al conteo filtrado (2), igual que la lista");
ok(wr.document.querySelector("#conteo").textContent.includes("2 resultado"), "el contador secundario coincide con el resumen principal (2)");
wr.document.querySelector('.nivel-btn[data-nivel="Todas"]').click();
wr.document.querySelector('.tipo-btn[data-tipo="gratuita"]').click();
await new Promise(r => setTimeout(r, 120));
ok(tarjetasRes().length === 4 && resumenRes().includes("Se encontraron 4 escuelas"),
   "al filtrar por tipo Gratuitas, el resumen principal dice 4 (incluye las gratuitas INFERIDAS del nombre)");
wr.document.querySelector('.tipo-btn[data-tipo="pago"]').click();
await new Promise(r => setTimeout(r, 120));
ok(tarjetasRes().length === 1 && resumenRes().includes("Se encontró 1 escuela") &&
   tarjetasRes()[0].textContent.includes("Secundaria Técnica 45"),
   "al filtrar por tipo De pago, el resumen principal dice 1 y la lista muestra esa escuela");
wr.document.querySelector('.tipo-btn[data-tipo="todas"]').click();
const inputBusc = wr.document.querySelector("#buscar");
inputBusc.value = "benito";
inputBusc.dispatchEvent(new wr.Event("input", { bubbles: true }));
await new Promise(r => setTimeout(r, 120));
ok(tarjetasRes().length === 1 && resumenRes().includes("Se encontró 1 escuela"),
   "al filtrar por nombre, el resumen principal también refleja el conteo filtrado (1)");

/* «Colegio Ejemplo» en el dataset (registro «sin dato»): la app lo
   clasifica pago (inferido) y el filtro «De pago» lo encuentra. */
const datasetColegio = {
  generado: "2026-11-21", total: 8,
  escuelas: fixtureDataset.escuelas.concat([{
    id: "node/201", nombre: "Colegio Ejemplo", nivel: "Primaria",
    tipo: "sindato", tipoTexto: "Tipo sin dato público", lat: 19.4805, lng: -99.2415
  }])
};
const domCol = await cargarPagina("index.html", "", {
  beforeParse(win) { stubFetch(win, { dataset: datasetColegio }); }
});
const wcol = domCol.window;
await esperar(() => wcol.document.querySelectorAll("#lista .tarjeta-est").length >= 7, "el inicio con el dataset ampliado pinta 7 escuelas");
const tarjetaCol = [...wcol.document.querySelectorAll("#lista .tarjeta-est")].find(t => t.textContent.includes("Colegio Ejemplo"));
ok(!!tarjetaCol && tarjetaCol.textContent.includes("De pago (inferido)"),
   "la tarjeta de «Colegio Ejemplo» muestra «De pago (inferido)», con la etiqueta de estimación");
wcol.document.querySelector('.tipo-btn[data-tipo="pago"]').click();
await new Promise(r => setTimeout(r, 120));
const tarjetasPago = [...wcol.document.querySelectorAll("#lista .tarjeta-est")];
ok(tarjetasPago.length === 2 && tarjetasPago.some(t => t.textContent.includes("Colegio Ejemplo")),
   "el filtro «De pago» encuentra al «Colegio Ejemplo» inferido (junto a la de pago declarada)");

/* datos-extra.json manda a nivel página: la Secundaria Técnica 45
   (de pago declarada en el dataset) pasa a gratuita investigada. */
const domExtra = await cargarPagina("index.html", "", {
  beforeParse(win) {
    stubFetch(win, { extra: { "node/103": { tipo: "gratuita", fuente: "https://ejemplo.edu.mx", fecha: "2026-11-22" } } });
  }
});
const wex = domExtra.window;
await esperar(() => wex.document.querySelectorAll("#lista .tarjeta-est").length >= 6, "el inicio (extra de tipo) pinta las escuelas");
const tarjeta103 = [...wex.document.querySelectorAll("#lista .tarjeta-est")].find(t => t.textContent.includes("Secundaria Técnica 45"));
ok(!!tarjeta103 && tarjeta103.textContent.includes("Gratuita (dato investigado)"),
   "la tarjeta de la Técnica 45 muestra el tipo INVESTIGADO, que manda sobre el de pago declarado");
wex.document.querySelector('.tipo-btn[data-tipo="gratuita"]').click();
await new Promise(r => setTimeout(r, 120));
ok([...wex.document.querySelectorAll("#lista .tarjeta-est")].some(t => t.textContent.includes("Secundaria Técnica 45")),
   "con el filtro Gratuitas aparece la Técnica 45 gracias al dato investigado");

console.log("\nResultado: " + pasadas + " pasadas, " + falladas + " falladas");
servidor.close();
process.exit(falladas ? 1 : 0);
