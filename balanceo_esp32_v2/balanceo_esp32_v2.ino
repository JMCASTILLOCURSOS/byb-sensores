// BALANCEO DINAMICO v2 - ESP32 + 1 o 2 x GY-521 (MPU6050) + TCRT5000
// Libreria: "WebSockets" (links2004). WiFi: red "BALANCEO" / clave "12345678" -> ws://192.168.4.1:81
// Cableado: SDA=16, SCL=17, VCC=3.3V. Sensor Plano 1: AD0->GND (0x68). Sensor Plano 2 (opcional): AD0->3.3V (0x69)
// TCRT5000 DO -> GPIO15, cinta reflectante en el eje = Punto 1 (0 grados)
// Si solo conecta 1 sensor, la app pide mover el sensor entre cojinetes.
//
// DIAGNOSTICO EN TERRENO:
//   1) Monitor Serie a 115200 baudios: imprime sensores, RPM y vibracion en vivo.
//   2) El equipo manda ademas el estado por websocket en el campo "st" y la app
//      lo muestra en una franja de la pantalla (roja = error, amarilla = aviso).
#include <WiFi.h>
#include <Wire.h>
#include <WebSocketsServer.h>
#define TACH_PIN 15        // GPIO15 - Tachometro (ESP32-S3)
#define AXIS_REG 0x3B      // 0x3B=X, 0x3D=Y, 0x3F=Z (eje radial) (ESP32-S3)
#define I2C_SDA 16         // GPIO16 - I2C SDA (RTC/USB_D+) (ESP32-S3)
#define I2C_SCL 17         // GPIO17 - I2C SCL (RTC/USB_D-) (ESP32-S3)
#define REVS_AVG 10
#define FS_US 1000
#define EST_MS 3000        // reenvio del estado aunque no cambie (ms)
#define EST_TACH_MS 3000   // sin pulsos durante esto -> aviso de tacometro
WebSocketsServer ws(81);
const uint8_t ADDR[2] = {0x68, 0x69};
uint8_t ACT[2] = {0, 1};   // indices de ADDR que realmente estan conectados
int ns = 0;                // cuantos sensores hay (1 o 2)
volatile uint32_t tPulse = 0, tPrev = 0; volatile bool newPulse = false;
void IRAM_ATTR onTach() { uint32_t t = micros(); if (t - tPulse < 5000) return; tPrev = tPulse; tPulse = t; newPulse = true; }
void wr(uint8_t a, uint8_t r, uint8_t v) { Wire.beginTransmission(a); Wire.write(r); Wire.write(v); Wire.endTransmission(); }
bool present(uint8_t a) { Wire.beginTransmission(a); return Wire.endTransmission() == 0; }
bool readAx(uint8_t a, int16_t &v) {
  Wire.beginTransmission(a); Wire.write(AXIS_REG);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(a, (uint8_t)2) != 2) return false;
  int h = Wire.read(), l = Wire.read();
  if (h < 0 || l < 0) return false;
  v = (int16_t)((h << 8) | l); return true;
}
double sc[2], ss[2]; float dc[2]; int n = 0, revs = 0; uint32_t lastS = 0, lastPulseSeen = 0;
uint16_t fallos[2] = {0, 0};        // lecturas I2C fallidas seguidas por sensor
char estTxt[240] = "Iniciando el equipo..."; uint8_t estCode = 0; uint32_t lastEst = 0;

void reiniciarMuestreo() { for (int i = 0; i < 2; i++) sc[i] = ss[i] = 0; n = 0; revs = 0; }

void setup() {
  Serial.begin(115200); delay(150);
  Serial.println(); Serial.println(F("=== DINAMIC BYB - ESP32 ==="));
  Wire.begin(I2C_SDA, I2C_SCL); Wire.setClock(400000);
  for (int i = 0; i < 2; i++) {
    if (present(ADDR[i])) {
      wr(ADDR[i], 0x6B, 0); wr(ADDR[i], 0x1A, 1); wr(ADDR[i], 0x1C, 0);
      ACT[ns++] = i;
      Serial.printf("  MPU-6050 en 0x%02X ....... detectado y configurado\n", ADDR[i]);
    } else {
      Serial.printf("  MPU-6050 en 0x%02X ....... NO DETECTADO\n", ADDR[i]);
    }
  }
  Serial.printf("  Tacometro ............... GPIO%d\n", TACH_PIN);
  Serial.printf("  Eje medido .............. 0x%02X\n", AXIS_REG);
  pinMode(TACH_PIN, INPUT); attachInterrupt(TACH_PIN, onTach, RISING);
  bool ap = WiFi.softAP("BALANCEO", "12345678");
  Serial.printf("  WiFi %s ........... red \"BALANCEO\" clave \"12345678\"\n", ap ? "OK" : "FALLO");
  ws.begin();
  Serial.println(F("  WebSocket ............... ws://192.168.4.1:81"));
  if (ns == 0) {
    Serial.println(F("  ! ERROR: no hay NINGUN sensor. Revise SDA=21, SCL=22, VCC=3.3V."));
    Serial.println(F("    GY-521: los pines SDA/SCL llevan resistencia pull-up; pruebe con cable corto."));
  } else if (ns == 1) {
    Serial.println(F("  Listo para 1 plano. Para 2 planos conecte el segundo sensor en 0x69 (AD0 a 3.3V)."));
  } else {
    Serial.println(F("  Listo para 2 planos."));
  }
  Serial.println(F("================================"));
}

const char* armarEstado(uint8_t &cod) {
  bool conTacho = (lastPulseSeen != 0) && (micros() - lastPulseSeen <= EST_TACH_MS * 1000UL);
  if (ns == 0) { cod = 1; return "ERROR: no se detecto el sensor MPU-6050 (ni 0x68 ni 0x69). Revise SDA=21, SCL=22, VCC=3.3V y el cableado."; }
  if ((ns > 0 && fallos[0] >= 200) || (ns > 1 && fallos[1] >= 200)) { cod = 2; return "ERROR: el sensor dejo de responder por I2C. Revise el cable; si sigue, reinicie el equipo."; }
  if (!conTacho) { cod = 3; return "AVISO: sin pulsos del tacometro (GPIO27). Gire el rotor con la cinta reflectante frente al sensor."; }
  if (ns >= 2) { cod = 5; return "OK: 2 sensores MPU-6050 (0x68 y 0x69) y tacometro funcionando."; }
  cod = 4; return "OK: 1 sensor MPU-6050 (0x68) y tacometro funcionando. Para 2 planos conecte el segundo sensor en 0x69.";
}

void revisarEstado() {
  uint8_t cod; const char* t = armarEstado(cod);
  uint32_t m = millis();
  if (cod == estCode && m - lastEst < EST_MS) return;
  estCode = cod; lastEst = m;
  snprintf(estTxt, sizeof estTxt, "%s", t);
  char b[300]; snprintf(b, sizeof b, "{\"st\":\"%s\"}", estTxt);
  ws.broadcastTXT(b);
  Serial.println(estTxt);
}

void loop() {
  ws.loop(); uint32_t now = micros();
  revisarEstado();
  if (now - lastPulseSeen > 2000000UL) { static uint32_t lm = 0; if (millis() - lm > 1000) { ws.broadcastTXT("{\"rpm\":0}"); lm = millis(); } }
  if (now - lastS >= FS_US && ns > 0) {
    lastS = now; uint32_t tp = tPulse, per = tp - tPrev;
    if (tPrev == 0 || per < 8000 || per > 2000000UL) {
      // sin una vuelta de referencia confiable no se acumula nada
      // (tambien descarta lo viejo si el rotor se detuvo o se acelero a fondo)
      if (n > 0 || revs > 0) reiniciarMuestreo();
    } else {
      double th = 2.0 * PI * (double)(now - tp) / per; if (th > 2 * PI) th = 2 * PI;
      for (int i = 0; i < ns; i++) {
        int16_t raw;
        if (!readAx(ACT[i], raw)) { if (fallos[i] < 1000) fallos[i]++; continue; }
        fallos[i] = 0;
        float a = raw / 16384.0f;
        dc[i] += 0.001f * (a - dc[i]); a -= dc[i];
        sc[i] += a * cos(th); ss[i] += a * sin(th);
      }
      n++;
    }
  }
  if (newPulse) {
    newPulse = false; lastPulseSeen = micros();
    if (++revs >= REVS_AVG) {
      double f = 1e6 / (double)(tPulse - tPrev);
      if (n > 20) {
        char b[160]; int k = snprintf(b, sizeof b, "{\"rpm\":%.1f", f * 60);
        Serial.printf("RPM %6.1f", f * 60);
        for (int i = 0; i < ns; i++) {
          double A = 2.0 * sqrt(sc[i] * sc[i] + ss[i] * ss[i]) / n, ph = atan2(ss[i], sc[i]) * 180.0 / PI; if (ph < 0) ph += 360;
          k += snprintf(b + k, sizeof b - k, ",\"v%d\":%.3f,\"ph%d\":%.1f", i + 1, A * 9806.65 / (2 * PI * f), i + 1, ph);
          Serial.printf(" | P%d %5.3f mm/s @ %5.1f gr", i + 1, A * 9806.65 / (2 * PI * f), ph);
        }
        snprintf(b + k, sizeof b - k, "}"); ws.broadcastTXT(b);
        Serial.println();
      }
      for (int i = 0; i < 2; i++) sc[i] = ss[i] = 0; n = 0; revs = 0;
    }
  }
}
