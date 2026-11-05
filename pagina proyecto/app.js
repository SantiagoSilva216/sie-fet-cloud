// ============================================================
//  app.js  –  Lógica del Sistema S.I.E - FET  (versión 1.1)
//  Conectado al backend Flask (server.py)
//  Autores: Ordoñez, Cardoso, Serrato — FET 2026
//  Licencia Privativa
// ============================================================

// ── URL del backend en Render (TiDB Cloud + Flask) ──
const API_BASE = 'https://sistema-fet-backend.onrender.com';

// ── Seguridad: token de sesión SOLO en memoria (no se guarda en el navegador) ──
let authToken = null;
let rolActual = null;
const ROLES_ADMIN = ['administrador', 'administradora', 'admin', 'administrator', 'superadmin'];

/** Igual que es_admin() del servidor: no distingue mayúsculas ni espacios. */
function esAdmin(rol) {
    return ROLES_ADMIN.includes(String(rol ?? '').trim().toLowerCase());
}

/** Normaliza el tag igual que el servidor: sin espacios, ':' ni '-', en MAYÚSCULAS. */
function normalizarTag(v) {
    return String(v ?? '').replace(/[\s:\-]/g, '').toUpperCase();
}

/** Lee la respuesta como JSON aunque el servidor devuelva otra cosa (p. ej. Render arrancando). */
function leerJson(res) {
    return res.json().catch(() => ({})).then(data => {
        if (res.status === 429 && !data.error) data.error = 'Demasiados intentos. Espere unos minutos.';
        if (res.status === 403 && !data.error) data.error = 'Permisos insuficientes.';
        if (res.status >= 500 && !data.error) data.error = 'Error interno del servidor.';
        return { status: res.status, data };
    });
}

/** Muestra u oculta las acciones que solo puede hacer el Administrador. */
function aplicarPermisos() {
    document.body.classList.toggle('rol-consulta', !esAdmin(rolActual));
}

/** Escapa texto antes de insertarlo con innerHTML (evita XSS). */
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/** fetch que adjunta el token y cierra la sesión si el servidor responde 401. */
function apiFetch(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
    return fetch(API_BASE + path, Object.assign({}, opts, { headers })).then(res => {
        if (res.status === 401 && authToken) sesionExpirada();
        return res;
    });
}

function sesionExpirada() {
    authToken = null;
    salirSistema();
    mostrarToast('Su sesión expiró. Inicie sesión de nuevo.', 'danger');
}

// ── Aplicar tema guardado ANTES del primer render (evita flash) ──
(function aplicarTemaGuardado() {
    const temaGuardado = localStorage.getItem('fet-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', temaGuardado);
    // Los iconos se sincronizan despues del DOMContentLoaded
})();

// ── Estado global ──
let aforoMaximo       = leerAforoGuardado();
let historialCompleto = [];
let pollingInterval   = null;   // lecturas (cada 1 s, meta RNF01 < 1 s)
let statsInterval     = null;   // contadores (cada 3 s)
let estadoInterval    = null;   // estado de servicios (cada 60 s)
let cargandoRegistros = false;  // evita peticiones encimadas si Render tarda
let fallosSeguidos    = 0;      // para mostrar "Sin conexión" en el encabezado
const INTERVALO_LECTURAS_MS = 1000;
const INTERVALO_STATS_MS    = 3000;
let monitorPausado    = false;
let clearId           = 0;  // ID del ultimo registro al momento de limpiar (marca de agua)
let lastNotifiedId    = 0;  // ID del ultimo registro para el que se mostro notificacion
let firstPollDone     = false; // true tras el primer ciclo de polling (evita notificar historico)

/** Aforo máximo guardado en este navegador (antes se perdía al recargar). */
function leerAforoGuardado() {
    try {
        const v = parseInt(localStorage.getItem('fet-aforo-max'), 10);
        return v > 0 ? v : 150;
    } catch (e) { return 150; }
}

// ============================================================
//  LOGIN / LOGOUT
// ============================================================

/**
 * Autentica contra el endpoint POST /api/login
 * que valida usuario + clave con hash SHA-256 en MySQL.
 */
function entrarSistema(e) {
    e.preventDefault();
    const usuario = document.getElementById('input-usuario').value.trim();
    const clave   = document.getElementById('input-clave').value;
    const btn     = document.getElementById('btn-login');

    if (!usuario || !clave) {
        mostrarToast('Complete ambos campos.', 'danger');
        return;
    }

    // Animacion de carga
    btn.disabled = true;
    btn.querySelector('.btn-text').textContent = 'Verificando...';

    fetch(API_BASE + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario: usuario, clave: clave })
    })
    .then(leerJson)
    .then(({ status, data }) => {
        if (status === 200 && data.usuario && data.token) {
            authToken = data.token;
            rolActual = data.rol || null;
            aplicarPermisos();
            // Login exitoso
            const nombreSidebar = document.getElementById('sidebar-username');
            if (nombreSidebar) {
                nombreSidebar.textContent = data.usuario.charAt(0).toUpperCase() + data.usuario.slice(1);
            }
            const rolEl = document.querySelector('.user-role');
            if (rolEl && data.rol) {
                rolEl.textContent = data.rol;
            }

            const loginScreen = document.getElementById('login-screen');
            loginScreen.style.opacity = '0';
            setTimeout(() => {
                loginScreen.style.display = 'none';
                document.getElementById('app-layout').style.display = 'flex';
                iniciarMonitor();
            }, 700);
        } else {
            // Login fallido
            btn.disabled = false;
            btn.querySelector('.btn-text').textContent = 'Iniciar Sesión';
            mostrarToast(data.error || 'Credenciales incorrectas.', 'danger');
            shakeLogin();
        }
    })
    .catch(err => {
        btn.disabled = false;
        btn.querySelector('.btn-text').textContent = 'Iniciar Sesión';
        mostrarToast('No hay conexión con el servidor. Si es la primera vez del día, espere 30 s y reintente.', 'danger');
        shakeLogin();
        console.error('Login error:', err);
    });
}

function shakeLogin() {
    const box = document.querySelector('.login-box');
    box.style.animation = 'none';
    void box.offsetWidth;
    box.style.animation = 'shake 0.4s ease';
}

function salirSistema() {
    authToken = null;
    rolActual = null;
    // Detener polling
    [pollingInterval, statsInterval, estadoInterval].forEach(i => { if (i) clearInterval(i); });
    pollingInterval = statsInterval = estadoInterval = null;
    monitorPausado  = false;
    clearId         = 0;
    lastNotifiedId  = 0;   // resetear al cerrar sesion
    firstPollDone   = false;
    cerrarSidebar(); // cerrar sidebar móvil si estaba abierto
    document.getElementById('app-layout').style.display = 'none';
    const loginScreen = document.getElementById('login-screen');
    loginScreen.style.display  = 'flex';
    loginScreen.style.opacity  = '0';
    document.getElementById('input-usuario').value = '';
    document.getElementById('input-clave').value   = '';
    document.getElementById('btn-login').disabled  = false;
    document.getElementById('btn-login').querySelector('.btn-text').textContent = 'Iniciar Sesión';
    setTimeout(() => { loginScreen.style.opacity = '1'; }, 50);
    mostrarToast('Sesión cerrada correctamente.', 'ok');
}

// ============================================================
//  SIDEBAR MÓVIL — hamburguesa / cajero deslizante
// ============================================================

/**
 * Abre el sidebar como panel deslizante (sólo activo en móvil ≤768px).
 * En escritorio no hace nada (el sidebar siempre es visible).
 */
function abrirSidebar() {
    const sidebar  = document.getElementById('sidebar');
    const overlay  = document.getElementById('sidebar-overlay');
    if (!sidebar || !overlay) return;
    sidebar.classList.add('sidebar-open');
    overlay.classList.add('visible');
    document.body.classList.add('sidebar-is-open');
    // Actualizar aria-expanded en todos los botones hamburguesa
    document.querySelectorAll('.btn-hamburger').forEach(b => b.setAttribute('aria-expanded', 'true'));
}

/**
 * Cierra el sidebar móvil.
 */
function cerrarSidebar() {
    const sidebar  = document.getElementById('sidebar');
    const overlay  = document.getElementById('sidebar-overlay');
    if (!sidebar || !overlay) return;
    sidebar.classList.remove('sidebar-open');
    overlay.classList.remove('visible');
    document.body.classList.remove('sidebar-is-open');
    document.querySelectorAll('.btn-hamburger').forEach(b => b.setAttribute('aria-expanded', 'false'));
}

// ============================================================
//  NAVEGACION ENTRE VISTAS
// ============================================================

function cambiarVista(idVista, btnElement) {
    document.querySelectorAll('.nav-btn').forEach(b => {
        b.classList.remove('active');
        b.removeAttribute('aria-current');
    });
    document.querySelectorAll('.view-section').forEach(v => v.classList.remove('active'));
    btnElement.classList.add('active');
    btnElement.setAttribute('aria-current', 'page');
    document.getElementById('vista-' + idVista).classList.add('active');

    // En móvil cerrar el sidebar al navegar
    if (window.innerWidth <= 768) cerrarSidebar();

    if (idVista === 'reportes') sincronizarReportes();
    if (idVista === 'estudiantes') cargarEstudiantesDesdeAPI();
    if (idVista === 'configuracion') comprobarEstado(false);
}

// ============================================================
//  MONITOREO EN VIVO — con polling al backend
// ============================================================

function iniciarMonitor() {
    historialCompleto = [];
    lastNotifiedId    = 0;
    firstPollDone     = false;
    actualizarEstadoPuerto();

    actualizarBarraAforo(0);
    renderizarMediciones();

    // Cargar datos iniciales desde el backend
    cargarEstadisticas();
    cargarUltimosRegistros();
    comprobarEstado(false);

    // Lecturas cada 1 s (meta < 1 s entre lectura y pantalla); contadores cada 3 s
    [pollingInterval, statsInterval, estadoInterval].forEach(i => { if (i) clearInterval(i); });
    pollingInterval = setInterval(cargarUltimosRegistros, INTERVALO_LECTURAS_MS);
    statsInterval   = setInterval(cargarEstadisticas, INTERVALO_STATS_MS);
    estadoInterval  = setInterval(() => comprobarEstado(false), 60000);
}

/**
 * Consulta GET /api/stats para obtener aforo, ingresos y alertas
 */
function cargarEstadisticas() {
    apiFetch('/api/stats')
    .then(res => res.json())
    .then(data => {
        if (typeof data.aforo !== 'number') return;
        const aforoEl   = document.getElementById('aforo');
        const ingresosEl = document.getElementById('ingresos');
        const alertasEl  = document.getElementById('alertas');

        const aforoAnterior = parseInt(aforoEl.innerText.replace(/,/g, '')) || 0;

        aforoEl.innerText    = (data.aforo || 0).toLocaleString();
        ingresosEl.innerText = (data.ingresos || 0).toLocaleString();
        alertasEl.innerText  = (data.alertas || 0).toLocaleString();

        // Animar si cambio
        if (data.aforo !== aforoAnterior) {
            animarContador(aforoEl);
            animarContador(ingresosEl);
        }

        actualizarBarraAforo(data.aforo || 0);
        actualizarBadgeAlertas(data.alertas || 0);
    })
    .catch(err => console.error('Error cargando stats:', err));
}

/**
 * Consulta GET /api/ultimos-registros para llenar la tabla de monitoreo.
 * Solo muestra registros posteriores al clearTimestamp (si existe).
 * Detecta registros NUEVOS en cada ciclo de polling y muestra notificacion con nombre.
 */
function cargarUltimosRegistros() {
    if (monitorPausado || cargandoRegistros || !authToken) return;
    cargandoRegistros = true;
    const tEnvio = performance.now();
    apiFetch('/api/ultimos-registros')
    .then(res => res.json())
    .then(registrosRaw => {
        const tRespuesta = performance.now();
        if (!Array.isArray(registrosRaw)) { marcarConexion(false); return; }  // 401/500: no tocar la tabla
        marcarConexion(true);
        // ── NOTIFICACIONES DE INGRESO / SALIDA ──
        // En el primer ciclo solo guardamos el watermark sin notificar (historial existente).
        if (!firstPollDone) {
            if (registrosRaw.length > 0) {
                lastNotifiedId = Math.max(...registrosRaw.map(r => r.id || 0));
                mostrarUltimaLectura(registrosRaw[0], null, null);  // sin medir: ya existía
            }
            firstPollDone = true;
        } else {
            // Detectar registros con id mayor al ultimo notificado
            const nuevos = registrosRaw
            .filter(r => (r.id || 0) > lastNotifiedId)
            .reverse(); // mostrar en orden cronologico (el mas antiguo primero)
    nuevos.forEach(reg => {
        mostrarNotificacionAcceso(reg);
    });
    if (nuevos.length) {
        mostrarUltimaLectura(nuevos[nuevos.length - 1], tEnvio, tRespuesta);
    }
    if (registrosRaw.length > 0) {
        const maxId = Math.max(...registrosRaw.map(r => r.id || 0));
        if (maxId > lastNotifiedId) lastNotifiedId = maxId;
    }
        }

        // ── FILTRADO Y TABLA ──
        let registros = registrosRaw;
        const tabla  = document.getElementById('tabla-registros');
        const sinReg = document.getElementById('sin-registros');
        const contEl = document.getElementById('table-count');

        // Filtrar: solo mostrar registros con id > clearId (marca de agua)
        if (clearId > 0) {
            registros = registros.filter(reg => (reg.id || 0) > clearId);
        }

        if (!registros || registros.length === 0) {
            tabla.innerHTML = '';
            sinReg.style.display = 'flex';
            contEl.textContent = '0 registros';
            return;
        }

        sinReg.style.display = 'none';
        contEl.textContent = `${registros.length} registro${registros.length !== 1 ? 's' : ''}`;

        tabla.innerHTML = '';
        registros.forEach(reg => {
            const idEnmascarado = enmascararId(reg.idEstudiante || reg.documento || '0000');
            // Badge: INGRESO=verde, SALIDA=outline verde, DENEGADO=blanco
            const badgeClass = reg.estado === 'INGRESO'    ? 'badge ok'
            : reg.estado === 'AUTORIZADO' ? 'badge ok'    // legacy
            : reg.estado === 'SALIDA'     ? 'badge salida'
            : 'badge warn';
            const hora = reg.fecha_hora || '';

            const tr = document.createElement('tr');
            tr.className = 'new-row';
            tr.dataset.recordId = reg.id || 0;
            tr.innerHTML = `
            <td style="color:var(--text-muted);font-family:'JetBrains Mono',monospace;font-size:.85rem;">${esc(hora)}</td>
            <td style="font-family:'JetBrains Mono',monospace;letter-spacing:1px;color:var(--text-sub);">${idEnmascarado}</td>
            <td class="rfid-tag">${esc(reg.rfid_tag || '')}</td>
            <td><span class="${badgeClass}">${esc(reg.estado)}</span>${
                reg.estado === 'DENEGADO' && !reg.nombre_estudiante && reg.rfid_tag
                ? ` <button class="btn-table-action solo-admin" data-tag="${esc(reg.rfid_tag)}" onclick="cambiarVista('estudiantes', document.getElementById('nav-estudiantes')); abrirModalAsignar(this.dataset.tag)" title="Registrar esta tarjeta a un estudiante">Asignar</button>`
                : reg.estado === 'DENEGADO' && reg.nombre_estudiante
                ? ` <span style="color:var(--text-muted);font-size:.8rem;">${esc(reg.nombre_estudiante)} (suspendido)</span>`
                : ''
            }</td>
            `;
            tabla.appendChild(tr);
        });

        // Actualizar historial para reportes
        historialCompleto = registros.map(r => ({
            dbId: r.id || 0,
            hora: r.fecha_hora || '',
            id: r.idEstudiante || r.documento || '0000',
            tag: r.rfid_tag || '',
            estado: r.estado || ''
        }));
    })
    .catch(err => {
        marcarConexion(false);
        console.error('Error cargando registros:', err);
    })
    .finally(() => { cargandoRegistros = false; });
}

/** Encabezado del monitoreo y del menú: muestra si de verdad hay conexión con el servidor. */
function marcarConexion(ok) {
    fallosSeguidos = ok ? 0 : fallosSeguidos + 1;
    const el    = document.getElementById('estado-puerto');
    const brand = document.getElementById('brand-status-text');
    const caido = fallosSeguidos >= 3;   // 3 fallos seguidos (~3 s) antes de alarmar
    document.body.classList.toggle('sin-conexion', caido);
    if (el) {
        el.innerHTML = caido
        ? '<span class="dot-live dot-off" aria-hidden="true"></span> Sin conexión con el servidor. Reintentando...'
        : '<span class="dot-live" aria-hidden="true"></span> En línea · recibiendo lecturas del lector ESP32 por WiFi';
    }
    if (brand) brand.textContent = caido ? 'Sin conexión' : 'Sistema en Línea';
}

/**
 * Tarjeta grande con la última lectura (legible desde la portería) y, si la lectura
 * llegó mientras el panel estaba abierto, cuánto tardó en verse (prueba de rendimiento, OE1).
 *   latencia = tiempo que la lectura llevaba en el servidor + mitad del viaje de red + dibujo
 */
function mostrarUltimaLectura(reg, tEnvio, tRespuesta) {
    const estado = reg.estado === 'AUTORIZADO' ? 'INGRESO' : (reg.estado || '');
    const caja   = document.getElementById('ultima-lectura');
    const est    = document.getElementById('ul-estado');
    const nom    = document.getElementById('ul-nombre');
    const det    = document.getElementById('ul-detalle');
    const lat    = document.getElementById('ul-latencia');
    if (!caja) return;

    const clase = estado === 'INGRESO' ? 'ul-ingreso' : estado === 'SALIDA' ? 'ul-salida' : 'ul-denegado';
    est.className = 'ul-estado ' + clase;
    est.textContent = estado === 'DENEGADO' ? 'DENEGADO' : estado;
    let nombre = reg.nombre_estudiante || 'Tarjeta no registrada';
    if (estado === 'DENEGADO' && reg.nombre_estudiante) nombre += ' (suspendido)';
    nom.textContent = nombre;
    det.textContent = `${(reg.fecha_hora || '').split(' ').pop()} · ID ${enmascararId(reg.idEstudiante || '0000')} · Tag ${reg.rfid_tag || ''}`;

    caja.classList.remove('ul-pulso');
    void caja.offsetWidth;
    caja.classList.add('ul-pulso');

    if (tEnvio === null || reg.recibido_hace_ms === null || reg.recibido_hace_ms === undefined) {
        lat.textContent = '';
        return;
    }
    requestAnimationFrame(() => {
        const tPantalla = performance.now();
        const ms = Math.round(reg.recibido_hace_ms + (tRespuesta - tEnvio) / 2 + (tPantalla - tRespuesta));
        lat.textContent = `visto en ${formatearMs(ms)}`;
        lat.className = 'ul-latencia ' + (ms < 1000 ? 'lat-ok' : 'lat-lenta');
        guardarMedicion({ fecha: new Date().toISOString(), id: reg.id, tag: reg.rfid_tag || '', estado, ms });
    });
}

function formatearMs(ms) {
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2).replace('.', ',')} s`;
}

// ============================================================
//  PRUEBA DE RENDIMIENTO (Objetivo específico 1)
//  Cada lectura nueva medida se guarda en este navegador para
//  calcular promedio, mínimo, máximo y % bajo 1 s, y exportarlas.
// ============================================================

const CLAVE_MEDICIONES = 'fet-mediciones-latencia';

function leerMediciones() {
    try { return JSON.parse(localStorage.getItem(CLAVE_MEDICIONES)) || []; }
    catch (e) { return []; }
}

function guardarMedicion(m) {
    const lista = leerMediciones();
    if (lista.some(x => x.id === m.id)) return;
    lista.push(m);
    try { localStorage.setItem(CLAVE_MEDICIONES, JSON.stringify(lista.slice(-1000))); } catch (e) { /* sin espacio */ }
    renderizarMediciones();
}

function renderizarMediciones() {
    const lista = leerMediciones();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('perf-n', lista.length);
    if (!lista.length) {
        ['perf-prom', 'perf-min', 'perf-max', 'perf-meta'].forEach(id => set(id, '—'));
        set('perf-barra-label', 'RFID medido (sin datos)');
        const b = document.getElementById('perf-barra'); if (b) b.style.width = '0%';
        return;
    }
    const v    = lista.map(m => m.ms);
    const prom = Math.round(v.reduce((a, b) => a + b, 0) / v.length);
    const bajo = v.filter(x => x < 1000).length;
    set('perf-prom', formatearMs(prom));
    set('perf-min',  formatearMs(Math.min(...v)));
    set('perf-max',  formatearMs(Math.max(...v)));
    set('perf-meta', `${Math.round(bajo * 100 / v.length)} %`);
    set('perf-barra-label', `RFID medido (${formatearMs(prom)})`);
    const b = document.getElementById('perf-barra');
    if (b) b.style.width = Math.max(Math.min(prom / 12500 * 100, 100), 0.8) + '%';
}

function exportarMediciones() {
    const lista = leerMediciones();
    if (!lista.length) {
        mostrarToast('Aún no hay mediciones. Pase tarjetas por el lector con Monitoreo en Vivo abierto.', 'danger');
        return;
    }
    let csv = 'N,Fecha y hora (UTC),Registro,Tag RFID,Movimiento,Latencia (ms)\n';
    lista.forEach((m, i) => { csv += [i + 1, m.fecha, m.id, m.tag, m.estado, m.ms].map(campoCsv).join(',') + '\n'; });
    descargarArchivo('\ufeff' + csv, `prueba_rendimiento_FET_${hoyISO()}.csv`, 'text/csv;charset=utf-8;');
    mostrarToast(`Mediciones exportadas (${lista.length}).`, 'ok');
}

function reiniciarMediciones() {
    confirmarAccion({
        titulo: 'Reiniciar prueba de rendimiento',
        mensaje: 'Se borran las mediciones guardadas en este navegador. Los registros de acceso no se tocan.',
        textoAceptar: 'Reiniciar'
    }).then(ok => {
        if (!ok) return;
        try { localStorage.removeItem(CLAVE_MEDICIONES); } catch (e) { /* nada */ }
        renderizarMediciones();
        mostrarToast('Mediciones reiniciadas.', 'ok');
    });
}

function descargarArchivo(contenido, nombre, tipo) {
    const blob = new Blob([contenido], { type: tipo });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ============================================================
//  VENTANA DE CONFIRMACION (reemplaza confirm() del navegador)
// ============================================================

let confirmarResolver = null;
let confirmarPalabra  = '';

/**
 * Abre una ventana propia de confirmación y devuelve una promesa con true/false.
 * opciones: titulo, mensaje (texto), textoAceptar, peligro (bool), palabraClave
 * (obliga a escribirla para habilitar Aceptar), soloAviso (un solo botón),
 * extra: { texto, accion } (botón adicional, p. ej. exportar antes de borrar).
 */
function confirmarAccion(op) {
    const modal  = document.getElementById('modal-confirmar');
    const btnOk  = document.getElementById('confirmar-aceptar');
    const btnNo  = document.getElementById('confirmar-cancelar');
    const btnEx  = document.getElementById('confirmar-extra');
    const wrap   = document.getElementById('confirmar-clave-wrap');
    const input  = document.getElementById('confirmar-clave');

    document.getElementById('confirmar-titulo').textContent = op.titulo || 'Confirmar';
    const msg = document.getElementById('confirmar-mensaje');
    msg.innerHTML = '';
    String(op.mensaje || '').split('\n').forEach(linea => {
        const p = document.createElement('p');
        p.textContent = linea;
        msg.appendChild(p);
    });
    btnOk.textContent = op.textoAceptar || 'Aceptar';
    btnOk.classList.toggle('btn-peligro', op.peligro !== false && !op.soloAviso);
    modal.classList.toggle('es-peligro', op.peligro !== false && !op.soloAviso);
    btnNo.style.display = op.soloAviso ? 'none' : '';

    confirmarPalabra = op.palabraClave || '';
    wrap.style.display = confirmarPalabra ? '' : 'none';
    input.value = '';
    document.getElementById('confirmar-clave-label').textContent = `Escriba ${confirmarPalabra} para confirmar`;
    btnOk.disabled = !!confirmarPalabra;

    if (op.extra) {
        btnEx.style.display = '';
        btnEx.textContent = op.extra.texto;
        btnEx.onclick = op.extra.accion;
    } else {
        btnEx.style.display = 'none';
        btnEx.onclick = null;
    }

    modal.classList.add('visible');
    setTimeout(() => (confirmarPalabra ? input : (op.soloAviso ? btnOk : btnNo)).focus(), 120);

    return new Promise(resolve => {
        confirmarResolver = resolve;
        btnOk.onclick = () => cerrarConfirmacion(true);
        btnNo.onclick = () => cerrarConfirmacion(false);
    });
}

function validarClaveConfirmacion() {
    const v = document.getElementById('confirmar-clave').value.trim().toUpperCase();
    document.getElementById('confirmar-aceptar').disabled = v !== confirmarPalabra;
}

function cerrarConfirmacion(valor) {
    document.getElementById('modal-confirmar').classList.remove('visible');
    if (confirmarResolver) { confirmarResolver(valor); confirmarResolver = null; }
}

// Escape cierra cualquier ventana abierta
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('modal-confirmar').classList.contains('visible')) cerrarConfirmacion(false);
    else if (document.getElementById('modal-editar').classList.contains('visible')) cerrarModalEditar();
    else if (document.getElementById('modal-overlay').classList.contains('visible')) cerrarModalDirect();
});

/**
 * Muestra una notificacion prominente cuando se detecta un nuevo registro RFID.
 * Diferencia entre Ingreso, Salida y Acceso denegado.
 * @param {object} reg - Objeto de registro con estado, nombre_estudiante y rfid_tag
 */
function mostrarNotificacionAcceso(reg) {
    const nombre = reg.nombre_estudiante || null;
    const tag    = reg.rfid_tag || '';

    if (reg.estado === 'INGRESO' || reg.estado === 'AUTORIZADO') {
        // Ingreso autorizado
        const quien = nombre ? nombre : `Tag: ${tag}`;
        mostrarToastEvento(`\u2705 Ingreso \u2014 ${quien}`, 'ok');

    } else if (reg.estado === 'SALIDA') {
        // Salida registrada
        const quien = nombre ? nombre : `Tag: ${tag}`;
        mostrarToastEvento(`\uD83D\uDEAA Salida \u2014 ${quien}`, 'salida');

    } else {
        // DENEGADO: tag desconocido o estudiante suspendido
        const quien = nombre ? `${nombre} (suspendido)` : `Tag desconocido: ${tag}`;
        mostrarToastEvento(`\u26D4 Acceso Denegado \u2014 ${quien}`, 'danger');
    }
}

/**
 * Toast especial para eventos de ingreso/salida/acceso (dura 5.5 s, mas prominente).
 * @param {string} mensaje - Texto a mostrar
 * @param {string} tipo    - 'ok' | 'salida' | 'danger'
 */
function mostrarToastEvento(mensaje, tipo) {
    const toast = document.getElementById('toast');

    const iconos = {
        ok:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="20" height="20" style="flex-shrink:0"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
        salida: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="20" height="20" style="flex-shrink:0"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>`,
        danger: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="20" height="20" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`
    };

    const claseToast = tipo === 'salida' ? 'toast-salida' : `toast-${tipo}`;
    toast.innerHTML  = (iconos[tipo] || iconos.danger) + `<span class="toast-msg" style="font-size:1rem;font-weight:600;"></span>`;
    toast.querySelector('.toast-msg').textContent = mensaje;
    toast.className  = `toast ${claseToast} visible toast-evento`;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('visible'), 5500);
}

/**
 * Enmascara un ID estudiantil segun Ley 1581/2012 Habeas Data
 * Ej: "1075854589" → "***4589"
 */
function enmascararId(id) {
    const s = String(id);
    if (s.length <= 4) return '***' + s;
    return '***' + s.slice(-4);
}

/**
 * Elimina PERMANENTEMENTE todos los registros de la base de datos
 * via DELETE /api/registros y limpia la vista.
 */
function limpiarRegistros() {
    confirmarAccion({
        titulo: 'Borrar todo el historial',
        mensaje: 'Se eliminarán de la base de datos TODOS los ingresos, salidas y accesos denegados, y el aforo quedará en cero.\n' +
        'Esta acción no se puede deshacer. Si necesita conservar los datos, expórtelos antes desde Reportes.',
        textoAceptar: 'Borrar historial',
        palabraClave: 'BORRAR',
        extra: { texto: 'Ir a Reportes para exportar', accion: () => {
            cerrarConfirmacion(false);
            cambiarVista('reportes', document.getElementById('nav-reportes'));
        } }
    }).then(ok => { if (ok) ejecutarLimpieza(); });
}

function ejecutarLimpieza() {
    const btn = document.getElementById('btn-limpiar');
    if (btn) btn.disabled = true;

    apiFetch('/api/registros', { method: 'DELETE' })
    .then(leerJson)
    .then(({ status, data }) => {
        if (status === 200) {
            // Limpiar UI completamente
            clearId        = 0;
            lastNotifiedId = 0;   // la BD queda vacia, resetear watermark de notificaciones
            firstPollDone  = false;
            historialCompleto = [];
            document.getElementById('tabla-registros').innerHTML = '';
            document.getElementById('sin-registros').style.display = 'flex';
            document.getElementById('aforo').innerText    = '0';
            document.getElementById('ingresos').innerText = '0';
            document.getElementById('alertas').innerText  = '0';
            document.getElementById('table-count').textContent = '0 registros';
            actualizarBarraAforo(0);
            actualizarBadgeAlertas(0);
            mostrarToast('Todos los registros eliminados de la base de datos.', 'ok');
        } else {
            mostrarToast(data.error || 'Error al eliminar registros.', 'danger');
        }
    })
    .catch(err => {
        mostrarToast('Error de conexión al eliminar.', 'danger');
        console.error('Error eliminando registros:', err);
    })
    .finally(() => {
        if (btn) btn.disabled = false;
    });
}

/** Actualiza visualmente la barra de aforo */
function actualizarBarraAforo(actual) {
    const pct = Math.min((actual / aforoMaximo) * 100, 100);
    const bar = document.getElementById('aforo-bar');
    if (bar) {
        bar.style.width = pct + '%';
        bar.style.background = pct >= 100 ? 'linear-gradient(to right, #8a1c1c, #e05252)'
        : pct >= 85  ? 'linear-gradient(to right, #8a6a12, #e0b84a)'
        : 'linear-gradient(to right, #1f6e1f, #5cc45c)';
    }
    const card = document.querySelector('.card-aforo');
    if (card) card.classList.toggle('aforo-lleno', pct >= 100);
    const lbl = document.getElementById('aforo-max-label');
    if (lbl) lbl.textContent = aforoMaximo;
}

/** Actualiza el badge de alertas en el sidebar */
function actualizarBadgeAlertas(n) {
    const badge = document.getElementById('badge-alertas');
    if (!badge) return;
    badge.textContent = n > 0 ? n : '0';
    if (n > 0) {
        badge.removeAttribute('data-count');
        badge.style.display = 'flex';
    } else {
        badge.setAttribute('data-count', '0');
        badge.style.display = 'none';
    }
}

/** Mini-animacion de rebote cuando un numero cambia */
function animarContador(el) {
    el.style.transform = 'scale(1.18)';
    el.style.color = 'var(--green-400)';
    setTimeout(() => {
        el.style.transform = 'scale(1)';
        el.style.color = '';
        el.style.transition = 'transform 0.25s ease, color 0.25s ease';
    }, 220);
}

function actualizarEstadoPuerto() {
    const el = document.getElementById('estado-puerto');
    if (el) el.innerHTML = '<span class="dot-live" aria-hidden="true"></span> Conectando con el servidor...';
}

// ============================================================
//  GESTION DE ESTUDIANTES — conectado al backend
// ============================================================

function abrirModalAsignar(tag) {
    document.getElementById('modal-overlay').classList.add('visible');
    document.getElementById('modal-autorizacion').checked = false;
    // Tag leído por el lector (botón "Asignar" del monitoreo): se copia tal cual lo envió el ESP32
    document.getElementById('modal-tag').value = typeof tag === 'string' ? tag : '';
    setTimeout(() => document.getElementById('modal-documento').focus(), 150);
}

function cerrarModalDirect() {
    document.getElementById('modal-overlay').classList.remove('visible');
    document.getElementById('form-estudiante').reset();
}

function cerrarModal(e) {
    if (e.target.id === 'modal-overlay') cerrarModalDirect();
}

/**
 * Guarda un estudiante via POST /api/estudiantes
 */
function guardarEstudiante(e) {
    e.preventDefault();

    const documento = document.getElementById('modal-documento').value.trim();
    const nombre    = document.getElementById('modal-nombre').value.trim();
    const carrera   = document.getElementById('modal-carrera').value.trim();
    const tag       = normalizarTag(document.getElementById('modal-tag').value);

    const autorizacion = document.getElementById('modal-autorizacion').checked;
    if (!autorizacion) {
        mostrarToast('Confirme la autorización del titular para el tratamiento de datos.', 'danger');
        return;
    }

    if (!documento || !nombre || !carrera || !tag) {
        mostrarToast('Complete todos los campos.', 'danger');
        return;
    }

    apiFetch('/api/estudiantes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            documento: documento,
            nombre: nombre,
            carrera: carrera,
            rfid_tag: tag,
            autorizacion: autorizacion
        })
    })
    .then(leerJson)
    .then(({ status, data }) => {
        if (status === 201) {
            cerrarModalDirect();
            cargarEstudiantesDesdeAPI();
            mostrarToast(`Tarjeta ${tag} asignada a ${nombre}.`, 'ok');
        } else {
            mostrarToast(data.error || 'Error al registrar estudiante.', 'danger');
        }
    })
    .catch(err => {
        mostrarToast('Error de conexión al guardar.', 'danger');
        console.error('Error guardando estudiante:', err);
    });
}

/**
 * Carga la lista de estudiantes desde GET /api/estudiantes
 */
function cargarEstudiantesDesdeAPI(filtro) {
    const tbody = document.getElementById('tabla-estudiantes');
    if (tbody && !tbody.children.length) {
        tbody.innerHTML = '<tr class="fila-cargando"><td colspan="5">Cargando estudiantes...</td></tr>';
        document.getElementById('sin-estudiantes').style.display = 'none';
    }
    apiFetch('/api/estudiantes')
    .then(res => res.json())
    .then(data => {
        if (!Array.isArray(data)) throw new Error(data.error || 'Respuesta inválida');
        ultimaListaEstudiantes = data;
        const q = filtro !== undefined ? filtro : document.getElementById('input-buscar').value;
        renderizarEstudiantes(data, q);
    })
    .catch(err => {
        if (tbody) tbody.innerHTML = '';
        mostrarToast('Error al cargar estudiantes.', 'danger');
        console.error('Error cargando estudiantes:', err);
    });
}

/** Renderiza la tabla de estudiantes con datos del backend */
function renderizarEstudiantes(lista, filtro) {
    const tbody  = document.getElementById('tabla-estudiantes');
    const sinEst = document.getElementById('sin-estudiantes');

    if (filtro && filtro.trim()) {
        const q = filtro.toLowerCase();
        lista = lista.filter(e =>
        (e.nombre || '').toLowerCase().includes(q) ||
        (e.carrera || '').toLowerCase().includes(q) ||
        (e.rfid_tag || '').toLowerCase().includes(q)
        );
    }

    tbody.innerHTML = '';

    if (!lista || lista.length === 0) {
        sinEst.style.display = 'flex';
        sinEst.querySelector('span').textContent = filtro && filtro.trim()
        ? `Ningún estudiante coincide con "${filtro.trim()}".`
        : 'Sin estudiantes registrados aún. Asigne la primera tarjeta.';
        return;
    }
    sinEst.style.display = 'none';

    lista.forEach(est => {
        const activo = (est.estado === 'ACTIVO');
        const tr = document.createElement('tr');
        // Escapar el nombre para usarlo en el atributo data sin romper el HTML
        const nombreEscapado = (est.nombre || '').replace(/'/g, "\\'");
        tr.innerHTML = `
        <td style="font-weight:500;color:var(--text-main);">${esc(est.nombre)}</td>
        <td style="color:var(--text-muted);">${esc(est.carrera)}</td>
        <td class="rfid-tag">${esc(est.rfid_tag)}</td>
        <td><span class="badge ${activo ? 'ok' : 'warn'}">${esc(est.estado)}</span></td>
        <td class="td-acciones">
        <button class="btn-table-action solo-admin" data-tag="${esc(est.rfid_tag)}" onclick="consultarDatosTitular(this.dataset.tag)" title="Descargar todos los datos del titular (derecho de consulta)">Datos</button>
        <button class="btn-table-action solo-admin" data-tag="${esc(est.rfid_tag)}" data-nombre="${esc(est.nombre)}" data-carrera="${esc(est.carrera)}" onclick="rectificarEstudiante(this.dataset.tag, this.dataset.nombre, this.dataset.carrera)" title="Corregir datos del titular (derecho de rectificación)">Editar</button>
        <button class="btn-table-action solo-admin" data-tag="${esc(est.rfid_tag)}" data-estado="${esc(est.estado)}" data-nombre="${esc(est.nombre)}" onclick="toggleEstado(this, this.dataset.tag, this.dataset.estado, this.dataset.nombre)">${activo ? 'Suspender' : 'Reactivar'}</button>
        <button class="btn-table-action btn-table-delete solo-admin" data-tag="${esc(est.rfid_tag)}" data-nombre="${esc(est.nombre)}" onclick="eliminarEstudiante(this.dataset.tag, this.dataset.nombre)" aria-label="Eliminar estudiante ${esc(est.nombre)}" title="Eliminar estudiante">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" aria-hidden="true">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
        Eliminar
        </button>
        </td>
        `;
        tbody.appendChild(tr);
    });
}

let ultimaListaEstudiantes = null;
function filtrarEstudiantes() {
    const q = document.getElementById('input-buscar').value;
    if (ultimaListaEstudiantes) renderizarEstudiantes(ultimaListaEstudiantes, q);
    else cargarEstudiantesDesdeAPI(q);
}

/**
 * Cambia el estado de un estudiante via PUT /api/estudiantes/estado
 */
function toggleEstado(btn, rfidTag, estadoActual, nombre) {
    const nuevoEstado = estadoActual === 'ACTIVO' ? 'INACTIVO' : 'ACTIVO';
    if (nuevoEstado === 'INACTIVO') {
        confirmarAccion({
            titulo: 'Suspender tarjeta',
            mensaje: `${nombre || 'El estudiante'} quedará INACTIVO: sus lecturas aparecerán como DENEGADO y se marcará como fuera de la institución.\nPuede reactivarlo cuando quiera.`,
            textoAceptar: 'Suspender'
        }).then(ok => { if (ok) enviarCambioEstado(rfidTag, nuevoEstado); });
    } else {
        enviarCambioEstado(rfidTag, nuevoEstado);
    }
}

function enviarCambioEstado(rfidTag, nuevoEstado) {
    apiFetch('/api/estudiantes/estado', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rfid_tag: rfidTag, estado: nuevoEstado })
    })
    .then(leerJson)
    .then(({ status, data }) => {
        if (status === 200) {
            cargarEstudiantesDesdeAPI();
            mostrarToast(
                nuevoEstado === 'ACTIVO'
                ? `Tarjeta ${rfidTag} reactivada.`
                : `Tarjeta ${rfidTag} suspendida.`,
                nuevoEstado === 'ACTIVO' ? 'ok' : 'danger'
            );
        } else {
            mostrarToast(data.error || 'Error al cambiar estado.', 'danger');
        }
    })
    .catch(err => {
        mostrarToast('Error de conexión.', 'danger');
        console.error('Error toggle estado:', err);
    });
}

/**
 * Elimina PERMANENTEMENTE un estudiante (y sus registros de acceso)
 * via DELETE /api/estudiantes/<rfid_tag>, previa confirmacion del usuario.
 * @param {string} rfidTag  - Codigo RFID del estudiante a eliminar
 * @param {string} nombre   - Nombre del estudiante (para el mensaje de confirmacion)
 */
function eliminarEstudiante(rfidTag, nombre) {
    // Confirmación propia antes de la acción irreversible
    confirmarAccion({
        titulo: 'Eliminar estudiante',
        mensaje: `Se eliminará a "${nombre}" y todos sus registros de acceso (derecho de supresión, Ley 1581).\n` +
        'Esta acción no se puede deshacer. Si solo quiere impedir el ingreso, use Suspender.',
        textoAceptar: 'Eliminar'
    }).then(ok => { if (ok) ejecutarEliminacion(rfidTag, nombre); });
}

function ejecutarEliminacion(rfidTag, nombre) {
    apiFetch(`/api/estudiantes/${encodeURIComponent(rfidTag)}`, {
        method: 'DELETE'
    })
    .then(leerJson)
    .then(({ status, data }) => {
        if (status === 200) {
            cargarEstudiantesDesdeAPI();
            mostrarToast(
                `Estudiante "${nombre}" eliminado correctamente.`,
                'ok'
            );
        } else {
            mostrarToast(data.error || 'Error al eliminar el estudiante.', 'danger');
        }
    })
    .catch(err => {
        mostrarToast('Error de conexión al eliminar.', 'danger');
        console.error('Error eliminando estudiante:', err);
    });
}

/**
 * Derecho de consulta (Ley 1581): descarga en JSON todos los datos del titular
 * via GET /api/estudiantes/<rfid_tag>/datos (incluye el documento completo).
 */
function consultarDatosTitular(rfidTag) {
    apiFetch(`/api/estudiantes/${encodeURIComponent(rfidTag)}/datos`)
    .then(leerJson)
    .then(({ status, data }) => {
        if (status !== 200) {
            mostrarToast(data.error || 'No se pudieron consultar los datos.', 'danger');
            return;
        }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `datos_titular_${rfidTag}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        mostrarToast(`Datos del titular descargados (${(data.accesos || []).length} accesos).`, 'ok');
    })
    .catch(err => {
        mostrarToast('Error de conexión al consultar datos.', 'danger');
        console.error('Error consultando titular:', err);
    });
}

/**
 * Derecho de rectificación: corrige nombre, carrera y/o documento
 * via PUT /api/estudiantes/<rfid_tag>. Solo envía los campos que cambiaron.
 */
let edicionActual = null;   // { tag, nombre, carrera }

function rectificarEstudiante(rfidTag, nombreActual, carreraActual) {
    edicionActual = { tag: rfidTag, nombre: nombreActual || '', carrera: carreraActual || '' };
    document.getElementById('editar-tag-label').textContent = rfidTag;
    document.getElementById('editar-nombre').value    = edicionActual.nombre;
    document.getElementById('editar-carrera').value   = edicionActual.carrera;
    document.getElementById('editar-documento').value = '';
    document.getElementById('modal-editar').classList.add('visible');
    setTimeout(() => document.getElementById('editar-nombre').focus(), 150);
}

function cerrarModalEditar() {
    document.getElementById('modal-editar').classList.remove('visible');
    edicionActual = null;
}

function guardarEdicion(e) {
    e.preventDefault();
    if (!edicionActual) return;
    const nombre    = document.getElementById('editar-nombre').value.trim();
    const carrera   = document.getElementById('editar-carrera').value.trim();
    const documento = document.getElementById('editar-documento').value.trim();

    if (nombre.length < 2 || carrera.length < 2) {
        mostrarToast('Nombre y carrera deben tener al menos 2 caracteres.', 'danger');
        return;
    }
    if (documento && !/^[0-9A-Za-z]{4,20}$/.test(documento)) {
        mostrarToast('El documento debe tener entre 4 y 20 letras o números.', 'danger');
        return;
    }
    const cambios = {};
    if (nombre !== edicionActual.nombre) cambios.nombre = nombre;
    if (carrera !== edicionActual.carrera) cambios.carrera = carrera;
    if (documento) cambios.documento = documento;
    if (Object.keys(cambios).length === 0) {
        mostrarToast('No hay cambios para guardar.', 'danger');
        return;
    }

    const tag = edicionActual.tag;
    const btn = document.getElementById('btn-guardar-edicion');
    btn.disabled = true;
    apiFetch(`/api/estudiantes/${encodeURIComponent(tag)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cambios)
    })
    .then(leerJson)
    .then(({ status, data }) => {
        if (status === 200) {
            cerrarModalEditar();
            cargarEstudiantesDesdeAPI();
            mostrarToast(`Datos de ${nombre} actualizados.`, 'ok');
        } else {
            mostrarToast(data.error || 'Error al actualizar los datos.', 'danger');
        }
    })
    .catch(err => {
        mostrarToast('Error de conexión al actualizar.', 'danger');
        console.error('Error rectificando estudiante:', err);
    })
    .finally(() => { btn.disabled = false; });
}

/**
 * Política de retención: borra los registros de acceso más antiguos que
 * RETENCION_DIAS (configurado en el servidor) via POST /api/privacidad/purgar.
 */
function purgarRegistrosAntiguos() {
    const dias = document.getElementById('retencion-dias').textContent;
    confirmarAccion({
        titulo: 'Aplicar política de retención',
        mensaje: `Se borrarán los registros de acceso con más de ${dias} días (Ley 1581).\nEsta acción no se puede deshacer.`,
                    textoAceptar: 'Purgar'
    }).then(ok => { if (ok) ejecutarPurga(); });
}

function ejecutarPurga() {
    apiFetch('/api/privacidad/purgar', { method: 'POST' })
    .then(leerJson)
    .then(({ status, data }) => {
        mostrarToast(data.mensaje || data.error || 'Error al purgar registros.', status === 200 ? 'ok' : 'danger');
    })
    .catch(err => {
        mostrarToast('Error de conexión al purgar.', 'danger');
        console.error('Error purgando registros:', err);
    });
}

// ============================================================
//  REPORTES
// ============================================================

let reporteActual = [];   // filas del ultimo historial consultado (para exportar)

/** Fecha local de hoy en formato AAAA-MM-DD (para los filtros). */
function hoyISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sincronizarReportes() {
    apiFetch('/api/stats')
    .then(res => res.json())
    .then(data => {
        document.getElementById('reporte-ingresos').innerText = (data.ingresos_hoy ?? data.ingresos ?? 0).toLocaleString();
        document.getElementById('reporte-alertas').innerText  = (data.alertas_hoy ?? data.alertas ?? 0).toLocaleString();
        document.getElementById('reporte-maximo').innerText   = aforoMaximo;
    })
    .catch(err => console.error('Error sincronizando reportes:', err));

    // Al abrir la vista se muestra el dia de hoy, salvo que ya haya filtros puestos
    if (!document.getElementById('filtro-desde').value && !document.getElementById('filtro-hasta').value) {
        document.getElementById('filtro-desde').value = hoyISO();
        document.getElementById('filtro-hasta').value = hoyISO();
    }
    buscarRegistros();
    cargarDentro();
    renderizarMediciones();
}

function limpiarFiltros() {
    document.getElementById('form-filtros').reset();
    document.getElementById('filtro-desde').value = hoyISO();
    document.getElementById('filtro-hasta').value = hoyISO();
    buscarRegistros();
}

/**
 * Consulta el historial filtrado via GET /api/reportes/registros
 * (rango de fechas, franja horaria, estudiante y tipo de movimiento).
 */
function buscarRegistros(e) {
    if (e) e.preventDefault();
    const desde = document.getElementById('filtro-desde').value;
    const hasta = document.getElementById('filtro-hasta').value;
    if (desde && hasta && desde > hasta) {
        mostrarToast('La fecha "Desde" no puede ser posterior a "Hasta".', 'danger');
        return;
    }
    const params = new URLSearchParams();
    const valores = {
        desde, hasta,
        hora_desde: document.getElementById('filtro-hora-desde').value,
        hora_hasta: document.getElementById('filtro-hora-hasta').value,
        q:          document.getElementById('filtro-texto').value.trim(),
        estado:     document.getElementById('filtro-estado').value
    };
    Object.entries(valores).forEach(([k, v]) => { if (v) params.append(k, v); });
    const tbody = document.getElementById('tabla-historial');
    tbody.innerHTML = '<tr class="fila-cargando"><td colspan="6">Consultando historial...</td></tr>';
    document.getElementById('sin-historial').style.display = 'none';

    apiFetch('/api/reportes/registros?' + params.toString())
    .then(leerJson)
    .then(({ status, data }) => {
        if (status !== 200) {
            tbody.innerHTML = '';
            mostrarToast(data.error || 'Error al consultar el historial.', 'danger');
            return;
        }
        reporteActual = data.registros || [];
        renderizarHistorial(reporteActual);
        if (data.truncado) mostrarToast(`Se muestran los primeros ${reporteActual.length} registros. Acote el rango de fechas.`, 'danger');
    })
    .catch(err => {
        tbody.innerHTML = '';
        mostrarToast('Error de conexión al consultar el historial.', 'danger');
        console.error('Error consultando historial:', err);
    });
}

function renderizarHistorial(lista) {
    const tbody   = document.getElementById('tabla-historial');
    const sinHist = document.getElementById('sin-historial');
    tbody.innerHTML = '';
    document.getElementById('historial-count').textContent = `${lista.length} registro${lista.length !== 1 ? 's' : ''}`;
    sinHist.style.display = lista.length ? 'none' : 'flex';

    lista.forEach(reg => {
        const badgeClass = reg.estado === 'INGRESO' ? 'badge ok'
        : reg.estado === 'SALIDA'  ? 'badge salida'
        : 'badge warn';
        const tr = document.createElement('tr');
        tr.innerHTML = `
        <td style="font-family:'JetBrains Mono',monospace;font-size:.85rem;color:var(--text-muted);">${esc(reg.fecha)}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:.85rem;color:var(--text-muted);">${esc(reg.hora)}</td>
        <td style="font-weight:500;color:var(--text-main);">${esc(reg.nombre)}</td>
        <td style="font-family:'JetBrains Mono',monospace;letter-spacing:1px;">${esc(reg.idEstudiante)}</td>
        <td class="rfid-tag">${esc(reg.rfid_tag)}</td>
        <td><span class="${badgeClass}">${esc(reg.estado)}</span></td>
        `;
        tbody.appendChild(tr);
    });
}

/** Estudiantes con ingreso y sin salida registrada, via GET /api/reportes/dentro. */
function cargarDentro() {
    apiFetch('/api/reportes/dentro')
    .then(res => res.json())
    .then(lista => {
        if (!Array.isArray(lista)) return;
        const tbody = document.getElementById('tabla-dentro');
        tbody.innerHTML = '';
        document.getElementById('dentro-count').textContent = `${lista.length} estudiante${lista.length !== 1 ? 's' : ''}`;
        document.getElementById('sin-dentro').style.display = lista.length ? 'none' : 'flex';
        lista.forEach(est => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
            <td style="font-weight:500;color:var(--text-main);">${esc(est.nombre)}</td>
            <td style="color:var(--text-muted);">${esc(est.carrera)}</td>
            <td style="font-family:'JetBrains Mono',monospace;letter-spacing:1px;">${esc(est.idEstudiante)}</td>
            <td style="font-family:'JetBrains Mono',monospace;font-size:.85rem;color:var(--text-muted);">${esc(est.ultimo_ingreso)}</td>
            `;
            tbody.appendChild(tr);
        });
    })
    .catch(err => console.error('Error cargando estudiantes dentro:', err));
}

/** Campo CSV seguro: comillas y sin formulas de Excel (=, +, -, @). */
function campoCsv(v) {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * Genera y descarga un CSV con el historial filtrado que se ve en pantalla.
 */
function exportarReporte() {
    if (reporteActual.length === 0) {
        mostrarToast('No hay datos para exportar. Consulte el historial primero.', 'danger');
        return;
    }
    let csv = 'Fecha,Hora,Estudiante,Carrera,ID Estudiantil,Tag RFID,Estado\n';
    reporteActual.forEach(r => {
        csv += [r.fecha, r.hora, r.nombre, r.carrera, r.idEstudiante, r.rfid_tag, r.estado].map(campoCsv).join(',') + '\n';
    });
    const desde = document.getElementById('filtro-desde').value || 'inicio';
    const hasta = document.getElementById('filtro-hasta').value || hoyISO();
    descargarArchivo('﻿' + csv, `reporte_FET_${desde}_a_${hasta}.csv`, 'text/csv;charset=utf-8;');
    mostrarToast(`Reporte CSV descargado (${reporteActual.length} registros).`, 'ok');
}

// ============================================================
//  CONFIGURACION
// ============================================================

/** Pinta una tarjeta de servicio: estado 'ok' | 'warn' | 'err'. */
function pintarServicio(id, estado, texto, detalle) {
    const el  = document.getElementById('estado-' + id);
    const det = document.getElementById('detalle-' + id);
    const card = document.getElementById('card-' + id);
    if (el) {
        el.textContent = texto;
        el.className = estado === 'ok' ? 'status-text-ok' : estado === 'warn' ? 'status-text-warn' : 'status-text-err';
    }
    if (det) det.textContent = detalle || '\u00a0';
    if (card) {
        card.classList.remove('svc-ok', 'svc-warn', 'svc-err');
        card.classList.add('svc-' + estado);
    }
}

function haceTiempo(seg) {
    if (seg === null || seg === undefined) return 'nunca';
    if (seg < 60) return `hace ${seg} s`;
    if (seg < 3600) return `hace ${Math.round(seg / 60)} min`;
    if (seg < 172800) return `hace ${Math.round(seg / 3600)} h`;
    return `hace ${Math.round(seg / 86400)} días`;
}

/**
 * Consulta GET /api/health y muestra el estado REAL del servidor, la base de datos
 * y la última lectura recibida del lector (antes eran tarjetas fijas).
 */
function comprobarEstado(manual) {
    if (!authToken) return;
    if (manual) {
        pintarServicio('servidor', 'warn', 'Comprobando...', '');
    }
    const t0 = performance.now();
    apiFetch('/api/health')
    .then(leerJson)
    .then(({ status, data }) => {
        const ms = Math.round(performance.now() - t0);
        if (status !== 200) throw new Error(data.error || 'HTTP ' + status);
        pintarServicio('servidor', 'ok', 'En línea', `Respondió en ${ms} ms · versión ${data.version || '1.1'}`);
        if (data.base_datos === 'ok') {
            pintarServicio('bd', 'ok', 'Conectada', `Consulta en ${data.base_datos_ms} ms · ${data.estudiantes} estudiantes registrados`);
        } else {
            pintarServicio('bd', 'err', 'Sin conexión', 'El servidor no logra consultar la base de datos.');
        }
        const seg = data.ultima_lectura_hace_seg;
        if (seg === null || seg === undefined) {
            pintarServicio('lector', 'warn', 'Sin lecturas', 'Aún no se ha recibido ninguna lectura.');
        } else {
            pintarServicio('lector', seg < 86400 ? 'ok' : 'warn',
                           seg < 86400 ? 'Enviando lecturas' : 'Sin lecturas recientes',
                           `Última lectura recibida ${haceTiempo(seg)}`);
        }
        if (data.retencion_dias) document.getElementById('retencion-dias').textContent = data.retencion_dias;
        if (manual) mostrarToast('Estado de los servicios actualizado.', 'ok');
    })
    .catch(err => {
        pintarServicio('servidor', 'err', 'Sin respuesta', 'No se pudo contactar al servidor en Render.');
        pintarServicio('bd', 'err', 'Desconocido', 'Depende del servidor.');
        pintarServicio('lector', 'err', 'Desconocido', 'Depende del servidor.');
        if (manual) mostrarToast('El servidor no respondió.', 'danger');
        console.error('Error consultando estado:', err);
    });
}

function verLicencia() {
    confirmarAccion({
        titulo: 'Licencia del software',
        mensaje: 'S.I.E – FET, versión 1.1. Licencia privativa: © 2026 Fundación Escuela Tecnológica de Neiva y sus autores (Ordoñez, Cardoso, Serrato). Todos los derechos reservados.\n' +
        'No se autoriza la copia, modificación ni redistribución del código fuente ni de la estructura de la base de datos sin permiso escrito.\n' +
        'Componentes de terceros: Python y Flask (licencias PSF y BSD), conector MySQL (GPLv2 con excepción FOSS), TiDB Cloud (servicio).',
                    textoAceptar: 'Entendido',
                    soloAviso: true
    });
}

function guardarAforo() {
    const val = parseInt(document.getElementById('input-aforo-max').value, 10);
    if (isNaN(val) || val < 1) {
        mostrarToast('Ingrese un aforo válido (mayor a 0).', 'danger');
        return;
    }
    aforoMaximo = val;
    try { localStorage.setItem('fet-aforo-max', String(val)); } catch (e) { /* modo privado */ }
    const lbl = document.getElementById('aforo-max-label');
    if (lbl) lbl.textContent = aforoMaximo;
    const aforoActual = parseInt(document.getElementById('aforo').innerText.replace(/[.,]/g, '')) || 0;
    actualizarBarraAforo(aforoActual);
    document.getElementById('reporte-maximo').innerText = aforoMaximo;
    mostrarToast(`Aforo máximo actualizado a ${aforoMaximo} personas.`, 'ok');
}

// ============================================================
//  TOAST DE NOTIFICACION
// ============================================================

let toastTimeout = null;

function mostrarToast(mensaje, tipo = 'ok') {
    const toast = document.getElementById('toast');
    const icono = tipo === 'ok'
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18" style="flex-shrink:0"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18" style="flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

    toast.innerHTML = icono + '<span class="toast-msg"></span>';
    toast.querySelector('.toast-msg').textContent = mensaje;
    toast.className = `toast toast-${tipo} visible`;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('visible'), 3800);
}

// ============================================================
//  SHAKE (login fallido)
// ============================================================

const shakeStyle = document.createElement('style');
shakeStyle.textContent = `
@keyframes shake {
    0%,100% { transform: translateX(0); }
    20%     { transform: translateX(-8px); }
    40%     { transform: translateX(8px); }
    60%     { transform: translateX(-5px); }
    80%     { transform: translateX(5px); }
}
`;
document.head.appendChild(shakeStyle);

// ============================================================
//  MODO OSCURO / CLARO
// ============================================================

/**
 * Alterna entre modo oscuro y modo claro, actualizando:
 *   - El atributo data-theme en <html>
 *   - Los iconos y etiqueta del boton toggle
 *   - localStorage para persistencia entre sesiones
 */
function toggleTema() {
    const html       = document.documentElement;
    const temaActual = html.getAttribute('data-theme') || 'dark';
    const nuevoTema  = temaActual === 'dark' ? 'light' : 'dark';

    html.setAttribute('data-theme', nuevoTema);
    localStorage.setItem('fet-theme', nuevoTema);
    sincronizarIconoTema(nuevoTema);
    mostrarToast(
        nuevoTema === 'light' ? 'Modo Claro activado.' : 'Modo Oscuro activado.',
        'ok'
    );
}

/**
 * Actualiza el icono (luna / sol) y la etiqueta del boton toggle
 * segun el tema pasado.
 * @param {string} tema - 'dark' | 'light'
 */
function sincronizarIconoTema(tema) {
    const iconDark  = document.getElementById('theme-icon-dark');
    const iconLight = document.getElementById('theme-icon-light');
    const label     = document.getElementById('theme-label');
    if (!iconDark || !iconLight || !label) return;

    if (tema === 'light') {
        // Modo claro activo: mostrar icono de sol para indicar "volver a oscuro"
        iconDark.style.display  = 'none';
        iconLight.style.display = 'flex';
        label.textContent       = 'Modo Oscuro';
    } else {
        // Modo oscuro activo: mostrar icono de luna para indicar "ir a claro"
        iconDark.style.display  = 'flex';
        iconLight.style.display = 'none';
        label.textContent       = 'Modo Claro';
    }
}

// Sincronizar icono con el tema que se cargo al inicio
document.addEventListener('DOMContentLoaded', () => {
    const temaGuardado = localStorage.getItem('fet-theme') || 'dark';
    sincronizarIconoTema(temaGuardado);
    const inp = document.getElementById('input-aforo-max');
    if (inp) inp.value = aforoMaximo;
    const lbl = document.getElementById('aforo-max-label');
    if (lbl) lbl.textContent = aforoMaximo;
    const rep = document.getElementById('reporte-maximo');
    if (rep) rep.textContent = aforoMaximo;
});
