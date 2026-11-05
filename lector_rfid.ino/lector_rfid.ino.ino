#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <MFRC522.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "secrets.h"   // WIFI_SSID, WIFI_PASSWORD y DEVICE_KEY (ver secrets.h.example)
 
// Credenciales (definidas en secrets.h, que no se sube al repositorio)
const char* ssid = WIFI_SSID;
const char* password = WIFI_PASSWORD;
const char* deviceKey = DEVICE_KEY;   // debe ser igual a DEVICE_API_KEY del servidor
 
// Endpoint del Backend en Render
const char* serverUrl = "https://sistema-fet-backend.onrender.com/api/rfid-scan";
 
// ==========================================
// DEFINICIÓN DE PINES DE CONEXIÓN
// ==========================================
#define SS_PIN    5   // Pin SDA / SS del RFID  -> P5
#define RST_PIN   27  // Pin RST del RFID       -> P27
#define SCK_PIN   18  // Pin SCK del RFID       -> P18
#define MISO_PIN  19  // Pin MISO del RFID      -> P19
#define MOSI_PIN  23  // Pin MOSI del RFID      -> R23
 
#define I2C_SDA   21  // Pin SDA de la LCD      -> P21
#define I2C_SCL   22  // Pin SCL de la LCD      -> R22
 
MFRC522 rfid(SS_PIN, RST_PIN);
LiquidCrystal_I2C lcd(0x27, 16, 2);
 
void mostrarPantallaEspera() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Sistema RFID");
  lcd.setCursor(0, 1);
  lcd.print("Acerque tarjeta");
}
 
void setup() {
  Serial.begin(115200);
  delay(1000);
 
  // Inicializar bus I2C y Pantalla LCD
  Wire.begin(I2C_SDA, I2C_SCL);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Iniciando...");
 
  // Inicializar bus SPI y Lector RFID
  SPI.begin(SCK_PIN, MISO_PIN, MOSI_PIN, SS_PIN);
  rfid.PCD_Init();
  Serial.println("Lector RFID RC522 listo.");
 
  // Conexión inicial a WiFi
  conectarWiFi();
 
  // Mostrar mensaje principal en pantalla
  mostrarPantallaEspera();
}
 
void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\n¡Conexión WiFi perdida! Intentando reconectar...");
    conectarWiFi();
    mostrarPantallaEspera();
  }
 
  // Verificar si hay una tarjeta presente
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) {
    delay(50);
    return;
  }
 
  // Convertir el UID de la tarjeta a String hexadecimal
  String tagID = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) {
      tagID += "0";
    }
    tagID += String(rfid.uid.uidByte[i], HEX);
  }
  tagID.toUpperCase();
 
  Serial.print("Tarjeta detectada con UID: ");
  Serial.println(tagID);
 
  // Mientras consulta al servidor, solo dice "Validando..." (NUNCA "Bienvenido")
  lcd.clear();
  lcd.setCursor(2, 0);
  lcd.print("Validando...");
 
  // Consultar el servidor y mostrar el resultado real
  enviarYMostrarRespuesta(tagID);
 
  // Detener la lectura de la tarjeta actual
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
 
  delay(3000); // Mantiene el resultado 3 segundos en pantalla
  mostrarPantallaEspera();
}
 
void conectarWiFi() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Conectando WiFi");
 
  WiFi.begin(ssid, password);
  int intentos = 0;
 
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    intentos++;
 
    if (intentos > 20) {
      Serial.println("\nNo se pudo conectar. Reintentando de nuevo...");
      WiFi.disconnect();
      WiFi.begin(ssid, password);
      intentos = 0;
    }
  }
 
  Serial.println("\nConexión WiFi establecida exitosamente!");
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("WiFi Conectado!");
  delay(1000);
}
 
void enviarYMostrarRespuesta(String uid) {
  int maxIntentos = 3;
  int intentoActual = 0;
  bool enviadoExitoso = false;
 
  while (intentoActual < maxIntentos && !enviadoExitoso) {
    intentoActual++;
 
    WiFiClientSecure client;
    client.setInsecure();   // Limitación conocida: no verifica el certificado TLS del servidor
 
    HTTPClient http;
    http.begin(client, serverUrl);
    http.setTimeout(25000);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Key", deviceKey);   // identifica a este lector ante el servidor
 
    StaticJsonDocument<200> doc;
    doc["rfid_tag"] = uid;
 
    String jsonOutput;
    serializeJson(doc, jsonOutput);
 
    int httpResponseCode = http.POST(jsonOutput);
 
    if (httpResponseCode > 0) {
      String response = http.getString();
      Serial.print("Respuesta HTTP del servidor [");
      Serial.print(httpResponseCode);
      Serial.println("]:");
      Serial.println(response);
 
      if (httpResponseCode == 401) {
        // Clave del lector rechazada: reintentar no sirve
        lcd.clear();
        lcd.setCursor(0, 0);
        lcd.print("Lector sin clave");
        lcd.setCursor(0, 1);
        lcd.print("Revise DEVICE_KEY");
        enviadoExitoso = true;
        http.end();
        break;
      }
 
      StaticJsonDocument<512> respDoc;
      DeserializationError error = deserializeJson(respDoc, response);
 
      if (!error && httpResponseCode == 200) {
        String estado = respDoc["estadoStr"] | "DENEGADO";
        String nombre = respDoc["nombre"] | "";
 
        if (nombre == "" || nombre == "No registrado") {
          String docId = respDoc["idEstudiante"] | "0000";
          nombre = "ID: " + docId;   // el servidor ya envía el documento enmascarado
        }
 
        lcd.clear(); // Limpia toda la pantalla antes de mostrar el resultado
 
        if (estado == "INGRESO" || estado == "AUTORIZADO") {   // AUTORIZADO: servidores antiguos
          lcd.setCursor(3, 0);
          lcd.print("Bienvenido");
          lcd.setCursor(0, 1);
          lcd.print(nombre.substring(0, 16));
        }
        else if (estado == "SALIDA") {
          lcd.setCursor(5, 0);
          lcd.print("Salida");
          lcd.setCursor(0, 1);
          lcd.print(nombre.substring(0, 16));
        }
        else {
          // Si estadoStr es "DENEGADO" (tarjeta inactiva o no registrada)
          lcd.setCursor(0, 0);
          lcd.print("Acceso Denegado");
        }
      } else {
        lcd.clear();
        lcd.setCursor(0, 0);
        lcd.print("Error servidor");
        lcd.setCursor(0, 1);
        lcd.print("Codigo: " + String(httpResponseCode));
      }
 
      enviadoExitoso = true;
    } else {
      Serial.print("Fallo en la petición. Código de error: ");
      Serial.println(httpResponseCode);
      delay(2000);
    }
 
    http.end();
  }
 
  if (!enviadoExitoso) {
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("Error de Red");
    lcd.setCursor(0, 1);
    lcd.print("Intente de nuevo");
  }
}