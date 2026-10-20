import os
import re
import hmac
import hashlib
from contextlib import contextmanager
from datetime import timedelta
from functools import wraps
 
from flask import Flask, request, jsonify, g
from flask_cors import CORS
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import generate_password_hash, check_password_hash
import mysql.connector
 
# ============================================================
#  S.I.E - FET  |  Backend Flask (versión con seguridad reforzada)
#  Todas las credenciales y claves vienen de variables de entorno.
#  Variables OBLIGATORIAS: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME,
#                          SECRET_KEY, DEVICE_API_KEY
#  Variables opcionales:   DB_PORT (4000), ALLOWED_ORIGINS, TOKEN_HORAS (8),
#                          BLOQUEO_INTENTOS (5), BLOQUEO_MINUTOS (15),
#                          RETENCION_DIAS (365), PORT, FLASK_DEBUG
# ============================================================
 
 
def _requerida(nombre):
    valor = os.getenv(nombre)
    if not valor:
        raise RuntimeError(f'Falta la variable de entorno obligatoria {nombre}')
    return valor
 
 
app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024  # 16 KB: las peticiones son JSON pequeños
# Render y Vercel están detrás de un proxy: así request.remote_addr es la IP real del cliente
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)
 
SECRET_KEY = _requerida('SECRET_KEY')
DEVICE_API_KEY = _requerida('DEVICE_API_KEY')
TOKEN_HORAS = int(os.getenv('TOKEN_HORAS', '8'))
BLOQUEO_INTENTOS = int(os.getenv('BLOQUEO_INTENTOS', '5'))
BLOQUEO_MINUTOS = int(os.getenv('BLOQUEO_MINUTOS', '15'))
RETENCION_DIAS = int(os.getenv('RETENCION_DIAS', '365'))
ROL_ADMIN = 'Administrador'
# Nombres de rol que cuentan como administrador (sin importar mayúsculas ni espacios)
ROLES_ADMIN = {'administrador', 'administradora', 'admin', 'administrator', 'superadmin'}
 
 
def es_admin(rol):
    return str(rol or '').strip().lower() in ROLES_ADMIN
 
serializer = URLSafeTimedSerializer(SECRET_KEY, salt='sie-fet-auth')
 
# CORS restringido: solo el frontend autorizado (el ESP32 no usa CORS)
ORIGENES = [o.strip() for o in os.getenv(
    'ALLOWED_ORIGINS', 'https://sie-fet-frontend.vercel.app').split(',') if o.strip()]
CORS(app,
     resources={r'/api/*': {'origins': ORIGENES}},
     allow_headers=['Content-Type', 'Authorization', 'X-Device-Key'],
     methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'])
 
# Certificado SSL (necesario para TiDB Cloud)
ssl_ca_path = '/etc/ssl/certs/ca-certificates.crt'
if not os.path.exists(ssl_ca_path):
    try:
        import certifi
        ssl_ca_path = certifi.where()
    except ImportError:
        ssl_ca_path = None
 
db_config = {
    'host': _requerida('DB_HOST'),
    'user': _requerida('DB_USER'),
    'password': _requerida('DB_PASSWORD'),
    'database': _requerida('DB_NAME'),
    'port': int(os.getenv('DB_PORT', '4000')),
}
if ssl_ca_path:
    db_config['ssl_ca'] = ssl_ca_path
    db_config['ssl_verify_cert'] = True
 
ANTIREBOTE_SEGUNDOS = 5
 
# La BD guarda la hora en UTC (Render/TiDB); Colombia es UTC-5 todo el año
OFFSET_HORAS = 5
FECHA_LOCAL_SQL = f'(r.fecha_hora - INTERVAL {OFFSET_HORAS} HOUR)'
 
RE_TAG = re.compile(r'^[0-9A-Z-]{4,32}$')
RE_DOC = re.compile(r'^[0-9A-Za-z]{4,20}$')
RE_HASH_LEGADO = re.compile(r'^[0-9a-f]{64}$')  # SHA-256 antiguo (sin sal)
HASH_FICTICIO = generate_password_hash('contraseña-ficticia', method='pbkdf2:sha256')
 
# Tag normalizado en la BD: sin espacios, ':' ni '-', y en MAYÚSCULAS.
# TiDB compara texto distinguiendo mayúsculas (utf8mb4_bin), así que 'a3f2c1d4' != 'A3F2C1D4'.
TAG_SQL = "UPPER(REPLACE(REPLACE(REPLACE(TRIM(rfid_tag), ' ', ''), ':', ''), '-', ''))"
 
 
def normalizar_tag(valor):
    """Deja el tag igual a como lo envía el ESP32: hexadecimal en mayúsculas, sin separadores."""
    return re.sub(r'[\s:\-]', '', str(valor or '')).upper()
 
 
# ------------------------------------------------------------
#  Utilidades
# ------------------------------------------------------------
@contextmanager
def db(dictionary=True):
    """Abre conexión + cursor, confirma al terminar y siempre cierra."""
    conn = mysql.connector.connect(**db_config)
    cur = conn.cursor(dictionary=dictionary)
    try:
        yield conn, cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()
 
 
def enmascarar(documento):
    """El documento completo nunca sale del servidor: ***4589."""
    s = str(documento or '0000')
    return '***' + s[-4:]
 
 
def texto_valido(valor, minimo=2, maximo=100):
    return (isinstance(valor, str) and minimo <= len(valor.strip()) <= maximo
            and not re.search(r'[\x00-\x1f<>]', valor))
 
 
def auditar(usuario, accion, detalle=''):
    """Bitácora de auditoría: quién hizo qué y cuándo (sin datos sensibles)."""
    try:
        with db(False) as (_, cur):
            cur.execute(
                "INSERT INTO auditoria (usuario, accion, detalle, ip) VALUES (%s, %s, %s, %s)",
                (usuario, accion, str(detalle)[:255], request.remote_addr))
    except mysql.connector.Error:
        app.logger.exception('No se pudo escribir en la auditoría')
 
 
def requiere_auth(solo_admin=False):
    def decorador(f):
        @wraps(f)
        def envoltura(*args, **kwargs):
            cabecera = request.headers.get('Authorization', '')
            if not cabecera.startswith('Bearer '):
                return jsonify({'error': 'No autenticado'}), 401
            try:
                datos = serializer.loads(cabecera[7:], max_age=TOKEN_HORAS * 3600)
            except SignatureExpired:
                return jsonify({'error': 'Sesión expirada'}), 401
            except BadSignature:
                return jsonify({'error': 'Token inválido'}), 401
            g.usuario, g.rol = datos['u'], datos['r']
            if solo_admin and not es_admin(g.rol):
                auditar(g.usuario, 'ACCESO_NO_PERMITIDO', f'{request.method} {request.path}')
                return jsonify({'error': 'Permisos insuficientes'}), 403
            return f(*args, **kwargs)
        return envoltura
    return decorador
 
 
def requiere_dispositivo(f):
    @wraps(f)
    def envoltura(*args, **kwargs):
        clave = request.headers.get('X-Device-Key', '')
        if not hmac.compare_digest(clave.encode(), DEVICE_API_KEY.encode()):
            auditar('dispositivo', 'DISPOSITIVO_NO_AUTORIZADO', request.path)
            return jsonify({'error': 'Dispositivo no autorizado'}), 401
        return f(*args, **kwargs)
    return envoltura
 
 
@app.after_request
def cabeceras_seguridad(resp):
    resp.headers['X-Content-Type-Options'] = 'nosniff'
    resp.headers['Referrer-Policy'] = 'no-referrer'
    resp.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    if request.path.startswith('/api/'):
        resp.headers['Cache-Control'] = 'no-store'
    return resp
 
 
@app.errorhandler(mysql.connector.Error)
def error_bd(err):
    app.logger.exception('Error de base de datos')  # el detalle queda en el log, no en la respuesta
    if getattr(err, 'errno', None) == 1062:
        return jsonify({'error': 'El documento o el tag ya están registrados'}), 409
    return jsonify({'error': 'Error interno del servidor'}), 500
 
 
@app.errorhandler(413)
def demasiado_grande(_):
    return jsonify({'error': 'Petición demasiado grande'}), 413
 
 
# ------------------------------------------------------------
#  1. Escaneo RFID (solo dispositivos con X-Device-Key)
# ------------------------------------------------------------
@app.route('/api/rfid-scan', methods=['POST'])
@requiere_dispositivo
def rfid_scan():
    data = request.get_json(silent=True) or {}
    rfid_tag = normalizar_tag(data.get('rfid_tag', ''))
    if not RE_TAG.match(rfid_tag):
        return jsonify({'error': 'Tag RFID inválido'}), 400
 
    with db() as (_, cursor):
        cursor.execute(
            """SELECT r.estado, e.nombre, TIMESTAMPDIFF(SECOND, r.fecha_hora, NOW()) AS seg
               FROM registros_acceso r
               LEFT JOIN estudiantes e ON r.estudiante_id = e.id
               WHERE r.rfid_tag = %s ORDER BY r.id DESC LIMIT 1""",
            (rfid_tag,))
        ultimo = cursor.fetchone()
        if ultimo and ultimo['seg'] is not None and ultimo['seg'] < ANTIREBOTE_SEGUNDOS:
            return jsonify({
                'idEstudiante': None,
                'codigoRfid': rfid_tag,
                'estadoStr': ultimo['estado'],
                'nombre': ultimo.get('nombre') or 'No registrado',
                'ignorado': True
            })
 
        # Se busca el tag SIN filtrar por estado, comparando ambos lados normalizados
        cursor.execute(f"SELECT * FROM estudiantes WHERE {TAG_SQL} = %s", (rfid_tag,))
        estudiante = cursor.fetchone()
        activo = bool(estudiante) and str(estudiante.get('estado') or '').strip().upper() == 'ACTIVO'
 
        if activo:
            estudiante_id = estudiante['id']
            doc = estudiante['documento']
            nombre = estudiante['nombre']
            if bool(estudiante.get('dentro', 0)):
                estado_registro, nuevo_dentro = 'SALIDA', 0
            else:
                estado_registro, nuevo_dentro = 'INGRESO', 1
            cursor.execute("UPDATE estudiantes SET dentro = %s WHERE id = %s", (nuevo_dentro, estudiante_id))
        elif estudiante:
            # Registrado pero desactivado: se deja el nombre para que el panel muestre "(suspendido)"
            estado_registro, doc, estudiante_id, nombre = 'DENEGADO', estudiante['documento'], estudiante['id'], estudiante['nombre']
            app.logger.warning('Tag %s DENEGADO: estudiante inactivo (estado=%r)', rfid_tag, estudiante.get('estado'))
        else:
            estado_registro, doc, estudiante_id, nombre = 'DENEGADO', '0000', None, 'No registrado'
            app.logger.warning('Tag %s DENEGADO: no existe en la tabla estudiantes', rfid_tag)
 
        cursor.execute(
            "INSERT INTO registros_acceso (estudiante_id, rfid_tag, estado) VALUES (%s, %s, %s)",
            (estudiante_id, rfid_tag, estado_registro))
 
    return jsonify({
        'idEstudiante': enmascarar(doc),
        'codigoRfid': rfid_tag,
        'estadoStr': estado_registro,
        'nombre': nombre
    })
 
 
# ------------------------------------------------------------
#  2. Monitoreo en vivo
# ------------------------------------------------------------
@app.route('/api/ultimos-registros', methods=['GET'])
@requiere_auth()
def ultimos_registros():
    with db() as (_, cursor):
        cursor.execute("""
            SELECT r.id, r.fecha_hora, r.rfid_tag, r.estado,
                   COALESCE(e.documento, '0000') AS idEstudiante,
                   e.nombre AS nombre_estudiante
            FROM registros_acceso r
            LEFT JOIN estudiantes e ON r.estudiante_id = e.id
            ORDER BY r.id DESC LIMIT 5
        """)
        registros = cursor.fetchall()
 
    bogota = timedelta(hours=-5)  # Render corre en UTC; Colombia = UTC-5
    for reg in registros:
        dt = reg.get('fecha_hora')
        try:
            reg['fecha_hora'] = (dt + bogota).strftime('%d/%m/%Y %H:%M:%S') if dt else ''
        except Exception:
            reg['fecha_hora'] = str(dt)
        reg['idEstudiante'] = enmascarar(reg['idEstudiante'])  # enmascarado en el servidor
    return jsonify(registros)
 
 
@app.route('/api/stats', methods=['GET'])
@requiere_auth()
def obtener_estadisticas():
    with db() as (_, cursor):
        cursor.execute("SELECT COUNT(*) AS total FROM registros_acceso WHERE estado IN ('INGRESO', 'AUTORIZADO')")
        ingresos = cursor.fetchone()['total']
        cursor.execute("SELECT COUNT(*) AS total FROM registros_acceso WHERE estado = 'SALIDA'")
        salidas = cursor.fetchone()['total']
        cursor.execute("SELECT COUNT(*) AS total FROM registros_acceso WHERE estado = 'DENEGADO'")
        alertas = cursor.fetchone()['total']
        cursor.execute("SELECT COUNT(*) AS total FROM estudiantes WHERE dentro = 1")
        aforo = cursor.fetchone()['total']
        # Totales del día en hora de Colombia (la BD guarda UTC)
        cursor.execute(f"""SELECT
                SUM(estado IN ('INGRESO', 'AUTORIZADO')) AS ingresos_hoy,
                SUM(estado = 'SALIDA') AS salidas_hoy,
                SUM(estado = 'DENEGADO') AS alertas_hoy
            FROM registros_acceso r
            WHERE r.fecha_hora >= NOW() - INTERVAL 2 DAY
              AND DATE({FECHA_LOCAL_SQL}) = DATE(NOW() - INTERVAL {OFFSET_HORAS} HOUR)""")
        hoy = cursor.fetchone()
    return jsonify({'aforo': aforo, 'ingresos': ingresos, 'salidas': salidas, 'alertas': alertas,
                    'ingresos_hoy': int(hoy['ingresos_hoy'] or 0), 'salidas_hoy': int(hoy['salidas_hoy'] or 0),
                    'alertas_hoy': int(hoy['alertas_hoy'] or 0)})
 
 
# ------------------------------------------------------------
#  2b. Reportes filtrables (Objetivo específico 3 / RF05)
# ------------------------------------------------------------
RE_FECHA = re.compile(r'^\d{4}-\d{2}-\d{2}$')
RE_HORA = re.compile(r'^\d{2}:\d{2}$')
ESTADOS_REPORTE = ('INGRESO', 'SALIDA', 'DENEGADO')
MAX_FILAS_REPORTE = 2000
 
 
@app.route('/api/reportes/registros', methods=['GET'])
@requiere_auth()
def reporte_registros():
    """Historial de ingresos y salidas filtrado por rango de fechas, franja horaria,
    estudiante (nombre, carrera o tag) y estado. Fechas y horas en hora de Colombia."""
    a = request.args
    desde, hasta = a.get('desde', ''), a.get('hasta', '')
    hora_desde, hora_hasta = a.get('hora_desde', ''), a.get('hora_hasta', '')
    texto = a.get('q', '').strip()[:50]
    estado = a.get('estado', '').strip().upper()
 
    for f in (desde, hasta):
        if f and not RE_FECHA.match(f):
            return jsonify({'error': 'Fecha inválida (use AAAA-MM-DD)'}), 400
    for h in (hora_desde, hora_hasta):
        if h and not RE_HORA.match(h):
            return jsonify({'error': 'Hora inválida (use HH:MM)'}), 400
    if estado and estado not in ESTADOS_REPORTE:
        return jsonify({'error': 'Estado inválido'}), 400
    if texto and re.search(r'[\x00-\x1f<>]', texto):
        return jsonify({'error': 'Búsqueda inválida'}), 400
 
    condiciones, valores = [], []
    if desde:
        condiciones.append(f'DATE({FECHA_LOCAL_SQL}) >= %s'); valores.append(desde)
    if hasta:
        condiciones.append(f'DATE({FECHA_LOCAL_SQL}) <= %s'); valores.append(hasta)
    if hora_desde:
        condiciones.append(f'TIME({FECHA_LOCAL_SQL}) >= %s'); valores.append(hora_desde + ':00')
    if hora_hasta:
        condiciones.append(f'TIME({FECHA_LOCAL_SQL}) <= %s'); valores.append(hora_hasta + ':59')
    if estado == 'INGRESO':
        condiciones.append("r.estado IN ('INGRESO', 'AUTORIZADO')")
    elif estado:
        condiciones.append('r.estado = %s'); valores.append(estado)
    if texto:
        like = '%' + texto.replace('\\', '').replace('%', '').replace('_', '') + '%'
        condiciones.append('(e.nombre LIKE %s OR e.carrera LIKE %s OR UPPER(r.rfid_tag) LIKE UPPER(%s))')
        valores += [like, like, like]
 
    where = ('WHERE ' + ' AND '.join(condiciones)) if condiciones else ''
    with db() as (_, cursor):
        cursor.execute(f"""
            SELECT r.id, {FECHA_LOCAL_SQL} AS fecha_local, r.rfid_tag, r.estado,
                   COALESCE(e.documento, '0000') AS documento, e.nombre, e.carrera
            FROM registros_acceso r
            LEFT JOIN estudiantes e ON r.estudiante_id = e.id
            {where}
            ORDER BY r.fecha_hora ASC, r.id ASC
            LIMIT {MAX_FILAS_REPORTE + 1}""", tuple(valores))
        filas = cursor.fetchall()
 
    truncado = len(filas) > MAX_FILAS_REPORTE
    filas = filas[:MAX_FILAS_REPORTE]
    resultado = [{
        'id': f['id'],
        'fecha': f['fecha_local'].strftime('%Y-%m-%d') if f['fecha_local'] else '',
        'hora': f['fecha_local'].strftime('%H:%M:%S') if f['fecha_local'] else '',
        'idEstudiante': enmascarar(f['documento']),
        'nombre': f['nombre'] or 'No registrado',
        'carrera': f['carrera'] or '',
        'rfid_tag': f['rfid_tag'],
        'estado': 'INGRESO' if f['estado'] == 'AUTORIZADO' else f['estado'],
    } for f in filas]
    auditar(g.usuario, 'REPORTE_CONSULTADO', f'desde={desde} hasta={hasta} filas={len(resultado)}')
    return jsonify({'registros': resultado, 'total': len(resultado), 'truncado': truncado})
 
 
@app.route('/api/reportes/dentro', methods=['GET'])
@requiere_auth()
def reporte_dentro():
    """Estudiantes que registraron ingreso y aún no su salida, con la hora de su último ingreso."""
    with db() as (_, cursor):
        cursor.execute(f"""
            SELECT e.nombre, e.carrera, e.documento, e.rfid_tag,
                   (SELECT {FECHA_LOCAL_SQL} FROM registros_acceso r
                     WHERE r.estudiante_id = e.id AND r.estado IN ('INGRESO', 'AUTORIZADO')
                     ORDER BY r.id DESC LIMIT 1) AS ultimo_ingreso
            FROM estudiantes e
            WHERE e.dentro = 1
            ORDER BY e.nombre""")
        filas = cursor.fetchall()
    return jsonify([{
        'nombre': f['nombre'], 'carrera': f['carrera'], 'idEstudiante': enmascarar(f['documento']),
        'rfid_tag': f['rfid_tag'],
        'ultimo_ingreso': f['ultimo_ingreso'].strftime('%Y-%m-%d %H:%M:%S') if f['ultimo_ingreso'] else '',
    } for f in filas])
 
 
# ------------------------------------------------------------
#  3. Estudiantes
# ------------------------------------------------------------
@app.route('/api/estudiantes', methods=['GET'])
@requiere_auth()
def obtener_estudiantes():
    with db() as (_, cursor):
        cursor.execute("SELECT id, documento, nombre, carrera, rfid_tag, estado, autorizacion_datos FROM estudiantes")
        estudiantes = cursor.fetchall()
    for e in estudiantes:
        e['documento'] = enmascarar(e['documento'])
    return jsonify(estudiantes)
 
 
@app.route('/api/estudiantes', methods=['POST'])
@requiere_auth(solo_admin=True)
def agregar_estudiante():
    data = request.get_json(silent=True) or {}
    documento = str(data.get('documento', '')).strip()
    nombre = data.get('nombre', '')
    carrera = data.get('carrera', '')
    rfid_tag = normalizar_tag(data.get('rfid_tag', ''))
 
    if not (RE_DOC.match(documento) and texto_valido(nombre) and texto_valido(carrera) and RE_TAG.match(rfid_tag)):
        return jsonify({'error': 'Datos inválidos: revise documento, nombre, carrera y tag'}), 400
    if data.get('autorizacion') is not True:
        return jsonify({'error': 'Se requiere la autorización del titular para el tratamiento de sus datos'}), 400
 
    with db() as (_, cursor):
        cursor.execute(
            """INSERT INTO estudiantes (documento, nombre, carrera, rfid_tag, estado, autorizacion_datos, fecha_autorizacion)
               VALUES (%s, %s, %s, %s, 'ACTIVO', 1, NOW())""",
            (documento, nombre.strip(), carrera.strip(), rfid_tag))
    auditar(g.usuario, 'ESTUDIANTE_CREADO', f'tag={rfid_tag}')
    return jsonify({'mensaje': 'Estudiante registrado correctamente'}), 201
 
 
@app.route('/api/estudiantes/estado', methods=['PUT'])
@requiere_auth(solo_admin=True)
def cambiar_estado_estudiante():
    data = request.get_json(silent=True) or {}
    rfid_tag = normalizar_tag(data.get('rfid_tag', ''))
    nuevo_estado = data.get('estado')
    if not RE_TAG.match(rfid_tag) or nuevo_estado not in ('ACTIVO', 'INACTIVO'):
        return jsonify({'error': 'Parámetros inválidos'}), 400
 
    with db() as (_, cursor):
        cursor.execute(f"UPDATE estudiantes SET estado = %s, dentro = 0 WHERE {TAG_SQL} = %s", (nuevo_estado, rfid_tag))
    auditar(g.usuario, 'ESTADO_CAMBIADO', f'tag={rfid_tag} estado={nuevo_estado}')
    return jsonify({'mensaje': f'Estado actualizado a {nuevo_estado}'})
 
 
@app.route('/api/estudiantes/<rfid_tag>', methods=['PUT'])
@requiere_auth(solo_admin=True)
def rectificar_estudiante(rfid_tag):
    """Derecho de actualización/rectificación del titular (Ley 1581)."""
    rfid_tag = normalizar_tag(rfid_tag)
    data = request.get_json(silent=True) or {}
    campos, valores = [], []
    if 'nombre' in data:
        if not texto_valido(data['nombre']):
            return jsonify({'error': 'Nombre inválido'}), 400
        campos.append('nombre = %s'); valores.append(data['nombre'].strip())
    if 'carrera' in data:
        if not texto_valido(data['carrera']):
            return jsonify({'error': 'Carrera inválida'}), 400
        campos.append('carrera = %s'); valores.append(data['carrera'].strip())
    if 'documento' in data:
        if not RE_DOC.match(str(data['documento'])):
            return jsonify({'error': 'Documento inválido'}), 400
        campos.append('documento = %s'); valores.append(str(data['documento']))
    if not RE_TAG.match(rfid_tag) or not campos:
        return jsonify({'error': 'Nada que actualizar'}), 400
 
    with db() as (_, cursor):
        cursor.execute(f"UPDATE estudiantes SET {', '.join(campos)} WHERE {TAG_SQL} = %s", (*valores, rfid_tag))
    auditar(g.usuario, 'ESTUDIANTE_RECTIFICADO', f'tag={rfid_tag} campos={",".join(c.split(" ")[0] for c in campos)}')
    return jsonify({'mensaje': 'Datos actualizados'})
 
 
@app.route('/api/estudiantes/<rfid_tag>/datos', methods=['GET'])
@requiere_auth(solo_admin=True)
def consultar_datos_titular(rfid_tag):
    """Derecho de acceso/consulta: entrega TODOS los datos de un titular (documento completo)."""
    rfid_tag = normalizar_tag(rfid_tag)
    if not RE_TAG.match(rfid_tag):
        return jsonify({'error': 'Tag inválido'}), 400
    with db() as (_, cursor):
        cursor.execute("SELECT id, documento, nombre, carrera, rfid_tag, estado, autorizacion_datos, fecha_autorizacion "
                       f"FROM estudiantes WHERE {TAG_SQL} = %s", (rfid_tag,))
        est = cursor.fetchone()
        if not est:
            return jsonify({'error': 'Estudiante no encontrado'}), 404
        cursor.execute("SELECT fecha_hora, estado FROM registros_acceso WHERE estudiante_id = %s "
                       "ORDER BY id DESC LIMIT 500", (est['id'],))
        accesos = cursor.fetchall()
    est['fecha_autorizacion'] = str(est['fecha_autorizacion']) if est['fecha_autorizacion'] else None
    for a in accesos:
        a['fecha_hora'] = str(a['fecha_hora'])
    auditar(g.usuario, 'CONSULTA_TITULAR', f'tag={rfid_tag}')
    return jsonify({'estudiante': est, 'accesos': accesos})
 
 
@app.route('/api/estudiantes/<rfid_tag>', methods=['DELETE'])
@requiere_auth(solo_admin=True)
def eliminar_estudiante(rfid_tag):
    """Derecho de supresión: borra al estudiante y sus registros de acceso."""
    rfid_tag = normalizar_tag(rfid_tag)
    if not RE_TAG.match(rfid_tag):
        return jsonify({'error': 'Tag inválido'}), 400
    with db() as (_, cursor):
        cursor.execute(f"SELECT id, nombre FROM estudiantes WHERE {TAG_SQL} = %s", (rfid_tag,))
        estudiante = cursor.fetchone()
        if not estudiante:
            return jsonify({'error': 'Estudiante no encontrado'}), 404
        cursor.execute("DELETE FROM registros_acceso WHERE estudiante_id = %s", (estudiante['id'],))
        eliminados = cursor.rowcount
        cursor.execute("DELETE FROM estudiantes WHERE id = %s", (estudiante['id'],))
    auditar(g.usuario, 'ESTUDIANTE_ELIMINADO', f'tag={rfid_tag} registros={eliminados}')
    return jsonify({'mensaje': f"Estudiante '{estudiante['nombre']}' eliminado correctamente",
                    'registros_acceso_eliminados': eliminados}), 200
 
 
# ------------------------------------------------------------
#  4. Autenticación
# ------------------------------------------------------------
@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json(silent=True) or {}
    usuario_input = str(data.get('usuario', '')).strip()[:50]
    clave = str(data.get('clave', ''))
    if not usuario_input or not clave or len(clave) > 128:
        return jsonify({'error': 'Usuario y clave requeridos'}), 400
 
    with db() as (_, cursor):
        # Bloqueo temporal tras demasiados intentos fallidos (por IP o por usuario)
        cursor.execute(
            """SELECT COUNT(*) AS n FROM auditoria
               WHERE accion = 'LOGIN_FALLIDO' AND fecha_hora > NOW() - INTERVAL %s MINUTE
                 AND (ip = %s OR usuario = %s)""",
            (BLOQUEO_MINUTOS, request.remote_addr, usuario_input))
        if cursor.fetchone()['n'] >= BLOQUEO_INTENTOS:
            return jsonify({'error': f'Demasiados intentos. Espere {BLOQUEO_MINUTOS} minutos.'}), 429
 
        cursor.execute("SELECT id, usuario, rol, password_hash FROM usuarios WHERE usuario = %s", (usuario_input,))
        u = cursor.fetchone()
        ok = False
        if u and RE_HASH_LEGADO.match(u['password_hash']):
            # Hash SHA-256 antiguo: se valida y se migra de forma transparente a PBKDF2 con sal
            ok = hmac.compare_digest(hashlib.sha256(clave.encode('utf-8')).hexdigest(), u['password_hash'])
            if ok:
                cursor.execute("UPDATE usuarios SET password_hash = %s WHERE id = %s",
                               (generate_password_hash(clave, method='pbkdf2:sha256'), u['id']))
        elif u:
            ok = check_password_hash(u['password_hash'], clave)
        else:
            check_password_hash(HASH_FICTICIO, clave)  # mismo tiempo de respuesta: no revela si el usuario existe
 
    if not ok:
        auditar(usuario_input, 'LOGIN_FALLIDO')
        return jsonify({'error': 'Credenciales inválidas'}), 401
 
    auditar(u['usuario'], 'LOGIN_OK')
    token = serializer.dumps({'u': u['usuario'], 'r': u['rol']})
    return jsonify({'mensaje': 'Autenticación exitosa', 'usuario': u['usuario'], 'rol': u['rol'],
                    'token': token, 'expira_horas': TOKEN_HORAS}), 200
 
 
# ------------------------------------------------------------
#  5. Registros y retención
# ------------------------------------------------------------
@app.route('/api/registros', methods=['DELETE'])
@requiere_auth(solo_admin=True)
def eliminar_registros():
    with db() as (_, cursor):
        cursor.execute("DELETE FROM registros_acceso")
        filas = cursor.rowcount
        cursor.execute("UPDATE estudiantes SET dentro = 0")
    auditar(g.usuario, 'REGISTROS_ELIMINADOS', f'filas={filas}')
    return jsonify({'mensaje': f'{filas} registros eliminados correctamente'}), 200
 
 
@app.route('/api/privacidad/purgar', methods=['POST'])
@requiere_auth(solo_admin=True)
def purgar_registros_antiguos():
    """Política de retención: elimina registros de acceso con más de RETENCION_DIAS días."""
    with db() as (_, cursor):
        cursor.execute("DELETE FROM registros_acceso WHERE fecha_hora < NOW() - INTERVAL %s DAY", (RETENCION_DIAS,))
        filas = cursor.rowcount
    auditar(g.usuario, 'PURGA_RETENCION', f'filas={filas} dias={RETENCION_DIAS}')
    return jsonify({'mensaje': f'{filas} registros anteriores a {RETENCION_DIAS} días eliminados'}), 200
 
 
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=os.environ.get('FLASK_DEBUG', 'false').lower() == 'true')
 
