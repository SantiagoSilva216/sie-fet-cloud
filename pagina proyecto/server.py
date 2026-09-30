import os
import hashlib
from flask import Flask, request, jsonify
from flask_cors import CORS
import mysql.connector

app = Flask(__name__)
# CORS: permite peticiones desde Vercel, ESP32 y desarrollo local
CORS(app, resources={r"/api/*": {"origins": "*"}})
# Nota: en produccion puedes restringir a tu URL exacta de Vercel:
# CORS(app, origins=['https://tu-proyecto.vercel.app'])

# Buscar certificado SSL del sistema (necesario para TiDB Cloud en Render)
ssl_ca_path = '/etc/ssl/certs/ca-certificates.crt'
if not os.path.exists(ssl_ca_path):
    try:
        import certifi
        ssl_ca_path = certifi.where()
    except ImportError:
        ssl_ca_path = None

# Configuración de conexión a la base de datos MySQL en la nube (TiDB Cloud)
db_config = {
    'host': os.getenv('DB_HOST', 'gateway01.us-east-1.prod.aws.tidbcloud.com'),
    'user': os.getenv('DB_USER', '2SxF8EWuPc2rfLd.root'),
    'password': os.getenv('DB_PASSWORD', 'mJEr6FSHWRrehWlw'),
    'database': os.getenv('DB_NAME', 'fet_rfid'),
    'port': int(os.getenv('DB_PORT', 4000)),
}

# Activar SSL/TLS si existe la ruta de certificados
if ssl_ca_path:
    db_config['ssl_ca'] = ssl_ca_path
    db_config['ssl_verify_cert'] = True

def get_db_connection():
    return mysql.connector.connect(**db_config)


# 1. ENDPOINT PARA RECIBIR ESCANEOS RFID (Desde el ESP32 o Simulación Web)
@app.route('/api/rfid-scan', methods=['POST'])
def rfid_scan():
    data = request.json
    if not data or 'rfid_tag' not in data:
        return jsonify({'error': 'Tag RFID no proporcionado'}), 400

    rfid_tag = data.get('rfid_tag')

    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)

    # Buscar si el tag pertenece a un estudiante activo
    cursor.execute("SELECT * FROM estudiantes WHERE rfid_tag = %s AND estado = 'ACTIVO'", (rfid_tag,))
    estudiante = cursor.fetchone()

    if estudiante:
        doc_estudiante = estudiante['documento']
        estudiante_id  = estudiante['id']

        # Logica Ingreso / Salida: el campo 'dentro' indica presencia actual
        # 0 = afuera (siguiente scan = INGRESO), 1 = adentro (siguiente scan = SALIDA)
        esta_dentro = bool(estudiante.get('dentro', 0))

        if esta_dentro:
            # Ya estaba adentro → registrar SALIDA y marcarlo como afuera
            estado_registro = 'SALIDA'
            nuevo_dentro    = 0
        else:
            # Estaba afuera → registrar INGRESO y marcarlo como adentro
            estado_registro = 'INGRESO'
            nuevo_dentro    = 1

        # Actualizar presencia del estudiante
        cursor.execute(
            "UPDATE estudiantes SET dentro = %s WHERE id = %s",
            (nuevo_dentro, estudiante_id)
        )
    else:
        # Tag no registrado o estudiante suspendido
        estado_registro = 'DENEGADO'
        doc_estudiante  = '0000'
        estudiante_id   = None

    # Registrar el evento en el historial
    cursor.execute(
        "INSERT INTO registros_acceso (estudiante_id, rfid_tag, estado) VALUES (%s, %s, %s)",
        (estudiante_id, rfid_tag, estado_registro)
    )
    conn.commit()
    cursor.close()
    conn.close()

    return jsonify({
        'idEstudiante': doc_estudiante,
        'codigoRfid':   rfid_tag,
        'estadoStr':    estado_registro
    })


# 2. ENDPOINT PARA OBTENER LOS ÚLTIMOS 5 REGISTROS (Para Monitoreo en Vivo en el Frontend)
@app.route('/api/ultimos-registros', methods=['GET'])
def ultimos_registros():
    from datetime import timedelta
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)

    # Se trae fecha_hora como objeto datetime (sin DATE_FORMAT) para poder
    # ajustar la zona horaria en Python: Render corre en UTC, Colombia = UTC-5
    query = """
        SELECT r.id,
               r.fecha_hora,
               r.rfid_tag,
               r.estado,
               COALESCE(e.documento, '0000') AS idEstudiante,
               e.nombre                      AS nombre_estudiante
        FROM registros_acceso r
        LEFT JOIN estudiantes e ON r.estudiante_id = e.id
        ORDER BY r.id DESC LIMIT 5
    """
    cursor.execute(query)
    registros = cursor.fetchall()
    cursor.close()
    conn.close()

    # Ajustar zona horaria UTC → Colombia (UTC-5) y formatear como dd/mm/yyyy HH:MM:SS
    bogota = timedelta(hours=-5)
    for reg in registros:
        dt = reg.get('fecha_hora')
        if dt:
            try:
                dt_bogota = dt + bogota
                reg['fecha_hora'] = dt_bogota.strftime('%d/%m/%Y %H:%M:%S')
            except Exception:
                reg['fecha_hora'] = str(dt)
        else:
            reg['fecha_hora'] = ''
        # Asegurar que nombre_estudiante sea string o None
        if reg.get('nombre_estudiante') is None:
            reg['nombre_estudiante'] = None

    return jsonify(registros)


# 3. ENDPOINT PARA OBTENER ESTUDIANTES (Vista Estudiantes)
@app.route('/api/estudiantes', methods=['GET'])
def obtener_estudiantes():
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT id, documento, nombre, carrera, rfid_tag, estado FROM estudiantes")
    estudiantes = cursor.fetchall()

    cursor.close()
    conn.close()

    return jsonify(estudiantes)


# 4. ENDPOINT PARA CONTADORES Y ESTADÍSTICAS (Aforo, Ingresos y Alertas)
@app.route('/api/stats', methods=['GET'])
def obtener_estadisticas():
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)

    # Ingresos totales (INGRESO + AUTORIZADO legacy para compatibilidad)
    cursor.execute("""
        SELECT COUNT(*) AS total FROM registros_acceso
        WHERE estado IN ('INGRESO', 'AUTORIZADO')
    """)
    ingresos = cursor.fetchone()['total']

    # Salidas totales
    cursor.execute("SELECT COUNT(*) AS total FROM registros_acceso WHERE estado = 'SALIDA'")
    salidas = cursor.fetchone()['total']

    # Alertas (accesos denegados)
    cursor.execute("SELECT COUNT(*) AS total FROM registros_acceso WHERE estado = 'DENEGADO'")
    alertas = cursor.fetchone()['total']

    cursor.close()
    conn.close()

    # Aforo neto = ingresos - salidas (personas actualmente adentro)
    aforo_neto = max(0, ingresos - salidas)

    return jsonify({
        'aforo':    aforo_neto,
        'ingresos': ingresos,
        'salidas':  salidas,
        'alertas':  alertas
    })


# 5. ENDPOINT PARA AGREGAR UN NUEVO ESTUDIANTE
@app.route('/api/estudiantes', methods=['POST'])
def agregar_estudiante():
    data = request.json
    if not data or not all(k in data for k in ('nombre', 'carrera', 'rfid_tag', 'documento')):
        return jsonify({'error': 'Faltan datos obligatorios'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO estudiantes (documento, nombre, carrera, rfid_tag, estado) VALUES (%s, %s, %s, %s, 'ACTIVO')",
            (data['documento'], data['nombre'], data['carrera'], data['rfid_tag'])
        )
        conn.commit()
        cursor.close()
        conn.close()
        return jsonify({'mensaje': 'Estudiante registrado correctamente'}), 201
    except mysql.connector.Error as err:
        return jsonify({'error': str(err)}), 400


# 6. ENDPOINT PARA CAMBIAR ESTADO DE UN ESTUDIANTE (SUSPENDER/REACTIVAR)
@app.route('/api/estudiantes/estado', methods=['PUT'])
def cambiar_estado_estudiante():
    data = request.json
    rfid_tag = data.get('rfid_tag')
    nuevo_estado = data.get('estado')  # 'ACTIVO' o 'INACTIVO'

    if not rfid_tag or not nuevo_estado:
        return jsonify({'error': 'Parámetros incompletos'}), 400

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE estudiantes SET estado = %s WHERE rfid_tag = %s", (nuevo_estado, rfid_tag))
    conn.commit()
    cursor.close()
    conn.close()

    return jsonify({'mensaje': f'Estado actualizado a {nuevo_estado}'})


# 7. ENDPOINT PARA AUTENTICACIÓN DE USUARIOS
@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    if not data or 'usuario' not in data or 'clave' not in data:
        return jsonify({'error': 'Usuario y clave requeridos'}), 400

    usuario_input = data.get('usuario').strip()
    clave_input = data.get('clave')

    # Generación de hash SHA-256 para la contraseña ingresada
    clave_hash = hashlib.sha256(clave_input.encode('utf-8')).hexdigest()

    try:
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)

        cursor.execute(
            "SELECT id, usuario, rol FROM usuarios WHERE usuario = %s AND password_hash = %s",
            (usuario_input, clave_hash)
        )
        usuario = cursor.fetchone()

        cursor.close()
        conn.close()

        if usuario:
            return jsonify({
                'mensaje': 'Autenticación exitosa',
                'usuario': usuario['usuario'],
                'rol': usuario['rol']
            }), 200
        else:
            return jsonify({'error': 'Credenciales inválidas'}), 401

    except mysql.connector.Error as err:
        return jsonify({'error': str(err)}), 500


# 8. ENDPOINT PARA ELIMINAR TODOS LOS REGISTROS DE ACCESO
@app.route('/api/registros', methods=['DELETE'])
def eliminar_registros():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM registros_acceso")
        filas_eliminadas = cursor.rowcount
        conn.commit()
        cursor.close()
        conn.close()
        return jsonify({'mensaje': f'{filas_eliminadas} registros eliminados correctamente'}), 200
    except mysql.connector.Error as err:
        return jsonify({'error': str(err)}), 500



# 9. ENDPOINT PARA ELIMINAR UN ESTUDIANTE Y SUS REGISTROS DE ACCESO
@app.route('/api/estudiantes/<rfid_tag>', methods=['DELETE'])
def eliminar_estudiante(rfid_tag):
    try:
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)

        # Verificar que el estudiante existe
        cursor.execute("SELECT id, nombre FROM estudiantes WHERE rfid_tag = %s", (rfid_tag,))
        estudiante = cursor.fetchone()
        if not estudiante:
            cursor.close()
            conn.close()
            return jsonify({'error': 'Estudiante no encontrado'}), 404

        # Eliminar sus registros de acceso primero (integridad referencial)
        cursor.execute("DELETE FROM registros_acceso WHERE estudiante_id = %s", (estudiante['id'],))
        registros_eliminados = cursor.rowcount

        # Eliminar el estudiante
        cursor.execute("DELETE FROM estudiantes WHERE rfid_tag = %s", (rfid_tag,))
        conn.commit()
        cursor.close()
        conn.close()

        return jsonify({
            'mensaje': f"Estudiante '{estudiante['nombre']}' eliminado correctamente",
            'registros_acceso_eliminados': registros_eliminados
        }), 200
    except mysql.connector.Error as err:
        return jsonify({'error': str(err)}), 500


if __name__ == '__main__':

    port = int(os.environ.get('PORT', 5000))
    # debug=False en produccion (Render)
    app.run(host='0.0.0.0', port=port, debug=os.environ.get('FLASK_DEBUG', 'false').lower() == 'true')
