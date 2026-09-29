import os
import hashlib
from flask import Flask, request, jsonify
from flask_cors import CORS
import mysql.connector

app = Flask(__name__)
CORS(app)  # Permite peticiones desde la interfaz web y dispositivos externos (como el ESP32)

# Configuración de conexión a la base de datos MySQL en la nube (TiDB Cloud)
db_config = {
    'host': os.getenv('DB_HOST', 'gateway01.us-east-1.prod.aws.tidbcloud.com'),
    'user': os.getenv('DB_USER', '2SxF8EWuPc2rfLd.root'),
    'password': os.getenv('DB_PASSWORD', 'mJEr6FSHWRrehWlw'),
    'database': os.getenv('DB_NAME', 'fet_rfid'),
    'port': int(os.getenv('DB_PORT', 4000))
}

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
        estado_registro = 'AUTORIZADO'
        doc_estudiante = estudiante['documento']
        estudiante_id = estudiante['id']
    else:
        estado_registro = 'DENEGADO'
        doc_estudiante = '0000'
        estudiante_id = None

    # Registrar el acceso en el historial
    cursor.execute(
        "INSERT INTO registros_acceso (estudiante_id, rfid_tag, estado) VALUES (%s, %s, %s)",
        (estudiante_id, rfid_tag, estado_registro)
    )
    conn.commit()

    cursor.close()
    conn.close()

    return jsonify({
        'idEstudiante': doc_estudiante,
        'codigoRfid': rfid_tag,
        'estadoStr': estado_registro
    })


# 2. ENDPOINT PARA OBTENER LOS ÚLTIMOS 5 REGISTROS (Para Monitoreo en Vivo en el Frontend)
@app.route('/api/ultimos-registros', methods=['GET'])
def ultimos_registros():
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)

    query = """
        SELECT DATE_FORMAT(r.fecha_hora, '%Y-%m-%d %H:%i:%s') AS fecha_hora, 
               r.rfid_tag, 
               r.estado, 
               COALESCE(e.documento, '0000') AS idEstudiante
        FROM registros_acceso r
        LEFT JOIN estudiantes e ON r.estudiante_id = e.id
        ORDER BY r.id DESC LIMIT 5
    """
    cursor.execute(query)
    registros = cursor.fetchall()

    cursor.close()
    conn.close()

    return jsonify(registros)


# 3. ENDPOINT PARA OBTENER ESTUDIANTES (Vista Estudiantes)
@app.route('/api/estudiantes', methods=['GET'])
def obtener_estudiantes():
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT nombre, carrera, rfid_tag, estado FROM estudiantes")
    estudiantes = cursor.fetchall()

    cursor.close()
    conn.close()

    return jsonify(estudiantes)


# 4. ENDPOINT PARA CONTADORES Y ESTADÍSTICAS (Aforo, Ingresos y Alertas)
@app.route('/api/stats', methods=['GET'])
def obtener_estadisticas():
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT COUNT(*) AS total FROM registros_acceso WHERE estado = 'AUTORIZADO'")
    ingresos = cursor.fetchone()['total']

    cursor.execute("SELECT COUNT(*) AS total FROM registros_acceso WHERE estado = 'DENEGADO'")
    alertas = cursor.fetchone()['total']

    cursor.close()
    conn.close()

    return jsonify({
        'aforo': ingresos,
        'ingresos': ingresos,
        'alertas': alertas
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


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)