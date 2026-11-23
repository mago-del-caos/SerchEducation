"use strict";
/* ============================================================
   Serch Education — lógica compartida por todas las páginas
   Los datos de escuelas vienen EN VIVO de OpenStreetMap
   (Overpass API): no hay base de datos propia en esta versión.
   Nada se inventa: lo que OSM no trae se muestra como
   «sin dato público».
   ============================================================ */

/* ============================================================
   Centros FIJOS: la ubicación NO es libre ni usa GPS. La app
   mide todo desde uno de dos centros institucionales, entre
   los que se intercambia con el selector de centro:
   - «ijem»:   Instituto Juventud del Estado de México
               (Calzada San Agustín 61, Rincón Echegaray,
               Naucalpan de Juárez).
   - «kinder»: Jardín de Niños IJEM — el plantel de preescolar
               del Instituto (Av. del Paseo 19, Colón de
               Echegaray, Naucalpan; CCT SEP 15PJN1411W).
               Coordenadas del registro del plantel devuelto
               por la búsqueda de Places (browser.search) del
               2026-11-23, corroboradas con el directorio de
               planteles SEP de la misma clave CCT.
   El centro activo se recuerda en sessionStorage
   («serch_centro») y por defecto es el IJEM. La variable
   `origen` sigue siendo el punto desde el que se mide todo:
   siempre es una copia del centro activo.
   ============================================================ */
const CENTROS = {
  ijem: { lat: 19.4785, lng: -99.2396, etiqueta: "Instituto Juventud del Estado de México" },
  kinder: { lat: 19.49411, lng: -99.22223, etiqueta: "Jardín de Niños IJEM" }
};
const CENTRO_DEFECTO = CENTROS.ijem;   // el centro inicial es el IJEM
let claveCentro = (() => {
  try {
    const c = sessionStorage.getItem("serch_centro");
    if (c && CENTROS[c]) return c;
  } catch (e) { /* sin sessionStorage */ }
  return "ijem";
})();
let origen = { ...CENTROS[claveCentro] };
function centroActivo() { return claveCentro; }
function fijarCentro(clave) {
  if (!CENTROS[clave]) return origen;
  claveCentro = clave;
  origen = { ...CENTROS[clave] };
  try { sessionStorage.setItem("serch_centro", clave); } catch (e) { /* sin sessionStorage */ }
  return origen;
}

/* ---------- Selector de centro (control segmentado) ----------
   Lo montan el Inicio y el Mapa. Al cambiar de centro se fija
   el nuevo origen y se avisa con alCambiar() para que la página
   vuelva a buscar, recalcule distancias y redibuje con él. */
function montarSelectorCentro(selector, alCambiar) {
  const cont = typeof selector === "string" ? $(selector) : selector;
  if (!cont) return;
  cont.innerHTML = Object.keys(CENTROS).map(clave =>
    '<button type="button" class="centro-btn' + (clave === claveCentro ? " activo" : "") +
    '" data-centro="' + clave + '" aria-pressed="' + (clave === claveCentro) + '">' +
    (clave === "ijem" ? "Instituto Juventud" : "Jardín de Niños") + "</button>"
  ).join("");
  cont.querySelectorAll(".centro-btn").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.centro === claveCentro) return;
    fijarCentro(b.dataset.centro);
    cont.querySelectorAll(".centro-btn").forEach(x => {
      const activo = x.dataset.centro === claveCentro;
      x.classList.toggle("activo", activo);
      x.setAttribute("aria-pressed", String(activo));
    });
    if (typeof alCambiar === "function") alCambiar(origen);
  }));
}

/* ---------- Utilidades ---------- */
function distanciaKm(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function $(s) { return document.querySelector(s); }
function esc(t) {
  return String(t == null ? "" : t).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function normalizar(t) {
  return String(t == null ? "" : t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function enlaceGoogleMapsEsc(e) {
  return "https://www.google.com/maps/dir/?api=1&destination=" + e.lat + "," + e.lng;
}

/* ============================================================
   OpenStreetMap / Overpass: consulta y clasificación
   ============================================================ */
/* Intérpretes Overpass, en orden de intento: si uno falla (red,
   respuesta no-OK o timeout del cliente), la búsqueda pasa al
   siguiente SIN intervención del usuario; solo si TODOS fallan se
   muestra el error. El endpoint que funcionó se recuerda en
   sessionStorage para intentarlo primero la próxima vez dentro de
   la misma sesión. */
const URLS_OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];
const CLAVE_ENDPOINT_OVERPASS = "serch_overpass_endpoint";
function endpointsOverpass() {
  try {
    const bueno = sessionStorage.getItem(CLAVE_ENDPOINT_OVERPASS);
    if (bueno && URLS_OVERPASS.includes(bueno)) {
      return [bueno, ...URLS_OVERPASS.filter(u => u !== bueno)];
    }
  } catch (e) { /* sin sessionStorage */ }
  return [...URLS_OVERPASS];
}
function recordarEndpointOverpass(url) {
  try { sessionStorage.setItem(CLAVE_ENDPOINT_OVERPASS, url); } catch (e) { /* sin sessionStorage */ }
}
const RADIOS_KM = [1, 3, 5, 10, 20, 50];

/* Consulta Overpass: escuelas y jardines de niños (nodos y vías,
   con centro geométrico) alrededor del origen, en metros. */
function construirConsultaOverpass(lat, lng, radioKm) {
  const m = Math.round(radioKm * 1000);
  return "[out:json][timeout:30];\n" +
    "(\n" +
    '  node["amenity"~"^(school|kindergarten)$"](around:' + m + "," + lat + "," + lng + ");\n" +
    '  way["amenity"~"^(school|kindergarten)$"](around:' + m + "," + lat + "," + lng + ");\n" +
    ");\n" +
    "out center tags;";
}

/* Nivel educativo. OJO: es una HEURÍSTICA a partir de las etiquetas
   de OSM (amenity, isced:level, school:level y el nombre en español);
   no es un dato oficial de la SEP. Cuando no se puede saber, se dice. */
const NIVELES = ["Kinder", "Primaria", "Secundaria", "Preparatoria", "Nivel sin especificar"];
function nivelDesdeEtiquetasNivel(tags) {
  const crudo = tags["isced:level"] || tags["school:level"] || "";
  if (!crudo) return null;
  const t = " " + normalizar(crudo) + " ";
  if (/jardin|kinder|preescolar|preprimary|preschool/.test(t)) return "Kinder";
  if (/primaria|primary/.test(t) && !/secundaria|preparatoria/.test(t)) return "Primaria";
  if (/preparatoria|bachillerato|high school|upper secondary/.test(t)) return "Preparatoria";
  if (/secundaria|secondary|middle/.test(t)) return "Secundaria";
  const nums = new Set((crudo.match(/[0-3]/g) || []).map(Number));
  if (nums.size === 1) {
    const n = [...nums][0];
    return n === 0 ? "Kinder" : n === 1 ? "Primaria" : n === 2 ? "Secundaria" : "Preparatoria";
  }
  return null; // varios niveles en la etiqueta: no se adivina
}
function clasificarNivel(tags) {
  if (tags.amenity === "kindergarten") return "Kinder";
  const porEtiqueta = nivelDesdeEtiquetasNivel(tags);
  if (porEtiqueta) return porEtiqueta;
  // Heurística por el nombre en español (etiqueta como tal en el código).
  const n = " " + normalizar(tags.name || "") + " ";
  if (/jardin de ninos|jardin de infantes|kinder|preescolar|estancia infantil|cendi|caic|guarderia/.test(n)) return "Kinder";
  if (/preparatoria|bachillerato|bachilleres|cch|cbtis|cetis|conalep|cobach| prepa /.test(n)) return "Preparatoria";
  if (/secundaria|telesecundaria/.test(n)) return "Secundaria";
  if (/primaria/.test(n)) return "Primaria";
  return "Nivel sin especificar";
}

/* Pago o gratuita, SOLO desde etiquetas públicas de OSM. */
function clasificarTipo(tags) {
  const ot = normalizar(tags["operator:type"] || "");
  if (ot === "public") return { clave: "gratuita", texto: "Pública (gratuita)" };
  if (ot === "private") return { clave: "pago", texto: "Particular (de pago)" };
  const fee = normalizar(tags.fee || "");
  if (fee === "yes") return { clave: "pago", texto: "De pago (etiqueta fee=yes)" };
  if (fee === "no") return { clave: "gratuita", texto: "Gratuita (etiqueta fee=no)" };
  return { clave: "sindato", texto: "Tipo sin dato público" };
}

function direccionDe(tags) {
  const partes = [];
  if (tags["addr:street"]) partes.push(tags["addr:street"] + (tags["addr:housenumber"] ? " " + tags["addr:housenumber"] : ""));
  if (tags["addr:suburb"]) partes.push(tags["addr:suburb"]);
  if (tags["addr:city"]) partes.push(tags["addr:city"]);
  return partes.length ? partes.join(", ") : null;
}
/* Beneficios y servicios: SOLO lo que traigan las etiquetas de OSM. */
function serviciosDe(tags) {
  const s = [];
  const web = tags.website || tags["contact:website"];
  if (web) s.push({ etiqueta: "Sitio web", valor: web });
  const tel = tags.phone || tags["contact:phone"];
  if (tel) s.push({ etiqueta: "Teléfono", valor: tel });
  if (tags.opening_hours) s.push({ etiqueta: "Horario", valor: tags.opening_hours });
  if (tags.operator) s.push({ etiqueta: "Operador", valor: tags.operator });
  const dir = direccionDe(tags);
  if (dir) s.push({ etiqueta: "Dirección", valor: dir });
  if (tags.sport) s.push({ etiqueta: "Deporte / actividades", valor: tags.sport });
  if (tags.internet_access) s.push({ etiqueta: "Internet", valor: tags.internet_access });
  return s;
}
function costoDe(tags) {
  // Casi ninguna escuela publica su costo en OSM; si no hay etiqueta, no se inventa.
  if (tags.tuition) return tags.tuition;
  if (tags.charge) return tags.charge;
  if (tags.fee) return "Etiqueta fee=" + tags.fee + " en OSM (sin monto publicado)";
  return null;
}

/* Un elemento de Overpass -> escuela normalizada de la app. */
function normalizarEscuela(el) {
  const tags = el.tags || {};
  const lat = typeof el.lat === "number" ? el.lat : (el.center && el.center.lat);
  const lng = typeof el.lon === "number" ? el.lon : (el.center && el.center.lon);
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  const tipo = clasificarTipo(tags);
  return {
    id: el.type + "/" + el.id,
    nombre: tags.name || "Escuela sin nombre en OpenStreetMap",
    nivel: clasificarNivel(tags),
    tipo: tipo.clave,
    tipoTexto: tipo.texto,
    lat, lng,
    dist: null, // se calcula contra el origen al buscar
    direccion: direccionDe(tags),
    website: tags.website || tags["contact:website"] || null,
    telefono: tags.phone || tags["contact:phone"] || null,
    horario: tags.opening_hours || null,
    operador: tags.operator || null,
    costo: costoDe(tags),
    servicios: serviciosDe(tags)
  };
}
function filtrarPorRadio(escuelas, radioKm) {
  return escuelas.filter(e => e.dist !== null && e.dist <= radioKm);
}

/* ---------- Capa de datos investigados (datos-extra.json) ----------
   Archivo del propio repo, investigado a mano por la asistente para
   las escuelas de la zona del IJEM. Clave: el id de OSM («node/123»
   o «way/456»). Campos opcionales: costos (texto), beneficios
   (lista), servicios (lista), fuente (URL) y fecha (AAAA-MM-DD).
   Estos datos tienen PRIORIDAD sobre lo de OpenStreetMap al pintar
   tarjetas y ficha, y se marcan «Dato investigado» con su fuente y
   fecha; lo de OSM queda como registro público. */
let datosExtra = null;   // null = aún no cargado
async function cargarDatosExtra() {
  if (datosExtra !== null) return datosExtra;
  try {
    const r = await fetch("datos-extra.json", { cache: "no-cache" });
    const j = r.ok ? await r.json() : {};
    datosExtra = (j && typeof j === "object" && !Array.isArray(j)) ? j : {};
  } catch (e) { datosExtra = {}; }
  return datosExtra;
}
function aplicarDatosExtra(e, extra) {
  const d = extra && typeof extra === "object" ? extra[e.id] : null;
  if (!d || typeof d !== "object") return e;
  const inv = {};
  if (typeof d.costos === "string" && d.costos.trim()) inv.costos = d.costos.trim();
  if (Array.isArray(d.beneficios)) inv.beneficios = d.beneficios.filter(x => typeof x === "string" && x.trim());
  if (Array.isArray(d.servicios)) inv.servicios = d.servicios.filter(x => typeof x === "string" && x.trim());
  if (typeof d.fuente === "string" && d.fuente.trim()) inv.fuente = d.fuente.trim();
  if (typeof d.fecha === "string" && d.fecha.trim()) inv.fecha = d.fecha.trim();
  if (Array.isArray(d.eventos)) {
    inv.eventos = d.eventos
      .filter(ev => ev && typeof ev === "object" && typeof ev.titulo === "string" && ev.titulo.trim())
      .map(ev => ({
        titulo: ev.titulo.trim(),
        fecha: typeof ev.fecha === "string" && ev.fecha.trim() ? ev.fecha.trim() : null,
        descripcion: typeof ev.descripcion === "string" ? ev.descripcion.trim() : ""
      }));
  }
  if (d.valoracion && typeof d.valoracion === "object") {
    const v = d.valoracion;
    if (typeof v.estrellas === "number" && isFinite(v.estrellas)) {
      inv.valoracion = {
        estrellas: Math.min(5, Math.max(0, v.estrellas)),
        opiniones: typeof v.opiniones === "number" ? v.opiniones : null,
        fuente: typeof v.fuente === "string" && v.fuente.trim() ? v.fuente.trim() : null,
        fecha: typeof v.fecha === "string" && v.fecha.trim() ? v.fecha.trim() : null
      };
    }
  }
  if (inv.costos || (inv.beneficios && inv.beneficios.length) || (inv.servicios && inv.servicios.length) ||
      (inv.eventos && inv.eventos.length) || inv.valoracion) {
    e.investigado = inv;
  }
  return e;
}
/* Estrellas gráficas de una valoración 0–5 (llenas, media, vacías). */
function pintarEstrellas(prom) {
  let html = '<span class="estrellas-ver" role="img" aria-label="' + prom.toFixed(1) + ' de 5 estrellas">';
  for (let i = 1; i <= 5; i++) {
    const resto = prom - (i - 1);
    const clase = resto >= 0.75 ? " llena" : resto >= 0.25 ? " media" : "";
    html += '<span class="est' + clase + '">★</span>';
  }
  return html + "</span>";
}
function iconoDeNivel(nivel) {
  return {
    "Kinder": "assets/icono-kinder.png",
    "Primaria": "assets/icono-primaria.png",
    "Secundaria": "assets/icono-secundaria.png",
    "Preparatoria": "assets/icono-preparatoria.png"
  }[nivel] || "assets/icono-busqueda.png";
}

/* ---------- Búsqueda en vivo (con respaldos automáticos) ---------- */
let resultados = [];
function guardarResultados(radioKm) {
  try {
    sessionStorage.setItem("serch_resultados", JSON.stringify({
      radioKm, centro: claveCentro,
      origen: { lat: origen.lat, lng: origen.lng, etiqueta: origen.etiqueta },
      ts: Date.now(), escuelas: resultados
    }));
  } catch (e) { /* sin sessionStorage: el detalle pedirá buscar de nuevo */ }
}
function cargarResultadosGuardados() {
  try {
    const g = JSON.parse(sessionStorage.getItem("serch_resultados") || "null");
    if (g && Array.isArray(g.escuelas)) { resultados = g.escuelas; return g; }
  } catch (e) { /* nada guardado */ }
  return null;
}
/* Un solo intento contra un intérprete, con timeout del cliente
   (~40 s) vía AbortController. Lanza si falla lo que sea. */
async function consultarEnEndpoint(url, consulta) {
  const ctrl = new AbortController();
  const temporizador = setTimeout(() => ctrl.abort(), 40000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "data=" + encodeURIComponent(consulta),
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error("Overpass respondió " + r.status);
    return await r.json();
  } finally {
    clearTimeout(temporizador);
  }
}
/* Recorre los intérpretes en orden (el que ya funcionó en la sesión
   va primero) y devuelve la primera respuesta buena, recordándola.
   Solo lanza cuando TODOS los respaldos fallaron. */
async function consultarOverpass(consulta) {
  let ultimoError = null;
  for (const url of endpointsOverpass()) {
    try {
      const data = await consultarEnEndpoint(url, consulta);
      recordarEndpointOverpass(url);
      return data;
    } catch (e) {
      ultimoError = e; // este intérprete falló: se pasa al siguiente
    }
  }
  throw ultimoError || new Error("Ningún intérprete Overpass respondió");
}
async function buscarEscuelas(radioKm) {
  const data = await consultarOverpass(construirConsultaOverpass(origen.lat, origen.lng, radioKm));
  const vistas = new Set();
  const lista = [];
  for (const el of (data.elements || [])) {
    const e = normalizarEscuela(el);
    if (!e || vistas.has(e.id)) continue;
    vistas.add(e.id);
    e.dist = distanciaKm(origen.lat, origen.lng, e.lat, e.lng);
    lista.push(e);
  }
  const extra = await cargarDatosExtra();
  lista.forEach(e => aplicarDatosExtra(e, extra));
  resultados = filtrarPorRadio(lista, radioKm).sort((a, b) => a.dist - b.dist);
  guardarResultados(radioKm);
  return resultados;
}
function escuelaPorId(id) {
  if (!resultados.length) cargarResultadosGuardados();
  return resultados.find(e => e.id === String(id)) || null;
}

/* ---------- PWA: registro del service worker ---------- */
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => { /* la app sigue sin SW */ });
  });
}

/* ---------- PWA: botón «Descargar la app» ---------- */
let avisoInstalacion = null;   // evento beforeinstallprompt capturado (Android/Chrome)
let avisoConsumido = false;
window.addEventListener("beforeinstallprompt", ev => {
  ev.preventDefault();
  avisoInstalacion = ev;
});
window.addEventListener("appinstalled", () => {
  avisoInstalacion = null;
  avisoConsumido = true;
});
function appYaInstalada() {
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true;
}
function esIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function hojaInstalar() {
  let hoja = document.getElementById("hojaInstalar");
  if (hoja) return hoja;
  hoja = document.createElement("div");
  hoja.id = "hojaInstalar";
  hoja.className = "hoja-instalar";
  hoja.innerHTML =
    '<div class="hoja-titulo" id="hojaInstalarTitulo"></div>' +
    '<div class="hoja-texto" id="hojaInstalarTexto"></div>' +
    '<button type="button" class="destacado" id="hojaInstalarCerrar">Entendido</button>';
  document.body.appendChild(hoja);
  hoja.querySelector("#hojaInstalarCerrar").addEventListener("click", () => hoja.classList.remove("visible"));
  return hoja;
}
function mostrarHojaInstalar(titulo, html) {
  const hoja = hojaInstalar();
  hoja.querySelector("#hojaInstalarTitulo").textContent = titulo;
  hoja.querySelector("#hojaInstalarTexto").innerHTML = html;
  hoja.classList.add("visible");
}
function accionInstalar() {
  if (appYaInstalada()) {
    mostrarHojaInstalar("Serch Education ya está instalada",
      "Ya tienes Serch Education en tu pantalla de inicio. Ábrela desde ahí: funciona como app, sin navegador.");
    return;
  }
  if (avisoInstalacion) {
    const aviso = avisoInstalacion;
    avisoInstalacion = null;
    avisoConsumido = true;
    aviso.prompt();
    if (aviso.userChoice) aviso.userChoice.catch(() => {});
    return;
  }
  if (esIOS()) {
    mostrarHojaInstalar("Instala Serch Education en tu iPhone",
      "Safari no instala con un solo toque; hazlo así:<br>" +
      "1. Toca el botón <strong>Compartir</strong> (el cuadro con la flecha hacia arriba).<br>" +
      "2. Elige <strong>«Agregar a pantalla de inicio»</strong>.<br>" +
      "3. Toca <strong>«Agregar»</strong> y Serch Education quedará como app en tu pantalla.");
    return;
  }
  if (avisoConsumido) {
    mostrarHojaInstalar("Serch Education ya está instalada",
      "El aviso de instalación ya se usó en este dispositivo: busca Serch Education en tu pantalla de inicio o en tus aplicaciones.");
    return;
  }
  mostrarHojaInstalar("Descarga Serch Education como app",
    "Abre el menú del navegador (<strong>⋮</strong>) y elige <strong>«Instalar app»</strong> o " +
    "<strong>«Agregar a pantalla de inicio»</strong>. Serch Education quedará instalada y abrirá sin navegador.");
}
function initInstalar() {
  document.querySelectorAll(".btn-instalar").forEach(b =>
    b.addEventListener("click", accionInstalar));
}
document.addEventListener("DOMContentLoaded", initInstalar);

/* ---------- Saludo con fecha (encabezado compartido) ---------- */
function initSaludo() {
  const hoy = new Date().toLocaleDateString("es-MX", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });
  const fecha = hoy.charAt(0).toUpperCase() + hoy.slice(1);
  document.querySelectorAll(".fecha-hoy").forEach(el => { el.textContent = fecha; });
}
document.addEventListener("DOMContentLoaded", initSaludo);

/* ---------- Menú desplegable compartido ---------- */
function initMenu() {
  const btn = document.getElementById("btnMenu");
  const nav = document.getElementById("menuNav");
  if (!btn || !nav) return;
  const pagina = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  nav.querySelectorAll("a").forEach(a => {
    if ((a.getAttribute("href") || "").toLowerCase() === pagina) a.classList.add("activo");
  });
  const cerrar = () => { nav.classList.remove("abierto"); btn.setAttribute("aria-expanded", "false"); btn.textContent = "☰"; };
  btn.addEventListener("click", ev => {
    ev.stopPropagation();
    const abierto = nav.classList.toggle("abierto");
    btn.setAttribute("aria-expanded", String(abierto));
    btn.textContent = abierto ? "✕" : "☰";
  });
  document.addEventListener("click", ev => { if (!nav.contains(ev.target)) cerrar(); });
  document.addEventListener("keydown", ev => { if (ev.key === "Escape") cerrar(); });
}
document.addEventListener("DOMContentLoaded", initMenu);

/* ============================================================
   Asistente (chat local en burbuja): responde SOLO con los
   resultados ya cargados de OpenStreetMap. Sin API, sin inventar.
   ============================================================ */
function botResultados() {
  if (!resultados.length) cargarResultadosGuardados();
  return resultados;
}
function botDistanciaTxt(e) {
  return e.dist !== null ? " a " + e.dist.toFixed(1) + " km" : "";
}
function botBuscarEscuela(t) {
  const palabras = new Set(t.split(/[^a-z0-9]+/).filter(Boolean));
  let mejor = null, mejorHits = 0;
  for (const e of botResultados()) {
    const claves = normalizar(e.nombre).split(/[^a-z]+/).filter(w => w.length >= 4);
    const hits = claves.filter(k => palabras.has(k)).length;
    if (hits > mejorHits) { mejorHits = hits; mejor = e; }
  }
  return mejor;
}
function botRespuesta(textoCrudo) {
  const t = " " + normalizar(textoCrudo) + " ";
  const lista = botResultados();

  if (!lista.length) {
    return "Todavía no tengo escuelas cargadas en esta sesión. Ve al <strong>Inicio</strong>, elige un radio " +
      "(1 a 50 km) y toca <strong>«Buscar escuelas»</strong>: consulto OpenStreetMap en vivo y luego sí puedo responderte.";
  }
  const guardado = (() => { try { return JSON.parse(sessionStorage.getItem("serch_resultados") || "null"); } catch (e) { return null; } })();
  const radioTxt = guardado && guardado.radioKm ? " en " + guardado.radioKm + " km" : "";

  /* --- Fama: valoración investigada (SOLO datos-extra.json) --- */
  if (/(fama|valorad|estrella|resena|opinion)/.test(t)) {
    if (/(mejor|mas alta|top|numero uno|destacad)/.test(t)) {
      const conFama = lista.filter(e => e.investigado && e.investigado.valoracion);
      if (!conFama.length) {
        return "Todavía no hay <strong>valoraciones investigadas</strong> para las escuelas cargadas: " +
          "sin dato, y no invento fama. Cuando una escuela tenga valoración en los datos investigados, te digo cuál es la mejor valorada.";
      }
      const mejor = [...conFama].sort((a, b) =>
        b.investigado.valoracion.estrellas - a.investigado.valoracion.estrellas)[0];
      const v = mejor.investigado.valoracion;
      return "La escuela <strong>mejor valorada</strong> según los datos investigados es " +
        "<strong>" + esc(mejor.nombre) + "</strong>: <strong>" + v.estrellas.toFixed(1) + " de 5 estrellas</strong>" +
        (v.opiniones !== null ? ", con " + v.opiniones + " opiniones" : "") +
        (v.fuente ? " (fuente: " + esc(v.fuente) + (v.fecha ? ", consultado el " + esc(v.fecha) : "") + ")" : "") +
        botDistanciaTxt(mejor) + ".";
    }
    const e = botBuscarEscuela(t);
    if (e) {
      const v = e.investigado && e.investigado.valoracion;
      if (!v) {
        return "De <strong>" + esc(e.nombre) + "</strong> no tengo <strong>valoración investigada</strong>: " +
          "sin dato. Solo respondo la fama con lo que trae el archivo de datos investigados; no la invento.";
      }
      return "La fama de <strong>" + esc(e.nombre) + "</strong> según los datos investigados: " +
        "<strong>" + v.estrellas.toFixed(1) + " de 5 estrellas</strong>" +
        (v.opiniones !== null ? ", con " + v.opiniones + " opiniones" : "") +
        (v.fuente ? " (fuente: " + esc(v.fuente) + (v.fecha ? ", consultado el " + esc(v.fecha) : "") + ")" : "") + ".";
    }
    return "¿De qué escuela quieres saber la fama? Dime su nombre, por ejemplo: «¿qué fama tiene…?» con el nombre de la escuela.";
  }

  /* --- Eventos y promociones investigados (SOLO datos-extra.json) --- */
  if (/(evento|promocion|open house|inscripcion)/.test(t)) {
    const conEventos = lista.filter(e => e.investigado && e.investigado.eventos && e.investigado.eventos.length);
    if (!conEventos.length) {
      return "En los <strong>datos investigados</strong> no hay eventos ni promociones registrados para " +
        "las escuelas cargadas. La página de <strong>Eventos y cambios</strong> muestra lo que se vaya " +
        "investigando y los hallazgos de la vigilancia semanal.";
    }
    const items = [];
    for (const e of conEventos) {
      for (const ev of e.investigado.eventos) {
        items.push("<strong>" + esc(e.nombre) + "</strong>: " + esc(ev.titulo) + (ev.fecha ? " (" + esc(ev.fecha) + ")" : ""));
      }
    }
    return "Eventos y promociones investigados de las escuelas cargadas: " + items.slice(0, 8).join(" · ") +
      ". El detalle está en la página de <strong>Eventos y cambios</strong>.";
  }

  /* --- Servicios de una escuela nombrada --- */
  if (/(servicio|beneficio|telefono|sitio web|pagina|horario|ofrece|tiene)/.test(t)) {
    const e = botBuscarEscuela(t);
    if (e) {
      const partes = [];
      if (e.investigado) {
        const inv = [];
        if (e.investigado.costos) inv.push("<strong>Costo:</strong> " + esc(e.investigado.costos));
        if (e.investigado.beneficios && e.investigado.beneficios.length) inv.push("<strong>Beneficios:</strong> " + e.investigado.beneficios.map(esc).join(", "));
        if (e.investigado.servicios && e.investigado.servicios.length) inv.push("<strong>Servicios:</strong> " + e.investigado.servicios.map(esc).join(", "));
        if (inv.length) partes.push("Dato investigado: " + inv.join(" · ") + ".");
      }
      if (e.servicios.length) {
        partes.push("Registro público de OpenStreetMap: " +
          e.servicios.map(s => "<strong>" + esc(s.etiqueta) + ":</strong> " + esc(s.valor)).join(" · ") + ".");
      }
      if (!partes.length) {
        return "De <strong>" + esc(e.nombre) + "</strong> no hay servicios ni beneficios publicados " +
          "ni en OpenStreetMap ni en los datos investigados: sin dato público. Lo que sí sé: es " +
          esc(e.nivel) + ", " + esc(e.tipoTexto.toLowerCase()) + botDistanciaTxt(e) + ".";
      }
      return "Esto es lo que se sabe de <strong>" + esc(e.nombre) + "</strong>: " + partes.join(" ") +
        "Lo que no aparece aquí es sin dato público.";
    }
  }

  /* --- La más cercana --- */
  if (/(cerca|cercana|cercano|proxim)/.test(t)) {
    const e = lista[0]; // los resultados ya vienen ordenados por cercanía
    return "La escuela más cercana desde " + esc(origen.etiqueta) +
      " es <strong>" + esc(e.nombre) + "</strong> (" + esc(e.nivel) + ", " + esc(e.tipoTexto) + ")" +
      botDistanciaTxt(e) + ".";
  }

  /* --- Gratuitas / de pago --- */
  if (/(gratis|gratuita|publica)/.test(t)) {
    const g = lista.filter(e => e.tipo === "gratuita");
    if (!g.length) return "En los resultados cargados" + radioTxt + " ninguna escuela trae etiqueta de pública o gratuita en OpenStreetMap. Ojo: que no traiga la etiqueta no significa que cobre; muchas simplemente no tienen el dato publicado.";
    return "Con etiqueta de <strong>gratuita</strong> hay " + g.length + radioTxt + ". Las más cercanas: " +
      g.slice(0, 5).map(e => "<strong>" + esc(e.nombre) + "</strong> (" + esc(e.nivel) + ")" + botDistanciaTxt(e)).join(", ") + ".";
  }
  if (/(pago|particular|privada|cuesta|costo)/.test(t)) {
    const p = lista.filter(e => e.tipo === "pago");
    if (!p.length) return "En los resultados cargados ninguna escuela trae etiqueta de particular o de pago. Los costos casi nunca se publican en OpenStreetMap: si no hay dato, la ficha dice «sin dato público — consúltalo con la escuela».";
    return "Con etiqueta de <strong>particular (de pago)</strong> hay " + p.length + radioTxt + ". Las más cercanas: " +
      p.slice(0, 5).map(e => "<strong>" + esc(e.nombre) + "</strong> (" + esc(e.nivel) + ")" + botDistanciaTxt(e)).join(", ") +
      ". El monto del costo no se publica en OpenStreetMap: consúltalo con cada escuela.";
  }

  /* --- Por nivel --- */
  const nivelPreg = /kinder|jardin|preescolar/.test(t) ? "Kinder" :
    /primaria/.test(t) ? "Primaria" :
    /secundaria/.test(t) ? "Secundaria" :
    /preparatoria|bachillerato|prepa/.test(t) ? "Preparatoria" : null;
  if (nivelPreg) {
    const del = lista.filter(e => e.nivel === nivelPreg);
    if (!del.length) return "En los resultados cargados" + radioTxt + " no apareció ninguna escuela clasificada como " + nivelPreg + ". Prueba con un radio más grande en el Inicio.";
    return "Hay <strong>" + del.length + "</strong> de nivel " + nivelPreg + radioTxt + ". Las más cercanas: " +
      del.slice(0, 5).map(e => "<strong>" + esc(e.nombre) + "</strong>" + botDistanciaTxt(e)).join(", ") + ".";
  }

  /* --- Cuántas hay --- */
  if (/(cuantas|cuantos|total|numero)/.test(t)) {
    const m = t.match(/(\d+)\s*km/);
    const r = m ? parseInt(m[1], 10) : (guardado && guardado.radioKm);
    const enRadio = r ? lista.filter(e => e.dist !== null && e.dist <= r) : lista;
    const conteo = {};
    for (const e of enRadio) conteo[e.nivel] = (conteo[e.nivel] || 0) + 1;
    return "En " + (r ? r + " km" : "la búsqueda cargada") + " hay <strong>" + enRadio.length + " escuelas</strong>: " +
      Object.keys(conteo).map(n => n + ": " + conteo[n]).join(" · ") + ".";
  }

  /* --- Una escuela nombrada, en general --- */
  const e = botBuscarEscuela(t);
  if (e) {
    return "<strong>" + esc(e.nombre) + "</strong>: " + esc(e.nivel) + ", " + esc(e.tipoTexto) +
      botDistanciaTxt(e) + (e.direccion ? ", " + esc(e.direccion) : "") +
      ". Su costo: " + (e.investigado && e.investigado.costos
        ? esc(e.investigado.costos) + " (dato investigado)"
        : e.costo ? esc(e.costo) : "sin dato público — consúltalo con la escuela") + ".";
  }

  /* --- Saludo / ayuda --- */
  if (/^\s*(hola|buenas|hey|que tal|buenos dias|buenas tardes|buenas noches)\b/.test(t.trim()) ||
      /(ayuda|que puedes|para que sirves|que sabes hacer)/.test(t)) {
    return "¡Hola! Soy el asistente de <strong>Serch Education</strong> y respondo con los resultados " +
      "cargados de OpenStreetMap. Pregúntame <strong>qué primarias hay cerca</strong>, <strong>cuáles son " +
      "gratuitas</strong>, <strong>cuál es la más cercana</strong>, <strong>cuántas escuelas hay</strong> " +
      "o <strong>qué servicios tiene</strong> una escuela por su nombre.";
  }

  /* --- Fuera de tema --- */
  return "Eso todavía no lo sé contestar. Puedo ayudarte con los resultados cargados: escuelas por " +
    "<strong>nivel</strong> (kinder, primaria, secundaria, preparatoria), <strong>gratuitas</strong> o " +
    "<strong>de pago</strong>, la <strong>más cercana</strong>, <strong>cuántas hay</strong> en el radio " +
    "y los <strong>servicios</strong> que OpenStreetMap trae de una escuela. Si no hay dato, te lo digo tal cual.";
}
/* ---------- Interfaz del chat ---------- */
const CHAT_SUGERENCIAS = [
  "¿Qué primarias hay cerca?",
  "¿Cuáles son gratuitas?",
  "¿Cuál es la más cercana?",
  "¿Cuántas escuelas hay?"
];
let chatSaludoMostrado = false;
function chatCrear() {
  if (document.getElementById("chatBurbuja")) return;
  const burbuja = document.createElement("button");
  burbuja.type = "button";
  burbuja.className = "chat-burbuja";
  burbuja.id = "chatBurbuja";
  burbuja.setAttribute("aria-label", "Abrir el asistente de Serch Education");
  burbuja.textContent = "💬";
  document.body.appendChild(burbuja);
  const panel = document.createElement("div");
  panel.className = "chat-panel";
  panel.id = "chatPanel";
  panel.hidden = true;
  panel.innerHTML =
    '<div class="chat-cabeza"><span>Asistente Serch Education</span>' +
    '<button type="button" id="chatCerrar" aria-label="Cerrar el chat">✕</button></div>' +
    '<div class="chat-msjs" id="chatMsjs"></div>' +
    '<div class="chat-chips" id="chatChips">' +
    CHAT_SUGERENCIAS.map(s => '<button type="button" class="chat-chip">' + esc(s) + "</button>").join("") +
    "</div>" +
    '<form class="chat-form" id="chatForm">' +
    '<input type="text" id="chatInput" placeholder="Pregúntame por escuelas, gratuitas, cercanía…" autocomplete="off" aria-label="Escribe tu pregunta">' +
    '<button type="submit" aria-label="Enviar la pregunta">➤</button></form>';
  document.body.appendChild(panel);
  burbuja.addEventListener("click", () => {
    const abierto = panel.hidden;
    panel.hidden = !abierto;
    burbuja.classList.toggle("abierto", abierto);
    if (abierto && !chatSaludoMostrado) {
      chatSaludoMostrado = true;
      chatAgregarMsg("bot", "¡Hola! Soy el asistente de <strong>Serch Education</strong>. Respondo solo con " +
        "los resultados cargados de OpenStreetMap: niveles, gratuitas, cercanía y servicios publicados. " +
        "Toca una sugerencia o escribe tu pregunta.");
    }
    if (abierto) { const inp = document.getElementById("chatInput"); if (inp) inp.focus(); }
  });
  panel.querySelector("#chatCerrar").addEventListener("click", () => {
    panel.hidden = true;
    burbuja.classList.remove("abierto");
  });
  panel.querySelector("#chatForm").addEventListener("submit", ev => {
    ev.preventDefault();
    const inp = document.getElementById("chatInput");
    chatEnviar(inp.value);
    inp.value = "";
  });
  panel.querySelectorAll(".chat-chip").forEach(ch =>
    ch.addEventListener("click", () => chatEnviar(ch.textContent)));
}
function chatAgregarMsg(clase, html) {
  const cont = document.getElementById("chatMsjs");
  if (!cont) return;
  const div = document.createElement("div");
  div.className = "chat-msj " + clase;
  div.innerHTML = html;
  cont.appendChild(div);
  cont.scrollTop = cont.scrollHeight;
}
function chatEnviar(texto) {
  const limpio = String(texto == null ? "" : texto).trim();
  if (!limpio) return;
  chatAgregarMsg("usuario", esc(limpio));
  chatAgregarMsg("bot", botRespuesta(limpio));
}
document.addEventListener("DOMContentLoaded", chatCrear);

/* Exportación para las pruebas con node/jsdom (en el navegador no hace nada). */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    construirConsultaOverpass, clasificarNivel, clasificarTipo, normalizarEscuela,
    filtrarPorRadio, distanciaKm, normalizar, RADIOS_KM, aplicarDatosExtra, CENTRO_DEFECTO,
    CENTROS, fijarCentro, centroActivo, montarSelectorCentro,
    pintarEstrellas, URLS_OVERPASS, endpointsOverpass
  };
}
