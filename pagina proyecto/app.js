// ============================================================
//  app.js  –  Logica del Sistema S.I.E - FET
//  Conectado al backend Flask (server.py)
//  Autores: Ordonez, Cardoso, Serrato — FET 2026
//  Licencia Privativa
// ============================================================

// ── URL del backend en Render (TiDB Cloud + Flask) ──
const API_BASE = 'https://sistema-fet-backend.onrender.com';

// ── Aplicar tema guardado ANTES del primer render (evita flash) ──
(function aplicarTemaGuardado() {
    const temaGuardado = localStorage.getItem('fet-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', temaGuardado);
    // Los iconos se sincronizan despues del DOMContentLoaded
})();

// ── Estado global ──
let aforoMaximo       = 150;
let puertoActual      = 'COM3';
let historialCompleto = [];
let pollingInterval   = null;
let monitorPausado    = false;
let clearId           = 0;  // ID del ultimo registro al momento de limpiar (marca de agua)
let lastNotifiedId    = 0;  // ID del ultimo registro para el que se mostro notificacion
let firstPollDone     = false; // true tras el primer ciclo de polling (evita notificar historico)

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
    .then(res => res.json().then(data => ({ status: res.status, data })))
    .then(({ status, data }) => {
        if (status === 200 && data.usuario) {
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
            btn.querySelector('.btn-text').textContent = 'Iniciar Sesion';
            mostrarToast(data.error || 'Credenciales incorrectas.', 'danger');
            shakeLogin();
        }
    })
    .catch(err => {
        btn.disabled = false;
        btn.querySelector('.btn-text').textContent = 'Iniciar Sesion';
        mostrarToast('Error de conexion con el servidor.', 'danger');
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
    // Detener polling
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
    monitorPausado  = false;
    clearId         = 0;
    lastNotifiedId  = 0;   // resetear al cerrar sesion
    firstPollDone   = false;
    document.getElementById('app-layout').style.display = 'none';
    const loginScreen = document.getElementById('login-screen');
    loginScreen.style.display  = 'flex';
    loginScreen.style.opacity  = '0';
    document.getElementById('input-usuario').value = '';
    document.getElementById('input-clave').value   = '';
    document.getElementById('btn-login').disabled  = false;
    document.getElementById('btn-login').querySelector('.btn-text').textContent = 'Iniciar Sesion';
    setTimeout(() => { loginScreen.style.opacity = '1'; }, 50);
    mostrarToast('Sesion cerrada correctamente.', 'ok');
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

    if (idVista === 'reportes') sincronizarReportes();
    if (idVista === 'estudiantes') cargarEstudiantesDesdeAPI();
}

// ============================================================
//  MONITOREO EN VIVO — con polling al backend
// ============================================================

function iniciarMonitor() {
    historialCompleto = [];
    lastNotifiedId    = 0;
    firstPollDone     = false;
    actualizarEstadoPuerto();

    // Cargar datos iniciales desde el backend
    cargarEstadisticas();
    cargarUltimosRegistros();

    // Polling cada 3 segundos para datos en tiempo real
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = setInterval(() => {
        cargarEstadisticas();
        cargarUltimosRegistros();
    }, 3000);
}

/**
 * Consulta GET /api/stats para obtener aforo, ingresos y alertas
 */
function cargarEstadisticas() {
    fetch(API_BASE + '/api/stats')
    .then(res => res.json())
    .then(data => {
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
    if (monitorPausado) return;
    fetch(API_BASE + '/api/ultimos-registros')
    .then(res => res.json())
    .then(registrosRaw => {
        // ── NOTIFICACIONES DE INGRESO / SALIDA ──
        // En el primer ciclo solo guardamos el watermark sin notificar (historial existente).
        if (!firstPollDone) {
            if (registrosRaw.length > 0) {
                lastNotifiedId = Math.max(...registrosRaw.map(r => r.id || 0));
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
                <td style="color:var(--text-muted);font-family:'JetBrains Mono',monospace;font-size:.85rem;">${hora}</td>
                <td style="font-family:'JetBrains Mono',monospace;letter-spacing:1px;color:var(--text-sub);">${idEnmascarado}</td>
                <td class="rfid-tag">${reg.rfid_tag || ''}</td>
                <td><span class="${badgeClass}">${reg.estado}</span></td>
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
    .catch(err => console.error('Error cargando registros:', err));
}

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
    toast.innerHTML  = (iconos[tipo] || iconos.danger) + `<span style="font-size:1rem;font-weight:600;">${mensaje}</span>`;
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
    const btn = document.getElementById('btn-limpiar');
    if (btn) btn.disabled = true;

    fetch(API_BASE + '/api/registros', { method: 'DELETE' })
    .then(res => res.json().then(data => ({ status: res.status, data })))
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
        mostrarToast('Error de conexion al eliminar.', 'danger');
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
        bar.style.background = 'linear-gradient(to right, #1f6e1f, #5cc45c)';
    }
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
    if (el) el.innerHTML = `<span class="dot-live"></span> Escuchando puerto ${puertoActual}...`;
}

// ============================================================
//  GESTION DE ESTUDIANTES — conectado al backend
// ============================================================

function abrirModalAsignar() {
    document.getElementById('modal-overlay').classList.add('visible');
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
    const tag       = document.getElementById('modal-tag').value.trim().toUpperCase();

    if (!documento || !nombre || !carrera || !tag) {
        mostrarToast('Complete todos los campos.', 'danger');
        return;
    }

    fetch(API_BASE + '/api/estudiantes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            documento: documento,
            nombre: nombre,
            carrera: carrera,
            rfid_tag: tag
        })
    })
    .then(res => res.json().then(data => ({ status: res.status, data })))
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
        mostrarToast('Error de conexion al guardar.', 'danger');
        console.error('Error guardando estudiante:', err);
    });
}

/**
 * Carga la lista de estudiantes desde GET /api/estudiantes
 */
function cargarEstudiantesDesdeAPI(filtro) {
    fetch(API_BASE + '/api/estudiantes')
    .then(res => res.json())
    .then(data => {
        renderizarEstudiantes(data, filtro);
    })
    .catch(err => {
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
        return;
    }
    sinEst.style.display = 'none';

    lista.forEach(est => {
        const activo = (est.estado === 'ACTIVO');
        const tr = document.createElement('tr');
        // Escapar el nombre para usarlo en el atributo data sin romper el HTML
        const nombreEscapado = (est.nombre || '').replace(/'/g, "\\'");
        tr.innerHTML = `
            <td style="font-weight:500;color:var(--text-main);">${est.nombre}</td>
            <td style="color:var(--text-muted);">${est.carrera}</td>
            <td class="rfid-tag">${est.rfid_tag}</td>
            <td><span class="badge ${activo ? 'ok' : 'warn'}">${est.estado}</span></td>
            <td class="td-acciones">
                <button class="btn-table-action" onclick="toggleEstado(this, '${est.rfid_tag}', '${est.estado}')">${activo ? 'Suspender' : 'Reactivar'}</button>
                <button class="btn-table-action btn-table-delete" onclick="eliminarEstudiante('${est.rfid_tag}', '${nombreEscapado}')" aria-label="Eliminar estudiante ${est.nombre}" title="Eliminar estudiante">
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

function filtrarEstudiantes() {
    const q = document.getElementById('input-buscar').value;
    cargarEstudiantesDesdeAPI(q);
}

/**
 * Cambia el estado de un estudiante via PUT /api/estudiantes/estado
 */
function toggleEstado(btn, rfidTag, estadoActual) {
    const nuevoEstado = estadoActual === 'ACTIVO' ? 'INACTIVO' : 'ACTIVO';

    fetch(API_BASE + '/api/estudiantes/estado', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rfid_tag: rfidTag, estado: nuevoEstado })
    })
    .then(res => res.json().then(data => ({ status: res.status, data })))
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
        mostrarToast('Error de conexion.', 'danger');
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
    // Pedir confirmacion antes de ejecutar la accion irreversible
    const confirmado = window.confirm(
        `⚠️ ¿Eliminar permanentemente al estudiante "${nombre}"?\n\n` +
        `Se borrarán también todos sus registros de acceso RFID.\n` +
        `Esta acción NO se puede deshacer.`
    );
    if (!confirmado) return;

    fetch(`${API_BASE}/api/estudiantes/${encodeURIComponent(rfidTag)}`, {
        method: 'DELETE'
    })
    .then(res => res.json().then(data => ({ status: res.status, data })))
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
        mostrarToast('Error de conexion al eliminar.', 'danger');
        console.error('Error eliminando estudiante:', err);
    });
}

// ============================================================
//  REPORTES
// ============================================================

function sincronizarReportes() {
    // Traer stats actuales del backend
    fetch(API_BASE + '/api/stats')
    .then(res => res.json())
    .then(data => {
        document.getElementById('reporte-ingresos').innerText = (data.ingresos || 0).toLocaleString();
        document.getElementById('reporte-alertas').innerText  = (data.alertas || 0).toLocaleString();
        document.getElementById('reporte-maximo').innerText   = aforoMaximo;
    })
    .catch(err => console.error('Error sincronizando reportes:', err));

    // Tabla de historial desde los ultimos registros cargados
    const tbody   = document.getElementById('tabla-historial');
    const sinHist = document.getElementById('sin-historial');
    tbody.innerHTML = '';

    if (historialCompleto.length === 0) {
        sinHist.style.display = 'flex';
        return;
    }
    sinHist.style.display = 'none';

    historialCompleto.forEach(reg => {
        const badgeClass = reg.estado === 'AUTORIZADO' ? 'badge ok' : 'badge warn';
        const idEnmascarado = enmascararId(reg.id);
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="font-family:'JetBrains Mono',monospace;font-size:.85rem;color:var(--text-muted);">${reg.hora}</td>
            <td style="font-family:'JetBrains Mono',monospace;letter-spacing:1px;">${idEnmascarado}</td>
            <td class="rfid-tag">${reg.tag}</td>
            <td><span class="${badgeClass}">${reg.estado}</span></td>
        `;
        tbody.appendChild(tr);
    });
}

/**
 * Genera y descarga un CSV con el historial.
 */
function exportarReporte() {
    if (historialCompleto.length === 0) {
        mostrarToast('No hay datos para exportar aun.', 'danger');
        return;
    }
    let csv = 'Hora,ID Estudiantil,Tag RFID,Estado\n';
    historialCompleto.forEach(r => {
        csv += `${r.hora},${enmascararId(r.id)},${r.tag},${r.estado}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `reporte_FET_${new Date().toLocaleDateString('es-CO').replace(/\//g, '-')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    mostrarToast(`Reporte CSV descargado (${historialCompleto.length} registros).`, 'ok');
}

// ============================================================
//  CONFIGURACION
// ============================================================

function reconectarServicio(servicio) {
    const estadoEl = document.getElementById(`estado-${servicio}`);
    if (!estadoEl) return;
    estadoEl.textContent = 'Reconectando...';
    estadoEl.className = 'status-text-err';
    mostrarToast(`Reconectando ${servicio.toUpperCase()}...`, 'ok');

    setTimeout(() => {
        estadoEl.textContent = servicio === 'python' ? 'En Ejecucion' : 'Conectado';
        estadoEl.className = 'status-text-ok';
        mostrarToast(`${servicio.toUpperCase()} reconectado correctamente.`, 'ok');
    }, 2200);
}

function verLicencia() {
    mostrarToast('Licencia Privativa — FET Ingenieria de Software 2026. Todos los derechos reservados.', 'ok');
}

function guardarAforo() {
    const val = parseInt(document.getElementById('input-aforo-max').value);
    if (isNaN(val) || val < 1) {
        mostrarToast('Ingrese un aforo valido (mayor a 0).', 'danger');
        return;
    }
    aforoMaximo = val;
    const lbl = document.getElementById('aforo-max-label');
    if (lbl) lbl.textContent = aforoMaximo;
    const aforoActual = parseInt(document.getElementById('aforo').innerText.replace(/,/g, '')) || 0;
    actualizarBarraAforo(aforoActual);
    document.getElementById('reporte-maximo').innerText = aforoMaximo;
    mostrarToast(`Aforo maximo actualizado a ${aforoMaximo} personas.`, 'ok');
}

function guardarPuerto() {
    puertoActual = document.getElementById('select-puerto').value;
    actualizarEstadoPuerto();
    mostrarToast(`Puerto cambiado a ${puertoActual}.`, 'ok');
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

    toast.innerHTML = icono + `<span>${mensaje}</span>`;
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
});
