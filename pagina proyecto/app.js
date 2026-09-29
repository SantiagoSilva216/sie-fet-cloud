// ============================================================
//  app.js  –  Integración con Backend Flask (FET S.I.E)
// ============================================================

const API_URL = 'https://sistema-fet-backend.onrender.com/api';
const CREDENCIALES = { usuario: 'admin', clave: '1234' };

let aforoMaximo = 150;
let puertoActual = 'COM3';
let monitorInterval = null;

// ============================================================
//  LOGIN / LOGOUT
// ============================================================

async function entrarSistema(e) {
    e.preventDefault();
    const usuario = document.getElementById('input-usuario').value.trim();
    const clave   = document.getElementById('input-clave').value;

    if (!usuario || !clave) {
        mostrarToast('Ingrese usuario y clave de acceso.', 'danger');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario, clave })
        });

        if (response.ok) {
            const data = await response.json();
            mostrarToast(`Bienvenido, ${data.usuario}`, 'ok');

            const loginScreen = document.getElementById('login-screen');
            loginScreen.style.opacity = '0';
            setTimeout(() => {
                loginScreen.style.display = 'none';
                document.getElementById('app-layout').style.display = 'flex';
                iniciarMonitor();
            }, 800);
        } else {
            const errData = await response.json();
            mostrarToast(errData.error || 'Credenciales incorrectas.', 'danger');
        }
    } catch (error) {
        mostrarToast('Error al conectar con el servidor de autenticación.', 'danger');
    }
}

function salirSistema() {
    if (monitorInterval) clearInterval(monitorInterval);
    document.getElementById('app-layout').style.display = 'none';
    const loginScreen = document.getElementById('login-screen');
    loginScreen.style.display = 'flex';
    loginScreen.style.opacity = '0';
    document.getElementById('input-usuario').value = '';
    document.getElementById('input-clave').value = '';
    setTimeout(() => loginScreen.style.opacity = '1', 50);
    mostrarToast('Sesión cerrada correctamente.', 'ok');
}

// ============================================================
//  NAVEGACIÓN ENTRE VISTAS
// ============================================================

function cambiarVista(idVista, btnElement) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view-section').forEach(v => v.classList.remove('active'));
    btnElement.classList.add('active');
    document.getElementById('vista-' + idVista).classList.add('active');

    if (idVista === 'estudiantes') cargarEstudiantes();
    if (idVista === 'reportes') cargarReportesHistorial();
}

// ============================================================
//  MONITOREO EN VIVO (POLLING A FLASK)
// ============================================================

function iniciarMonitor() {
    actualizarEstadoPuerto();
    obtenerMetricasYRegistros();
    
    // Consulta periódica cada 2 segundos
    if (monitorInterval) clearInterval(monitorInterval);
    monitorInterval = setInterval(obtenerMetricasYRegistros, 2000);
}

async function obtenerMetricasYRegistros() {
    try {
        // 1. Obtener Métricas
        const resStats = await fetch(`${API_URL}/stats`);
        if (resStats.ok) {
            const stats = await resStats.json();
            document.getElementById('aforo').innerText = stats.aforo;
            document.getElementById('ingresos').innerText = stats.ingresos;
            document.getElementById('alertas').innerText = stats.alertas;
        }

        // 2. Obtener ÚLtimos 5 Registros
        const resReg = await fetch(`${API_URL}/ultimos-registros`);
        if (resReg.ok) {
            const registros = await resReg.json();
            renderizarTablaMonitoreo(registros);
        }
    } catch (error) {
        console.error('Error al obtener datos en vivo:', error);
    }
}

function renderizarTablaMonitoreo(registros) {
    const tabla = document.getElementById('tabla-registros');
    const sinReg = document.getElementById('sin-registros');

    if (registros.length === 0) {
        sinReg.style.display = 'block';
        tabla.innerHTML = '';
        return;
    }

    sinReg.style.display = 'none';
    tabla.innerHTML = registros.map(reg => {
        const badgeClass = reg.estado === 'AUTORIZADO' ? 'badge ok' : 'badge warn';
        return `
            <tr>
                <td style="color: var(--text-muted);">${reg.fecha_hora}</td>
                <td>***${reg.idEstudiante}</td>
                <td class="rfid-tag">${reg.rfid_tag}</td>
                <td><span class="${badgeClass}">${reg.estado}</span></td>
            </tr>
        `;
    }).join('');
}

function limpiarRegistros() {
    document.getElementById('tabla-registros').innerHTML = '';
    document.getElementById('sin-registros').style.display = 'block';
    mostrarToast('Vista de monitor despejada.', 'ok');
}

function actualizarEstadoPuerto() {
    document.getElementById('estado-puerto').textContent = `Escuchando puerto ${puertoActual}...`;
}

// ============================================================
//  GESTIÓN DE ESTUDIANTES (MYSQL)
// ============================================================

async function cargarEstudiantes() {
    try {
        const response = await fetch(`${API_URL}/estudiantes`);
        const estudiantes = await response.json();
        const tbody = document.getElementById('tabla-estudiantes');

        tbody.innerHTML = estudiantes.map(est => {
            const esActivo = est.estado === 'ACTIVO';
            const badgeClass = esActivo ? 'badge ok' : 'badge warn';
            const btnTexto = esActivo ? 'Suspender' : 'Reactivar';
            const nuevoEstado = esActivo ? 'INACTIVO' : 'ACTIVO';

            return `
                <tr>
                    <td>${est.nombre}</td>
                    <td>${est.carrera}</td>
                    <td class="rfid-tag">${est.rfid_tag}</td>
                    <td><span class="${badgeClass}">${est.estado}</span></td>
                    <td>
                        <button class="btn-table-action" onclick="toggleEstado('${est.rfid_tag}', '${nuevoEstado}')">
                            ${btnTexto}
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (error) {
        mostrarToast('Error al cargar la lista de estudiantes.', 'danger');
    }
}

function abrirModalAsignar() {
    document.getElementById('modal-overlay').classList.add('visible');
    document.getElementById('modal-nombre').focus();
}

function cerrarModalDirect() {
    document.getElementById('modal-overlay').classList.remove('visible');
    document.getElementById('modal-nombre').value = '';
    document.getElementById('modal-carrera').value = '';
    document.getElementById('modal-tag').value = '';
}

function cerrarModal(e) {
    if (e.target.id === 'modal-overlay') cerrarModalDirect();
}

async function guardarEstudiante(e) {
    e.preventDefault();
    const nombre  = document.getElementById('modal-nombre').value.trim();
    const carrera = document.getElementById('modal-carrera').value.trim();
    const tag     = document.getElementById('modal-tag').value.trim().toUpperCase();
    const docFake = Math.floor(1000 + Math.random() * 9000).toString(); // Genera doc temporal

    try {
        const response = await fetch(`${API_URL}/estudiantes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre, carrera, rfid_tag: tag, documento: docFake })
        });

        if (response.ok) {
            cerrarModalDirect();
            cargarEstudiantes();
            mostrarToast(`Tarjeta ${tag} asignada a ${nombre}.`, 'ok');
        } else {
            const errData = await response.json();
            mostrarToast(`Error: ${errData.error || 'No se pudo guardar'}`, 'danger');
        }
    } catch (error) {
        mostrarToast('Error de conexión con el servidor.', 'danger');
    }
}

async function toggleEstado(tag, nuevoEstado) {
    try {
        const response = await fetch(`${API_URL}/estudiantes/estado`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rfid_tag: tag, estado: nuevoEstado })
        });

        if (response.ok) {
            cargarEstudiantes();
            mostrarToast(`Estado de la tarjeta ${tag} actualizado a ${nuevoEstado}.`, 'ok');
        }
    } catch (error) {
        mostrarToast('No se pudo actualizar el estado.', 'danger');
    }
}

// ============================================================
//  REPORTES DE SESIÓN
// ============================================================

async function cargarReportesHistorial() {
    document.getElementById('reporte-ingresos').innerText = document.getElementById('ingresos').innerText;
    document.getElementById('reporte-alertas').innerText = document.getElementById('alertas').innerText;
    document.getElementById('reporte-maximo').innerText = aforoMaximo;

    try {
        const res = await fetch(`${API_URL}/ultimos-registros`);
        const registros = await res.json();
        const tbody = document.getElementById('tabla-historial');
        const sinHist = document.getElementById('sin-historial');

        if (registros.length === 0) {
            sinHist.style.display = 'block';
            tbody.innerHTML = '';
            return;
        }

        sinHist.style.display = 'none';
        tbody.innerHTML = registros.map(reg => `
            <tr>
                <td style="color: var(--text-muted);">${reg.fecha_hora}</td>
                <td>***${reg.idEstudiante}</td>
                <td class="rfid-tag">${reg.rfid_tag}</td>
                <td><span class="${reg.estado === 'AUTORIZADO' ? 'badge ok' : 'badge warn'}">${reg.estado}</span></td>
            </tr>
        `).join('');
    } catch (error) {
        console.error('Error al cargar historial:', error);
    }
}

async function exportarReporte() {
    try {
        const res = await fetch(`${API_URL}/ultimos-registros`);
        const registros = await res.json();

        if (registros.length === 0) {
            mostrarToast('No hay datos para exportar.', 'danger');
            return;
        }

        let csv = 'Fecha_Hora,ID,Tag_RFID,Estado\n';
        registros.forEach(r => {
            csv += `${r.fecha_hora},***${r.idEstudiante},${r.rfid_tag},${r.estado}\n`;
        });

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `reporte_FET_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        mostrarToast('Reporte CSV descargado.', 'ok');
    } catch (e) {
        mostrarToast('Error al exportar reporte.', 'danger');
    }
}

// ============================================================
//  CONFIGURACIÓN
// ============================================================

function reconectarServicio(servicio) {
    const estadoEl = document.getElementById(`estado-${servicio}`);
    estadoEl.textContent = 'Reconectando...';
    estadoEl.style.color = 'var(--text-muted)';
    mostrarToast(`Reconectando ${servicio.toUpperCase()}...`, 'ok');

    setTimeout(() => {
        estadoEl.textContent = servicio === 'python' ? 'En Ejecucion' : 'Conectado';
        estadoEl.style.color = 'var(--primary)';
        mostrarToast(`${servicio.toUpperCase()} reconectado correctamente.`, 'ok');
    }, 1500);
}

function verLicencia() {
    mostrarToast('Licencia Privativa - FET Ingeniería de Software 2024. Todos los derechos reservados.', 'ok');
}

function guardarAforo() {
    const val = parseInt(document.getElementById('input-aforo-max').value);
    if (isNaN(val) || val < 1) {
        mostrarToast('Ingrese un aforo válido.', 'danger');
        return;
    }
    aforoMaximo = val;
    document.getElementById('reporte-maximo').innerText = aforoMaximo;
    mostrarToast(`Aforo máximo actualizado a ${aforoMaximo} personas.`, 'ok');
}

function guardarPuerto() {
    puertoActual = document.getElementById('select-puerto').value;
    actualizarEstadoPuerto();
    mostrarToast(`Puerto cambiado a ${puertoActual}.`, 'ok');
}

// ============================================================
//  TOAST DE NOTIFICACIÓN
// ============================================================

let toastTimeout = null;

function mostrarToast(mensaje, tipo = 'ok') {
    const toast = document.getElementById('toast');
    toast.textContent = mensaje;
    toast.className = `toast toast-${tipo} visible`;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('visible'), 3500);
}
