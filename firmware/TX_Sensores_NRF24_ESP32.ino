// ============================================================
//  BYB-NORTE — EMISOR (ESP32-C3 Super Mini, SIN pantalla)
//  Lee 4x PT100 (MAX31865 3 hilos) + RPM (infrarrojo TCRT5000)
//  y envia por NRF24L01+PA+LNA al receptor.
// ============================================================
// LIBRERIAS: RF24 (TMRh20), Adafruit MAX31865
//
// PLACA IDE: ESP32C3 Dev Module, USB CDC On Boot: ENABLED
//   (el C3 Super Mini no trae CH340; el Serial sale por USB nativo)
//
// CONEXIONES ESP32-C3 Super Mini (pines seguros, sin strapping):
//   SPI: SCK=6 | MOSI=7 | MISO=4
//   MAX CS: S1=0 | S2=1 | S3=3 | S4=10
//   NRF24: CE=20 | CSN=21 | VCC=3V3 (NO 5V) | GND=GND | IRQ=NC
//   TCRT5000 D0 (RPM, interrupcion): 5 | VCC=3V3/5V | GND=GND
//   NRF24 y PT100 con 3.3V + capacitor 10-100uF en VCC/GND del NRF.
//
// CAMBIOS v2 (revision):
//   - Serial.setTxTimeoutMs(0): con "USB CDC On Boot" y SIN PC conectado
//     (como en terreno) cada Serial.print podia bloquear el loop ~100 ms.
//   - RPM por PERIODO entre pulsos (antes: conteo en 1 s = resolucion de
//     ~60 RPM por pulso) + anti-rebote en la interrupcion.
//   - RPM baja a 0 inmediatamente al detenerse el equipo (antes tardaba
//     5 s por el promedio).
// ============================================================

#include <Arduino.h>

// ESP32-C3 Super Mini: no tiene chip USB-serie; el Serial sale por USB nativo.
// Con "USB CDC On Boot" desactivado, Serial usa GPIO20/21 (UART0).
#if !ARDUINO_USB_CDC_ON_BOOT
#warning "Activa Herramientas > USB CDC On Boot > Enabled (placa ESP32C3 Dev Module)"
#endif
#include <SPI.h>
#include <RF24.h>
#include <Adafruit_MAX31865.h>

// ── PINES ────────────────────────────────────────────────────
#define SPI_SCK  6
#define SPI_MOSI 7
#define SPI_MISO 4

#define CS_S1 0
#define CS_S2 1
#define CS_S3 3
#define CS_S4 10

#define NRF_CE  20
#define NRF_CSN 21

#define PIN_RPM 5
#define PULSOS_POR_VUELTA 1

// ── PT100 ────────────────────────────────────────────────────
#define PT100_WIRES MAX31865_3WIRE
#define RREF        430.0
#define RNOMINAL    100.0

// SPI por HARDWARE (constructor solo con CS)
Adafruit_MAX31865 sensor1 = Adafruit_MAX31865(CS_S1);
Adafruit_MAX31865 sensor2 = Adafruit_MAX31865(CS_S2);
Adafruit_MAX31865 sensor3 = Adafruit_MAX31865(CS_S3);
Adafruit_MAX31865 sensor4 = Adafruit_MAX31865(CS_S4);
Adafruit_MAX31865 *sensores[4] = { &sensor1, &sensor2, &sensor3, &sensor4 };

RF24 radio(NRF_CE, NRF_CSN);
const byte DIRECCION_RADIO[6] = "BYB01";

struct PaqueteDatos {
  float s1;
  float s2;
  float s3;
  float s4;
  float rpm;
};
PaqueteDatos paquete;

const unsigned long SEND_INTERVAL = 1000;
unsigned long lastSend = 0;
float acc[4] = {0, 0, 0, 0};
int   cnt[4] = {0, 0, 0, 0};
uint8_t sensorTurno = 0;

// ── RPM (medicion por periodo entre pulsos) ─────────────────
#define RPM_MIN_PULSO_US 2000UL   // anti-rebote: ignora pulsos separados < 2 ms
#define RPM_AVG_N 3
volatile uint32_t isrCuenta = 0, isrPrimero = 0, isrUltimo = 0;
float rpmHist[RPM_AVG_N] = {0, 0, 0};
uint8_t rpmHistIdx = 0;
float rpmUltimo = 0;

void IRAM_ATTR isrRPM() {
  uint32_t t = micros();
  if (isrCuenta > 0 && (uint32_t)(t - isrUltimo) < RPM_MIN_PULSO_US) return;
  if (isrCuenta == 0) isrPrimero = t;
  isrUltimo = t;
  isrCuenta++;
}

float readPT100(Adafruit_MAX31865 &s) {
  float t = s.temperature(RNOMINAL, RREF);
  uint8_t fault = s.readFault();
  if (fault) {
    s.clearFault();
    return -999.0;
  }
  return t;
}

float promediarRPM(float nuevo) {
  if (nuevo <= 0) {                      // equipo detenido: sin arrastre
    for (uint8_t i = 0; i < RPM_AVG_N; i++) rpmHist[i] = 0;
    return 0;
  }
  rpmHist[rpmHistIdx] = nuevo;
  rpmHistIdx = (rpmHistIdx + 1) % RPM_AVG_N;
  float suma = 0;
  for (uint8_t i = 0; i < RPM_AVG_N; i++) suma += rpmHist[i];
  return suma / RPM_AVG_N;
}

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);   // no bloquear si no hay PC conectado (si tu core no lo reconoce, borra esta linea)
  delay(300);

  SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI);
  pinMode(CS_S1, OUTPUT); digitalWrite(CS_S1, HIGH);
  pinMode(CS_S2, OUTPUT); digitalWrite(CS_S2, HIGH);
  pinMode(CS_S3, OUTPUT); digitalWrite(CS_S3, HIGH);
  pinMode(CS_S4, OUTPUT); digitalWrite(CS_S4, HIGH);
  sensor1.begin(PT100_WIRES);
  sensor2.begin(PT100_WIRES);
  sensor3.begin(PT100_WIRES);
  sensor4.begin(PT100_WIRES);

  pinMode(PIN_RPM, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_RPM), isrRPM, FALLING);

  if (!radio.begin(&SPI)) {   // mismo bus SPI (pines 6/7/4) que los MAX31865
    Serial.println(F("ERROR: RADIO NO DETECTADO"));
    while (1) delay(100);
  }
  if (!radio.isChipConnected()) {
    Serial.println(F("ERROR: NRF24 NO CONECTADO (revisa cableado, 3V3 y capacitor)"));
    while (1) delay(100);
  }
  radio.setPALevel(RF24_PA_LOW);
  radio.setDataRate(RF24_250KBPS);
  radio.setChannel(90);
  radio.setRetries(5, 15);
  radio.openWritingPipe(DIRECCION_RADIO);
  radio.stopListening();

  Serial.println(F("TX listo (ESP32-C3): PT100 x4 + RPM -> NRF24"));
}

void loop() {
  float t = readPT100(*sensores[sensorTurno]);
  if (t > -900.0) { acc[sensorTurno] += t; cnt[sensorTurno]++; }
  sensorTurno = (sensorTurno + 1) % 4;

  unsigned long now = millis();

  if (now - lastSend >= SEND_INTERVAL) {
    lastSend = now;

    paquete.s1 = (cnt[0] > 0) ? (acc[0] / cnt[0]) : -999.0;
    paquete.s2 = (cnt[1] > 0) ? (acc[1] / cnt[1]) : -999.0;
    paquete.s3 = (cnt[2] > 0) ? (acc[2] / cnt[2]) : -999.0;
    paquete.s4 = (cnt[3] > 0) ? (acc[3] / cnt[3]) : -999.0;

    noInterrupts();
    uint32_t c = isrCuenta, f = isrPrimero, l = isrUltimo;
    isrCuenta = 0;
    interrupts();

    float rpmInst = 0;
    if (c >= 2 && l != f) {
      rpmInst = ((c - 1) * 60000000.0f) / ((float)(uint32_t)(l - f) * PULSOS_POR_VUELTA);
      rpmUltimo = rpmInst;
    } else if (c == 1) {
      rpmInst = rpmUltimo;               // 1 solo pulso en la ventana: mantiene el valor
    } else {
      rpmUltimo = 0;                     // sin pulsos: detenido
    }
    paquete.rpm = promediarRPM(rpmInst);

    bool ok = radio.write(&paquete, sizeof(paquete));

    Serial.print(F("Envio "));
    Serial.print(ok ? F("OK") : F("FALLO"));
    Serial.print(F(" | S1=")); Serial.print(paquete.s1);
    Serial.print(F(" S2=")); Serial.print(paquete.s2);
    Serial.print(F(" S3=")); Serial.print(paquete.s3);
    Serial.print(F(" S4=")); Serial.print(paquete.s4);
    Serial.print(F(" RPM=")); Serial.println(paquete.rpm);

    for (uint8_t i = 0; i < 4; i++) { acc[i] = 0; cnt[i] = 0; }
  }

  delay(5);
}
