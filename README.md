# Serch Education

Buscador de escuelas — kinder, primaria, secundaria y preparatoria — desde los dos centros del IJEM: cuáles son gratuitas y cuáles de pago, qué costos, beneficios y servicios se conocen, su fama según valoraciones públicas, y sus eventos y promociones. Sin base de datos propia: los datos del mapa se consultan **en vivo** en OpenStreetMap, y los datos investigados viven en un archivo del propio repo.

- **Ubicación FIJA, sin GPS:** la app no usa la ubicación del visitante. Todo se mide desde uno de **dos centros institucionales**, intercambiables con un control segmentado («Instituto Juventud» / «Jardín de Niños») en el Inicio y en el Mapa:
  - **Instituto Juventud del Estado de México** (Calzada San Agustín 61, Rincón Echegaray, Naucalpan de Juárez; 19.4785, -99.2396) — el centro por defecto.
  - **Jardín de Niños IJEM** (Av. del Paseo 19, Colón de Echegaray, Naucalpan de Juárez; plantel de preescolar, CCT SEP 15PJN1411W; 19.49411, -99.22223, del registro del plantel en la búsqueda de Places, corroborado con el directorio SEP).
  
  El centro activo se recuerda en la sesión (`sessionStorage`, clave `serch_centro`); al intercambiar se vuelve a buscar con el mismo radio y las distancias se recalculan desde el centro elegido. La **revisión semanal** se mantiene centrada en el IJEM: el Jardín de Niños está a ~2.5 km, **dentro del mismo radio de 10 km** de la foto semanal, así que su zona también queda vigilada.
- **Radios de búsqueda:** 1, 3, 5, 10, 20 y 50 km, con el círculo dibujado en el mapa.
- **Identidad:** águila graduada sobre azul marino profundo (#0d2137 / #132740), celeste y amarillo dorado; los 12 iconos están en `assets/` (recortados de la lámina original del proyecto).

## Páginas

| Página | Qué hace |
|---|---|
| `index.html` | Buscador: selector de centro fijo (Instituto Juventud / Jardín de Niños), chips de radio (1–50 km), filtros por nivel con iconos (Kinder, Primaria, Secundaria, Preparatoria), filtro de tipo (Todas / Gratuitas / De pago / Sin dato), conteo y tarjetas ordenables por **cercanía** o por **mejor fama**. Junto a «Buscar escuelas», los botones **«Guardar preferencias»** y **«Restablecer»** (ver la sección siguiente). |
| `mapa.html` | Leaflet con la marca del centro elegido (punto azul pulsante cuyo popup dice la etiqueta del centro), el **círculo del radio seleccionado** y marcadores por nivel (popup con nombre, nivel, tipo y distancia); el mismo selector de centro mueve la marca y el círculo y vuelve a buscar. |
| `escuela.html` | Ficha de la escuela (vive de la búsqueda guardada en la sesión): nivel, tipo, costo, datos públicos de OSM y, si existen, los **datos investigados** con su sección de **Fama** (estrellas) y de **Eventos y promociones**. |
| `eventos.html` | Dos bloques: los **eventos investigados** de `datos-extra.json`, agrupados por escuela con su fecha de consulta, y los **hallazgos de la vigilancia semanal** de `eventos.json`. |
| `acerca.html` | Cómo funciona, fuentes y límites honestos de los datos. |

Todas las páginas comparten menú desplegable, botón «Descargar la app» (PWA: `manifest.json` + `sw.js`, caché `serch-v4`) y el **asistente en burbuja**: un chatbot local, sin API, que responde solo con los resultados cargados («¿qué primarias hay cerca?», «¿cuáles son gratuitas?», «¿cuál es la más cercana?», «¿cuántas hay en 5 km?», «¿qué servicios tiene…?», «¿qué fama tiene…?», «¿cuál es la mejor valorada?», «¿qué eventos hay?»).

## Preferencias guardadas

El Inicio tiene dos botones junto a «Buscar escuelas»:

- **«Guardar preferencias»** — deja fijos el **centro** (Instituto Juventud / Jardín de Niños), el **radio** (1–50 km), el **nivel**, el **tipo** y el **orden** tal como están en ese momento. Al guardar, el propio botón confirma con «Preferencias guardadas ✓» durante un par de segundos (sin ventanas emergentes).
- **«Restablecer»** — borra lo guardado y aplica **en el acto** los valores por defecto (Instituto Juventud, 5 km, nivel Todas, tipo Todas, orden Cercanía), volviendo a buscar con ellos.

**Dónde se guardan:** en el `localStorage` del navegador del visitante, clave `serch_preferencias`, como un objeto `{centro, radioKm, nivel, tipo, orden}`. Es persistente **entre sesiones** — a diferencia del centro de sesión (`serch_centro`) y los filtros de sesión (`serch_filtros`), que viven en `sessionStorage` y mueren al cerrar la pestaña. El **texto del buscador por nombre NO se guarda**: es una búsqueda del momento, no una preferencia.

**Aplicación automática:** al abrir la app, si hay preferencias guardadas…

1. El Inicio arranca con ellas: el interruptor de centro, los chips de radio y los botones de nivel, tipo y orden quedan reflejando lo guardado, y la **búsqueda inicial corre con esos valores** (mandan sobre los filtros de la sesión anterior).
2. El **Mapa** respeta el centro guardado — este fija el centro inicial de la sesión al cargar la app — y el **radio** guardado: si la última búsqueda de la sesión se hizo con otro radio, se descarta y se vuelve a buscar con el de la preferencia, para que el círculo y las escuelas cuadren.

Cada campo se valida al leerlo (centro contra los dos centros fijos, radio contra 1/3/5/10/20/50, nivel, tipo y orden contra sus valores posibles); lo que no cuadre cae a su valor por defecto. Sin preferencias guardadas, la app se comporta como siempre: valores por defecto y filtros recordados solo durante la sesión.

## Fuente de datos principal: OpenStreetMap (en vivo)

El navegador consulta la **Overpass API** con `amenity=school` y `amenity=kindergarten` (nodos y vías, `out center tags`) alrededor del centro fijo elegido y el radio seleccionado.

**Respaldos automáticos:** la consulta no depende de un solo servidor. Hay una lista ordenada de intérpretes Overpass — `overpass-api.de`, `overpass.kumi.systems` y `overpass.private.coffee` — y la búsqueda los intenta en orden: si uno falla (red, respuesta no-OK o timeout del cliente a los ~40 s), pasa al siguiente sin que el usuario haga nada; el error solo aparece si fallan **todos**. El intérprete que funcionó se recuerda en la sesión (`sessionStorage`) y se intenta primero la próxima vez. La revisión semanal (`tools/snapshot.py`) usa la misma lista y el mismo orden de respaldo.

- **Nivel educativo** — *heurística*, no dato oficial: `amenity=kindergarten` → Kinder; etiquetas `isced:level` / `school:level`; y el nombre en español («jardín de niños», «primaria», «secundaria», «preparatoria», «CBTis», «Conalep»…). Si no se puede saber: **«Nivel sin especificar»**.
- **Pago / gratuita** — `operator:type=public` → «Pública (gratuita)»; `=private` → «Particular (de pago)»; etiqueta `fee` si existe; si no hay dato: **«Tipo sin dato público»**.
- **Costos** — casi nunca están en OSM. Sin etiqueta ni investigación: **«Costo: sin dato público — consúltalo con la escuela»**.
- **Beneficios y servicios** — solo lo que traigan las etiquetas (`website`, `phone`, `opening_hours`, `operator`, `addr:*`, `sport`…). **Nada se inventa.**

## Capa de datos investigados: `datos-extra.json`

Archivo del propio repo con lo que la asistente investiga a mano para las escuelas de la zona del IJEM. Es un **objeto cuya clave es el id de OSM** de la escuela (`"node/123"` o `"way/456"`, el mismo que muestra su ficha). Todos los campos son **opcionales**:

```json
{
  "node/123456": {
    "costos": "Colegiatura mensual de $2,800 MXN; inscripción de $4,500 MXN (ciclo 2026-2027).",
    "beneficios": ["Comedor escolar", "Beca de excelencia del 50% a promedios de 9.5+"],
    "servicios": ["Transporte escolar", "Horario extendido hasta las 18:00", "Inglés diario"],
    "eventos": [
      { "titulo": "Open house", "fecha": "2026-12-05", "descripcion": "Recorrido y clase muestra; registro en su sitio web." },
      { "titulo": "20% en inscripción", "fecha": "diciembre 2026", "descripcion": "Promoción por pronto pago." }
    ],
    "valoracion": { "estrellas": 4.6, "opiniones": 230, "fuente": "Google", "fecha": "2026-11-20" },
    "fuente": "https://www.ejemplo.edu.mx/",
    "fecha": "2026-11-20"
  }
}
```

| Campo | Tipo | Significado |
|---|---|---|
| `costos` | texto | Costos conocidos (colegiatura, inscripción…), en texto libre. |
| `beneficios` | array de textos | Beneficios: becas, comedor, programas, etc. |
| `servicios` | array de textos | Servicios: transporte, horario extendido, idiomas, etc. |
| `eventos` | array de objetos | Eventos y promociones vigentes o próximos: `{titulo, fecha (texto o AAAA-MM-DD, opcional), descripcion}`. |
| `valoracion` | objeto | La «fama» según sus valoraciones públicas: `{estrellas (número 0–5), opiniones (número de reseñas), fuente (URL o nombre, ej. «Google»), fecha}`. |
| `fuente` | URL o texto | De dónde salió la investigación de esta escuela. |
| `fecha` | `AAAA-MM-DD` | Fecha en que se consultó/investigó. |

**Reglas de presentación:**

- Al pintar tarjetas y ficha, el dato investigado tiene **prioridad** sobre el de OpenStreetMap.
- Lo investigado se marca **«Dato investigado»** con su fuente y fecha; lo de OSM se marca como **registro público**.
- Si una escuela no tiene ni OSM ni investigación en un campo, se mantiene **«sin dato público»**. Nunca se rellena con suposiciones.
- La ficha muestra la sección **«Fama»** (estrellas pintadas, opiniones, fuente y fecha) y la sección **«Eventos y promociones»** cuando existen; las tarjetas muestran la fama compacta (★ 4.6 · 230 opiniones) y el orden **«Mejor fama»** del inicio ordena por esas estrellas (sin valoración, al final).
- La página de eventos lista los `eventos` investigados agrupados por escuela, con la fecha de consulta de cada entrada.

En el repo, `datos-extra.json` arranca como un objeto vacío (`{}`) válido: se va llenando conforme se investigan escuelas.

## Vigilancia semanal: `eventos.json` + `tools/snapshot.py`

`eventos.json` es el registro de hallazgos de la revisión semanal (array de `{fecha, escuela, tipo, descripcion, fuente}`; tipo: `evento`, `promoción`, `cambio de costo`, `cambio de datos`, `vigilancia`…). La página de eventos lo pinta tal cual.

`tools/snapshot.py` (Python, **solo biblioteca estándar**, sin tokens) es el vigilante:

```bash
python3 tools/snapshot.py
```

1. Consulta Overpass para el centro del IJEM en **10 km** (el Jardín de Niños IJEM queda dentro de ese mismo radio, a ~2.5 km, así que la foto cubre ambos centros).
2. Normaliza (id OSM, nombre, nivel, tipo, website, teléfono), ordenado por id.
3. Compara contra `tools/snapshot.json`: imprime **solo** las diferencias (`ALTA`, `BAJA`, `CAMBIO campo «antes» -> «después»`) y actualiza la foto. **Sin cambios no imprime nada** — pensado para correr en silencio y gastar cero tokens, como el vigilante de precios de Gasapp; cuando imprime cambios, esos renglones son los que se anotan en `eventos.json`.
4. La primera corrida guarda la foto inicial y lo dice en una línea.

Para probarlo sin red: `python3 tools/snapshot.py --desde-archivo respuesta.json --foto /tmp/foto.json`.

## Publicar en GitHub Pages

1. Sube todo el contenido de esta carpeta a la raíz del repositorio (público).
2. En el repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, rama `main`, carpeta `/ (root)`.
3. La app queda en `https://<usuario>.github.io/<repo>/`. Es 100% estática: no hay servidor ni claves; Overpass se consulta desde el navegador del visitante.

## Pruebas

Con Node y jsdom (fixture local de Overpass, sin red real):

```bash
cd tests
npm install   # solo la primera vez (instala jsdom)
node test-serch.mjs
```

La suite verifica: la consulta se construye con el radio pedido; el clasificador de nivel acierta los casos típicos (kinder por nombre, primaria, secundaria, preparatoria, `amenity=kindergarten`, sin especificar, CBTis); el tipo público/privado/sin dato; el filtro por radio descarta una escuela lejana; el centro por defecto es el IJEM y el otro centro fijo es el Jardín de Niños IJEM; **no existe ningún botón de GPS** («Usar mi ubicación» / «Mi ubicación») ni la función de geolocalización; **el interruptor de centro cambia el origen de la búsqueda y de las distancias** (una escuela pegada al IJEM pasa de ~0.1 km a ~2.5 km al intercambiar al Jardín, y la búsqueda queda guardada con las coordenadas del Jardín); la fusión con `datos-extra.json` muestra la fama en la ficha (4.6 → 4 estrellas llenas y 1 media) y en la tarjeta; el orden «Mejor fama» funciona; el bot responde la fama, la mejor valorada y los eventos; el círculo del mapa usa el radio elegido (5 km → 5000 m; al cambiar a 10 km, 10000 m); `eventos.html` pinta `eventos.json` y los eventos investigados agrupados por escuela; y **las preferencias guardadas**: guardar desde un estado no por defecto (Jardín, 10 km, Primaria, Gratuitas, Mejor fama) escribe la clave `serch_preferencias` sin el texto del buscador, una «recarga» con esa clave sembrada arranca con todos los controles reflejándola, el centro de sesión fijado por la preferencia y la búsqueda inicial hecha con radio y centro guardados (con Primaria + Gratuitas solo se ve la primaria gratuita del radio), y «Restablecer» borra la clave y vuelve a los valores por defecto aplicándolos en el acto.
